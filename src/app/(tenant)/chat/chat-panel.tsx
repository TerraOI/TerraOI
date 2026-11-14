"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import type { Answer } from "@/contracts/answer";
import type { ProgressEvent } from "@/contracts/chat";
import { readChatStream } from "@/platform/chat/stream";

import styles from "./chat.module.css";

/**
 * The client half of F21 (plan §9.1): a question box, typed progress, and an answer that arrives whole.
 *
 * What this component deliberately cannot do, and why a reviewer should look for exactly this:
 *
 * - **It sends no identity.** The body carries a conversation id, a client message id, an idempotency
 *   key, an expert key and the question. There is no `organisationId`, `userId`, `role`, `host`, model
 *   or provider field to send, and the server refuses the request outright if one appears
 *   (`src/platform/chat/envelope.ts`).
 * - **It renders no answer of its own.** Nothing is shown as a finding until an `answer` frame arrives;
 *   the only text before that is one of five fixed progress labels, chosen from a closed set the
 *   contract defines (§9.3). The server never streams a candidate.
 * - **It keeps no history authority.** On reload the transcript is rebuilt by the server from stored
 *   rows; the browser's own list is a view, not the source (F17). So a reload starts empty and the
 *   employee can open a conversation from the server's copy — which is what makes a pasted fake
 *   assistant turn in the request body pointless.
 */

export interface ChatPanelProps {
  /** The experts this employee may use, resolved server-side from their grants. */
  experts: readonly { key: string; label: string }[];
  /** A server-generated notice when the surface is not available (a tenancy or configuration answer). */
  notice?: string;
}

const PROGRESS_LABEL: Record<ProgressEvent["type"], string> = {
  routing: "Choosing the expert…",
  searching: "Searching the documents you are allowed to read…",
  reading_records: "Reading the records this expert may use…",
  verifying: "Checking the answer against its sources…",
  tier_changed: "Trying another route for this question…",
};

type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; answer: Answer | null; progress: ProgressEvent[] };

function newId(): string {
  return crypto.randomUUID();
}

export function ChatPanel({ experts, notice }: ChatPanelProps) {
  const [expertKey, setExpertKey] = useState<string>(experts[0]?.key ?? "");
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One conversation per panel: the server pins it to this tenant and this employee on insert, so a
  // reused id across tenants is refused rather than adopted.
  const conversationId = useRef<string>(newId());

  const ask = useCallback(async () => {
    const text = question.trim();
    if (text.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    setTurns((current) => [...current, { role: "user", text }, { role: "assistant", answer: null, progress: [] }]);

    // The same key is reused if this turn is retried, so a retry resumes the existing run instead of
    // paying for a second one (plan §9.2). A deliberate new question gets a new key.
    const idempotencyKey = newId();
    const clientMessageId = newId();
    setQuestion("");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({
          conversationId: conversationId.current,
          clientMessageId,
          idempotencyKey,
          expertKey,
          messages: [{ id: clientMessageId, role: "user", parts: [{ type: "text", text }] }],
        }),
      });

      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        const payload = (await response.json().catch(() => null)) as { message?: string } | null;
        // The server's safe sentence, not a guess: it already avoids naming a tenant, a table or a
        // provider (plan §8.2), so the panel adds none of its own.
        setError(payload?.message ?? "The assistant could not answer just now.");
        setTurns((current) => current.slice(0, -2));
        return;
      }
      if (!response.ok) {
        setError("The assistant could not answer just now.");
        return;
      }

      const read = readChatStream(response);
      if (!read.ok) {
        setError("The assistant could not answer just now.");
        return;
      }
      let delivered = false;
      for await (const frame of read.frames) {
        if (frame.kind === "progress") {
          setTurns((current) => {
            const next = [...current];
            const last = next[next.length - 1];
            if (last !== undefined && last.role === "assistant") {
              next[next.length - 1] = { ...last, progress: [...last.progress, frame.event] };
            }
            return next;
          });
          continue;
        }

        delivered = true;
        setTurns((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last !== undefined && last.role === "assistant") next[next.length - 1] = { role: "assistant", answer: frame.answer, progress: last.progress };
          return next;
        });
      }
      if (!delivered) {
        // The stream ended without an answer frame. That is a fact about the connection, not about the
        // run: the server keeps what it wrote, so the panel says where to look rather than guessing at
        // an outcome it never saw.
        setError("The connection stopped. The answer is still being kept — reload this page to see it.");
      }
    } catch {
      // A dropped connection or an unreadable frame is not something to interpret either: the run is
      // stored server-side and a reload reads it back (`chat_get_run_v1`), so the employee is told
      // where to look instead of being shown a partial answer.
      setError("The connection stopped. The answer is still being kept — reload this page to see it.");
    } finally {
      setBusy(false);
    }
  }, [busy, expertKey, question]);

  const canAsk = useMemo(() => expertKey.length > 0 && question.trim().length > 0 && !busy, [busy, expertKey, question]);

  return (
    <section className={styles.panel} aria-label="Ask an expert">
      <form
        className={styles.ask}
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <label className={styles.field}>
          <span className={styles.label}>Expert</span>
          <select value={expertKey} onChange={(event) => setExpertKey(event.target.value)} disabled={busy}>
            {experts.map((expert) => (
              <option key={expert.key} value={expert.key}>
                {expert.label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Question</span>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            rows={3}
            maxLength={32000}
            placeholder="Ask about the documents you have access to."
            disabled={busy}
          />
        </label>
        <button type="submit" disabled={!canAsk}>
          {busy ? "Working…" : "Ask"}
        </button>
        {notice !== undefined && <p className={styles.notice}>{notice}</p>}
        {error !== null && (
          <p className={styles.error} role="status">
            {error}
          </p>
        )}
      </form>

      <ol className={styles.turns}>
        {turns.map((turn, index) => (
          <li key={`${index}-${turn.role}`} className={turn.role === "user" ? styles.userTurn : styles.assistantTurn}>
            {turn.role === "user" ? (
              <p className={styles.question}>{turn.text}</p>
            ) : (
              <>
                {turn.answer === null && (
                  <ul className={styles.progress} aria-label="Progress">
                    {turn.progress.map((event, position) => (
                      <li key={`${event.type}-${position}`}>{PROGRESS_LABEL[event.type]}</li>
                    ))}
                  </ul>
                )}
                {turn.answer !== null && <AnswerBlock answer={turn.answer} />}
              </>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * One delivered answer: the summary, its status, its data class, and each claim with the passage it
 * rests on. There is deliberately no link to open a document here — citation preview has to be
 * re-authorized on click (T-203), so a locator without access would be a leak.
 */
function AnswerBlock({ answer }: { answer: Answer }) {
  return (
    <div className={styles.answer} data-status={answer.status}>
      <p className={styles.summary}>{answer.summary}</p>
      <p className={styles.meta}>
        <span>{answerStatusLabel(answer.status)}</span>
        <span> · class {answer.dataClass}</span>
        {answer.truncation.length > 0 && <span> · {answer.truncation.length} part(s) left out</span>}
      </p>
      {answer.claims.length > 0 && (
        <ol className={styles.claims}>
          {answer.claims.map((claim) => (
            <li key={claim.id}>
              <p>{claim.text}</p>
              <ul className={styles.citations}>
                {claim.evidence.map((evidence, position) => (
                  <li key={`${claim.id}-${position}`}>
                    {evidence.kind === "chunk"
                      ? `“${evidence.quotedText}”`
                      : evidence.kind === "record"
                        ? `Record ${evidence.recordType} v${evidence.recordVersion}`
                        : `Form field ${evidence.fieldPath}`}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {answer.unknowns.length > 0 && (
        <details className={styles.unknowns}>
          <summary>What this answer does not cover</summary>
          <ul>
            {answer.unknowns.map((unknown, position) => (
              <li key={`unknown-${position}`}>{unknown}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The four statuses of the merged contract, in words an employee can act on. */
function answerStatusLabel(status: Answer["status"]): string {
  switch (status) {
    case "answered":
      return "Answered from your documents";
    case "partial":
      return "Partly answered — some of it was withheld";
    case "refused":
      return "No answer: the documents you may read do not cover this";
    case "unavailable":
      return "Not available just now";
  }
}
