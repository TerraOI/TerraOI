"use client";

import { useState } from "react";

import type { QueuedSubmission } from "@/platform/knowledge/submission-queue";

import styles from "./submission-review.module.css";

/**
 * T-302 reviewer queue (plan §7.4): each submitted proposal with its collection, data class and the
 * number of sources it cites; a reviewer approves or rejects it through T-302b's route, which applies
 * T-213's publication rules. The author never gets decision controls on their own submission, and
 * the server refuses them regardless (independence is compared to the server-set author, #8).
 */
export function SubmissionReviewList({ submissions }: { submissions: readonly QueuedSubmission[] }) {
  if (submissions.length === 0) {
    return <p role="status" className={styles.note}>Nothing is waiting for review.</p>;
  }
  return (
    <ul className={styles.list}>
      {submissions.map((submission) => (
        <SubmissionItem key={submission.id} submission={submission} />
      ))}
    </ul>
  );
}

type Outcome = { kind: "idle" } | { kind: "busy" } | { kind: "done"; message: string } | { kind: "error"; message: string };

function SubmissionItem({ submission }: { submission: QueuedSubmission }) {
  const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
  const [reason, setReason] = useState("");

  async function decide(decision: "approve" | "reject") {
    setOutcome({ kind: "busy" });
    try {
      const trimmed = reason.trim();
      const response = await fetch(`/api/knowledge/submissions/${submission.id}/review`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ decision, ...(trimmed.length > 0 ? { reason: trimmed } : {}) }),
      });
      const payload = (await response.json().catch(() => null)) as { error?: { message?: unknown } } | null;
      if (!response.ok) {
        const message = typeof payload?.error?.message === "string" ? payload.error.message : "The decision could not be saved.";
        setOutcome({ kind: "error", message });
        return;
      }
      setOutcome({ kind: "done", message: decision === "approve" ? "Approved — it is now a versioned source." : "Rejected." });
    } catch {
      setOutcome({ kind: "error", message: "The service is temporarily unavailable. Please try again." });
    }
  }

  const decidable = submission.state === "submitted" && !submission.authorIsCaller && outcome.kind !== "done";
  return (
    <li className={styles.item} aria-label={`Submission to ${submission.collectionName}`}>
      <p className={styles.meta}>
        <span>{submission.kind}</span> · <span>{submission.collectionName}</span> · <span>class {submission.dataClass}</span> ·{" "}
        <span>{submission.citedCount} cited source{submission.citedCount === 1 ? "" : "s"}</span> · <span>{submission.state}</span>
      </p>
      <blockquote className={styles.text}>{submission.proposedText}</blockquote>
      {submission.authorIsCaller && <p className={styles.note}>You submitted this, so another reviewer must decide it.</p>}
      {decidable && (
        <div className={styles.actions}>
          <label className={styles.reason}>
            <span>Reason (optional)</span>
            <input value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button type="button" disabled={outcome.kind === "busy"} onClick={() => void decide("approve")}>Approve</button>
          <button type="button" disabled={outcome.kind === "busy"} onClick={() => void decide("reject")}>Reject</button>
        </div>
      )}
      {outcome.kind === "done" && <p role="status" className={styles.note}>{outcome.message}</p>}
      {outcome.kind === "error" && <p role="alert" className={styles.error}>{outcome.message}</p>}
    </li>
  );
}
