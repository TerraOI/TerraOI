import { Answer, type Answer as AnswerValue } from "@/contracts/answer";
import type { DataClass } from "@/contracts/data-class";
import type { ChatRequest, ProgressEvent } from "@/contracts/chat";
import type { TenantContext } from "@/contracts/tenant-context";
import { composeAnswer, type ComposeAudit, type EvidencePackEntry } from "@/platform/agents/compose";

import type { ChatFrame } from "./envelope";
import type { ChatRefusalKey, CorpusSearch, ExpertGrant, GatewayBundle, RetrievalOutcome } from "./deps";
import { QUESTION_DATA_CLASS } from "./deps";
import { composePolicy, instructionFor, resolveExpertAccess, type ExpertAccess } from "./experts";
import { CHAT_RPCS, type ChatStore, type StoreFailure } from "./store";

/**
 * One chat turn, end to end: **authorize → persist → retrieve → compose → verify → persist →
 * deliver** (plan §9.1, and the order is the rule, not a preference).
 *
 * The two ordering facts the packet exists to prove are visible here:
 *
 * - **Nothing factual is delivered before it is persisted and re-authorized** (F22, §9.3, TOI-ADR-07).
 *   The only frame emitted before `chat_complete_run_v1` returns is a `ProgressEvent`; the answer
 *   frame carries `persisted: true` only when that write succeeded, and `stream.ts` refuses to encode
 *   claims in a frame that does not. The gateway's own `onProgress` is forwarded here, so even a
 *   provider-side chain change reaches the employee as a typed event and never as text
 *   (`contracts/chat.ts:69-78`: chain positions, closed reason enum, no provider names).
 * - **Retrieval runs at the ceiling the tenant grants** (T-114's job, this packet's seam): the packs
 *   this function hands the model are the ones the search port says this caller may read, and the
 *   database independently refuses any cited `source_version_id` it cannot re-authorize
 *   (`chat_complete_run_v1`, pgTAP 035 tests 43-48). A model that invents a citation cannot make it
 *   durable.
 *
 * Refusal statuses are persisted as answers, not swallowed: a `refused` run is an audited fact
 * (plan §9.4, T-214's later outcome table). And where the *store* refuses, this function stops:
 * an answer we are not allowed to write is not an answer we are allowed to say.
 *
 * `audit` (which provider, which chain position, what binding rejected) is returned to the caller for
 * logging and is never part of any frame — §9.3 and §8.2 keep infrastructure names out of an
 * employee-visible stream, and `Answer` cannot represent them anyway.
 */

export interface ChatRunDeps {
  store: ChatStore;
  search: CorpusSearch;
  gateway: GatewayBundle | null;
  /** Emission is push-based so a progress frame reaches the client while the run is still working. */
  emit: (frame: ChatFrame) => void;
  /** Injectable so a test and the audit agree on when something happened. */
  now?: () => Date;
  /** The catalog read (T-102c's `expert_grants` when it exists). */
  grants: (context: TenantContext) => Promise<readonly ExpertGrant[]>;
}

export type ChatRunOutcome =
  /** A frame was delivered; `persisted` says the durable write behind it succeeded. */
  | { kind: "delivered"; runId: string; status: AnswerValue["status"]; persisted: boolean; audit: ComposeAudit | null }
  /** The run stopped at a database answer, before or without an answer frame. */
  | { kind: "store_failure"; stage: ChatStoreStage; failure: StoreFailure; detail: string; runId: string | null }
  /** The employee may not use this expert, or narrowed to a project they may not use. */
  | { kind: "not_permitted"; key: Extract<ChatRefusalKey, "expert_not_permitted" | "out_of_scope"> };

export type ChatStoreStage = "conversation" | "question" | "run" | "resume" | "complete";

function iso(now: () => Date): string {
  return now().toISOString();
}

/**
 * An answer frame whose text is one of the expert's own templates. It carries no claims, so it says
 * nothing factual about the corpus, which is what makes it deliverable even on the paths where the
 * durable write failed (`stream.ts`'s gate).
 */
function templateAnswer(
  expertKey: string,
  expertVersion: string,
  runId: string,
  status: "refused" | "unavailable",
  summary: string,
  dataClass: DataClass,
  corpusGenerations: number[],
  asOf: string,
): AnswerValue {
  return Answer.parse({
    status,
    runId,
    expertVersions: [`${expertKey}@${expertVersion}`],
    corpusGenerations,
    asOf,
    summary,
    dataClass,
    claims: [],
    // An empty list would mean "we checked and there is nothing unknown" (contracts/answer.ts:130),
    // which is a claim about coverage this path cannot make.
    unknowns:
      status === "refused"
        ? ["Nothing in the corpus this caller may read answers this question."]
        : ["The assistant could not produce an answer for this question right now."],
    conflicts: [],
    truncation: [],
  });
}

function progress(
  type: ProgressEvent["type"],
  _context: TenantContext,
  runId: string,
  conversationId: string,
  emittedAt: string,
  extra: Record<string, unknown> = {},
): ChatFrame {
  // Built here, never parsed from anything the client or the model said, and every field that could
  // name a provider or a record is absent from `extra` by construction at the call sites below.
  return { kind: "progress", event: { type, runId, conversationId, emittedAt, ...extra } as ProgressEvent };
}

export async function runChat(
  input: { context: TenantContext; request: ChatRequest },
  deps: ChatRunDeps,
): Promise<ChatRunOutcome> {
  const { context, request } = input;
  const now = deps.now ?? (() => new Date());
  const questionDataClass: DataClass = QUESTION_DATA_CLASS;

  // 1. Authorize the expert and the narrowing, before a row is written or a token is spent (F08).
  const access: ExpertAccess = await resolveExpertAccess({
    context,
    expertKey: request.expertKey,
    projectId: request.projectId ?? null,
    catalog: { grants: deps.grants },
  });
  if (!access.ok) return { kind: "not_permitted", key: access.key };
  const { expert, serviceKey, projectId } = access;
  const policy = composePolicy(expert);

  // 2. The conversation row. A new id is the caller's, and the RPC pins it to this tenant and this
  //    user on insert, so a replayed id from another employee is refused rather than adopted.
  const conversation = await deps.store.ensureConversation(context, {
    conversationId: request.conversationId,
    expertKey: expert.key,
    projectId,
  });
  if (!conversation.ok) {
    return { kind: "store_failure", stage: "conversation", failure: conversation.kind, detail: conversation.detail, runId: null };
  }
  const conversationId = conversation.value;

  // 3. The question becomes server state first: history comes from the database, never from the
  //    transcript the browser posts (F17), and the retry path needs a row to be idempotent against.
  const question = await deps.store.appendUserMessage(context, {
    conversationId,
    clientMessageId: request.clientMessageId,
    bodyText: request.message.text,
    dataClass: questionDataClass,
  });
  if (!question.ok) {
    return { kind: "store_failure", stage: "question", failure: question.kind, detail: question.detail, runId: null };
  }
  const userMessageId = question.value;

  // 4. Start (or find) the run. The id is generated here, but `unique (organisation_id,
  //    idempotency_key)` means a duplicate submit hands back the **existing** run id, and the read
  //    that follows is what makes "the same expensive question was not run twice" an assertion.
  const runId = crypto.randomUUID();
  const started = await deps.store.startRun(context, {
    runId,
    conversationId,
    idempotencyKey: request.idempotencyKey,
    expertKey: expert.key,
    userMessageId,
    dataClass: questionDataClass,
  });
  if (!started.ok) {
    return { kind: "store_failure", stage: "run", failure: started.kind, detail: started.detail, runId };
  }
  const run = started.value;

  const existing = await deps.store.getRun(context, { runId: run });
  if (!existing.ok) {
    return { kind: "store_failure", stage: "resume", failure: existing.kind, detail: existing.detail, runId: run };
  }
  if (existing.value.answer !== null) {
    // Duplicate submit or a reload after a disconnect: the stored answer is the answer. Zero retrieval
    // and zero model calls, which `run-chat.test.ts` asserts on the adapter's own call list (§9.2).
    deps.emit({ kind: "answer", answer: existing.value.answer, persisted: true });
    return { kind: "delivered", runId: run, status: existing.value.answer.status, persisted: true, audit: null };
  }

  // 5. Progress, and only progress. The employee picked this expert, so the routing suggestion the
  //    contract allows is reported at certainty rather than guessed (F29, contracts/chat.ts:50-56).
  deps.emit(progress("routing", context, run, conversationId, iso(now), { expertKey: expert.key, confidence: 1 }));
  deps.emit(progress("searching", context, run, conversationId, iso(now)));

  // 6. Retrieval through T-114's seam. An un-wired seam returns no packs (deps.ts), which lands in
  //    the same `refused` outcome as a corpus that genuinely cannot answer — a degraded lane is
  //    labelled, never quietly taken (§8.1).
  const retrieval: RetrievalOutcome = await deps.search.search({
    context,
    question: request.message.text,
    serviceKey,
    projectId,
  });
  const packs: readonly EvidencePackEntry[] = retrieval.packs;
  if (packs.length === 0 && (retrieval.mode === "lexical_only" || retrieval.diagnostics !== "ok")) {
    deps.emit(progress("searching", context, run, conversationId, iso(now), { retrievalMode: "lexical_only" }));
  }

  let answer: AnswerValue;
  let audit: ComposeAudit | null = null;

  if (packs.length === 0) {
    // No evidence: no model is dialled at all. `composeAnswer` makes exactly this choice
    // (compose.ts:247-258) and uses the expert's own `no_evidence` template; the text is therefore
    // the expert's in both cases, and this branch exists so an unwired gateway is never needed to
    // say "nothing here answers this".
    answer = templateAnswer(
      expert.key,
      expert.version,
      run,
      "refused",
      policy.refusalTemplates.no_evidence,
      questionDataClass,
      retrieval.corpusGenerations,
      iso(now),
    );
  } else if (deps.gateway === null) {
    // Evidence exists but no gateway is bound. Calling a provider from here is forbidden outright
    // (AGENTS.md §4.3), so the honest answer is that the assistant is unavailable — with the
    // retrieval facts kept in the run row.
    answer = templateAnswer(
      expert.key,
      expert.version,
      run,
      "unavailable",
      policy.refusalTemplates.unavailable,
      questionDataClass,
      retrieval.corpusGenerations,
      iso(now),
    );
  } else {
    try {
      const composed = await composeAnswer(
        {
          context,
          runId: run,
          conversationId,
          question: request.message.text,
          questionDataClass,
          evidence: packs,
          expert: policy,
          corpusGenerations: retrieval.corpusGenerations,
          instruction: instructionFor(expert),
          asOf: iso(now),
        },
        {
          config: deps.gateway.config,
          adapters: deps.gateway.adapters,
          health: deps.gateway.health,
          meter: deps.gateway.meter,
          // The gateway's chain events become the employee's `tier_changed` frames; the gateway
          // already excludes provider and model identity from them (contracts/chat.ts:59-78).
          onProgress: (event: ProgressEvent) => deps.emit({ kind: "progress", event }),
        },
      );
      answer = composed.answer;
      audit = composed.audit;
    } catch {
      // A throw out of the pipeline is a fault in our own code or in the meter, never a licence to
      // deliver whatever was in flight: the composed candidate stays undelivered (F22).
      answer = templateAnswer(
        expert.key,
        expert.version,
        run,
        "unavailable",
        policy.refusalTemplates.unavailable,
        questionDataClass,
        retrieval.corpusGenerations,
        iso(now),
      );
    }
  }

  // 7. Persist, and only then deliver. `chat_complete_run_v1` is the re-authorization gate: it
  //    re-reads every cited source in this tenant, refuses a citation it cannot make readable
  //    (42501), and recomputes the data class as the highest among the sources it actually saw
  //    (pgTAP 035 tests 14-48). A refusal there is a withheld answer, not a delivered one.
  deps.emit(progress("verifying", context, run, conversationId, iso(now)));
  const completed = await deps.store.completeRun(context, { runId: run, answer });
  if (!completed.ok) {
    // Withheld. The composed text never reaches the employee; what is emitted is a claim-free
    // template answer, and the run stays `running` in the database for a later sweep (T-214).
    const withheld = templateAnswer(
      expert.key,
      expert.version,
      run,
      "unavailable",
      policy.refusalTemplates.unavailable,
      answer.dataClass,
      retrieval.corpusGenerations,
      iso(now),
    );
    deps.emit({ kind: "answer", answer: withheld, persisted: false });
    return { kind: "store_failure", stage: "complete", failure: completed.kind, detail: completed.detail, runId: run };
  }

  // The delivered copy carries the class the **database** stored, so what the employee sees and what
  // the audit row says cannot disagree (§6.2, plan §9.1: the class is stored, not recomputed at read).
  const delivered: AnswerValue = { ...answer, dataClass: completed.value.dataClass };
  deps.emit({ kind: "answer", answer: delivered, persisted: true });
  return { kind: "delivered", runId: run, status: delivered.status, persisted: true, audit };
}

/** The RPC names this function may dial — exported so the test can assert the set, not a guess. */
export const CHAT_RUN_RPCS: readonly string[] = Object.values(CHAT_RPCS);
