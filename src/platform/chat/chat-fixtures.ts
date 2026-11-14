import type { TenantContext } from "@/contracts/tenant-context";
import { createTenantContext } from "@/contracts/tenant-context";
import type { Answer } from "@/contracts/answer";
import type { DataClass } from "@/contracts/data-class";
import type { GatewayConfiguration } from "@/platform/gateway/config";
import type { MeterPort } from "@/platform/gateway/call";
import type { ProviderKey } from "@/contracts/keys";
import type { ProviderAdapter } from "@/platform/gateway/adapters";
import { CircuitBook } from "@/platform/gateway/circuit";
import {
  FULL_COMPOSE_CHAIN,
  M1_ENDPOINTS,
  fakeAdapter,
  recordingMeter,
  registryOf,
  testConfiguration,
} from "@/platform/gateway/gateway-fixtures";

import type { ChatFrame } from "./envelope";
import type {
  ChatStore,
  ConversationHistory,
  StoredRun,
  StoreResult,
} from "./store";
import type { CorpusSearch, ExpertCatalog, GatewayBundle, RetrievalOutcome } from "./deps";

/**
 * Synthetic fixtures for the chat packet's own tests (AGENTS.md §4.7). These are invented ids and
 * invented prose, not Company1 content, and no credential appears anywhere in this file — the
 * "token" below is a shape-only stand-in in the same style as `tenant-rpc.loopback.test.ts`'s canary.
 *
 * `gateway-fixtures.ts` is imported here rather than re-implemented: it is a non-test module of the
 * gateway packet that its own docs say other packets' tests may use, and a chat caller has to prove
 * it drives the *real* routing and metering, not a sketch of it.
 */

export const ORG_COMPANY1 = "11111111-1111-4111-8111-111111111111";
export const ORG_COMPANY2 = "22222222-2222-4222-8222-222222222222";
export const USER_A2 = "00000000-0000-4000-8000-0000000000a2";
export const USER_B1 = "00000000-0000-4000-8000-0000000000b1";
export const PROJECT_SITE_A = "41000000-0000-4000-8000-000000000001";
export const CONVERSATION_ID = "4a000000-0000-4000-8000-000000000001";
export const RUN_ID = "4b000000-0000-4000-8000-000000000001";
export const SOURCE_VERSION_PUBLIC = "71000000-0000-4000-8000-000000000001";
export const SOURCE_VERSION_CONFIDENTIAL = "71000000-0000-4000-8000-000000000002";
export const CHUNK_ONE = "81000000-0000-4000-8000-000000000001";
export const CHUNK_FOUR = "81000000-0000-4000-8000-000000000004";
export const USER_ACCESS_TOKEN = "synthetic-user-access-token-shape-only";

export function contextFor(overrides: Partial<TenantContext> = {}): TenantContext {
  return createTenantContext({
    organisationId: ORG_COMPANY1,
    host: "company1.terraoi.app",
    userId: USER_A2,
    membershipId: "6a000000-0000-4000-8000-000000000001",
    membershipStatus: "active",
    roles: ["member"],
    // The seeded service registry is not built yet, so a production read gives an empty list and the
    // chat surface refuses. A test that wants an allowed expert says which service it may use.
    permittedServiceKeys: ["uav-compliance"],
    permittedProjectIds: [PROJECT_SITE_A],
    policyRevision: 1,
    resolvedAt: "2026-11-13T09:00:00.000Z",
    ...overrides,
  });
}

/** A `refused` answer of the shape the compose packet produces, for the paths that never call a model. */
export function refusedAnswer(runId: string, summary: string, dataClass: DataClass = "internal"): Answer {
  return {
    status: "refused",
    runId,
    expertVersions: ["synthetic-expert-v1"],
    corpusGenerations: [],
    asOf: "2026-11-13T09:00:00.000Z",
    summary,
    dataClass,
    claims: [],
    unknowns: ["Nothing in the corpus you may read answers this."],
    conflicts: [],
    truncation: [],
  };
}

export function answeredFixture(runId: string, dataClass: DataClass = "client_confidential"): Answer {
  return {
    status: "answered",
    runId,
    expertVersions: ["synthetic-expert-v1"],
    corpusGenerations: [1],
    asOf: "2026-11-13T09:00:00.000Z",
    summary: "Synthetic answer: the second pass is required when the margin is below the reserve.",
    dataClass,
    claims: [
      {
        id: "claim-1",
        text: "A second pass is required whenever the battery margin falls below the reserve threshold.",
        type: "source_fact",
        evidence: [
          {
            kind: "chunk",
            sourceVersionId: SOURCE_VERSION_CONFIDENTIAL,
            chunkId: CHUNK_FOUR,
            span: { startChar: 0, endChar: 96 },
            quotedText: "Synthetic site note: grid four of the sample site was surveyed twice.",
          },
        ],
        authority: "company_procedure",
        verificationStatus: "binding_passed",
        limitations: [],
      },
    ],
    unknowns: [],
    conflicts: [],
    truncation: [],
  };
}

/** The compose model's structured output, as `compose.test.ts` scripts it (no span, no status). */
export function composeCandidate(quoted: string, chunkId: string, sourceVersionId: string): string {
  return JSON.stringify({
    summary: "A second pass is required when the margin is low.",
    claims: [
      {
        id: "claim-1",
        text: "A second pass is required whenever the battery margin falls below the reserve threshold.",
        type: "source_fact",
        evidence: [{ kind: "chunk", sourceVersionId, chunkId, quotedText: quoted }],
        authority: "company_procedure",
        limitations: [],
      },
    ],
    unknowns: [],
    conflicts: [],
  });
}

export type StoreCall =
  | { name: "ensureConversation"; input: unknown }
  | { name: "appendUserMessage"; input: unknown }
  | { name: "startRun"; input: unknown }
  | { name: "completeRun"; input: unknown }
  | { name: "getRun"; input: unknown }
  | { name: "loadConversation"; input: unknown }
  | { name: "listConversations"; input: unknown };

/**
 * The chat persistence port as a recording double. `answers` lets one test make `completeRun` refuse
 * (the withheld path) or `startRun` hand back a run that already finished (the resume path), and the
 * call log is what the ordering assertions read: persistence has to precede delivery (F22), which is
 * only provable if the order is observable.
 */
export class RecordingStore implements ChatStore {
  readonly calls: StoreCall[] = [];
  answers: Partial<Record<StoreCall["name"], StoreResult<unknown>>> = {};
  completed: Answer[] = [];

  private respond<T>(name: StoreCall["name"], input: unknown, okValue: T): StoreResult<T> {
    this.calls.push({ name, input });
    const scripted = this.answers[name];
    if (scripted !== undefined) return scripted as StoreResult<T>;
    return { ok: true, value: okValue };
  }

  async ensureConversation(_ctx: TenantContext, input: { conversationId: string; expertKey: string; projectId: string | null }) {
    return this.respond("ensureConversation", input, input.conversationId);
  }

  async appendUserMessage(_ctx: TenantContext, input: { conversationId: string; clientMessageId: string }) {
    return this.respond("appendUserMessage", input, "4a010000-0000-4000-8000-000000000001");
  }

  async startRun(_ctx: TenantContext, input: { runId: string }) {
    return this.respond("startRun", input, input.runId);
  }

  async completeRun(_ctx: TenantContext, input: { runId: string; answer: Answer }) {
    this.completed.push(input.answer);
    return this.respond("completeRun", input, {
      runId: input.runId,
      conversationId: CONVERSATION_ID,
      messageId: "4a020000-0000-4000-8000-000000000001",
      // A completed run is never `running`, and the migration refuses a write that says otherwise.
      status: input.answer.status as "answered" | "partial" | "refused" | "unavailable",
      dataClass: input.answer.dataClass,
      completedAt: "2026-11-13 09:00:00+00",
    });
  }

  // The defaults are annotated with the store's own read types, so a fixture that drifts from the
  // shape the RPCs return is a compile error rather than a test that asserts on nothing.
  async getRun(_ctx: TenantContext, input: { runId: string }): Promise<StoreResult<StoredRun>> {
    return this.respond<StoredRun>("getRun", input, {
      id: input.runId,
      conversationId: CONVERSATION_ID,
      status: "running",
      answerStatus: null,
      dataClass: "internal",
      policyRevision: 1,
      expertKey: "gpr-field-officer",
      expertVersions: [],
      corpusGenerations: [],
      asOf: "2026-11-13 09:00:00+00",
      answer: null,
      startedAt: "2026-11-13 09:00:00+00",
      completedAt: null,
    });
  }

  async loadConversation(_ctx: TenantContext, input: { conversationId: string }): Promise<StoreResult<ConversationHistory>> {
    return this.respond<ConversationHistory>("loadConversation", input, {
      conversation: {
        id: input.conversationId,
        expertKey: "gpr-field-officer",
        projectId: null,
        status: "open",
        createdAt: "2026-11-13 09:00:00+00",
        lastActivityAt: "2026-11-13 09:00:00+00",
      },
      messages: [],
    });
  }

  async listConversations(_ctx: TenantContext, input: { limit: number }) {
    return this.respond("listConversations", input, { conversations: [] });
  }
}

export function catalogWith(...grants: { expertKey: string; serviceKey: string; projectIds?: string[] }[]): ExpertCatalog {
  return {
    async grants() {
      return grants.map((g) => ({ ...g, projectIds: g.projectIds ?? [] }));
    },
  };
}

export const CLOSED_CATALOG: ExpertCatalog = {
  async grants() {
    return [];
  },
};

export function searchReturning(outcome: Partial<RetrievalOutcome> = {}): CorpusSearch & { searches: unknown[] } {
  const searches: unknown[] = [];
  return {
    searches,
    async search(input) {
      searches.push(input);
      return {
        packs: [],
        corpusGenerations: [],
        mode: "lexical_only",
        diagnostics: "not_wired",
        ...outcome,
      };
    },
  };
}

export function packOf(chunkId: string, sourceVersionId: string, text: string, dataClass: DataClass) {
  return { chunkId, sourceVersionId, text, dataClass, authority: "company_procedure" };
}

/**
 * A real gateway bundle over the scripted adapters: routing, circuit and metering are the merged
 * implementation, and only the provider itself is faked (the gateway packet's own test idiom). The
 * adapter scripts are consumed per call, and the last entry repeats — which is how "this provider
 * never saw that payload" is asserted, by reading `adapter.calls`.
 */
export function gatewayBundle(
  scripts: Partial<Record<ProviderKey, ReturnType<typeof fakeAdapter>>> = {},
): { bundle: GatewayBundle; adapterCalls: () => number; meter: ReturnType<typeof recordingMeter>; config: GatewayConfiguration } {
  // A `Partial<Record<ProviderKey, …>>` may omit providers; an omitted one is "not registered", which
  // the router treats as ineligible, so the undefined entries are dropped rather than registered.
  const scripted = Object.entries(scripts).filter(([, adapter]) => adapter !== undefined) as Array<
    [ProviderKey, ProviderAdapter]
  >;
  const adapters = new Map<ProviderKey, ProviderAdapter>(scripted);
  // The circuit book is the merged implementation with the injected config's own policy, so a chat
  // test that fails a provider twice really does open the circuit the gateway would open.
  const config = testConfiguration({ endpoints: M1_ENDPOINTS });
  const health = new CircuitBook(config.circuit);
  const meter = recordingMeter();
  return {
    bundle: {
      config,
      adapters: registryOf(...Array.from(adapters.values())),
      health,
      meter: meter as unknown as MeterPort,
    },
    adapterCalls: () => Object.values(scripts).reduce((total, adapter) => total + (adapter?.calls.length ?? 0), 0),
    meter,
    config,
  };
}

export const SCRIPTED_CHAIN = FULL_COMPOSE_CHAIN;

/**
 * The frame types in order, for the "only progress before the final frame" assertion. A progress
 * frame's type is the *event's* type, so the mapping goes through `kind` first — reading `type` off
 * the frame itself would report every progress frame as an answer and make the assertion vacuous.
 */
export function progressTypes(frames: readonly ChatFrame[]): string[] {
  return frames.map((frame) => (frame.kind === "progress" ? frame.event.type : "answer"));
}
