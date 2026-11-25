"use client";

import { useEffect, useState, type FormEvent } from "react";

import type { Answer } from "@/contracts/answer";

import styles from "./feedback.module.css";

/**
 * T-302 controls under a delivered answer: Useful, Incorrect, Suggest correction, Save as knowledge
 * (plan §7.4). Ratings are evaluation signals and never change the answer on screen. "Save as
 * knowledge" opens a submission — proposed text, the answer's cited sources, and an audience the
 * employee must confirm — that a reviewer approves or rejects; chat text never becomes company fact
 * by itself. The body sent names no organisation, user or class label of its own: the class sent is
 * the answer's, as a floor the server raises from the cited versions (ADR-0013).
 */

type Collection = { id: string; name: string; dataClass: string; projectScoped: boolean };
type Status = { kind: "idle" } | { kind: "busy" } | { kind: "ok"; message: string } | { kind: "error"; message: string };

const UNAVAILABLE = "The service is temporarily unavailable. Please try again.";

function citedVersions(answer: Answer): string[] {
  const ids = new Set<string>();
  for (const claim of answer.claims) for (const evidence of claim.evidence) if (evidence.kind === "chunk") ids.add(evidence.sourceVersionId);
  return [...ids];
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; message: string | null }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | { message?: unknown; error?: { message?: unknown } }
      | null;
    const message =
      typeof payload?.message === "string"
        ? payload.message
        : typeof payload?.error?.message === "string"
          ? payload.error.message
          : null;
    return { ok: response.ok, message };
  } catch {
    return { ok: false, message: UNAVAILABLE };
  }
}

export function AnswerFeedback({ answer }: { answer: Answer }) {
  const [rating, setRating] = useState<Status>({ kind: "idle" });
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState("");
  const [saving, setSaving] = useState<{ text: string; kind: "answer" | "correction" } | null>(null);

  async function rate(kind: "useful" | "incorrect" | "suggest_correction", correctionText?: string) {
    setRating({ kind: "busy" });
    const result = await postJson("/chat/feedback", {
      runId: answer.runId,
      kind,
      ...(correctionText === undefined ? {} : { correctionText }),
    });
    setRating(result.ok ? { kind: "ok", message: result.message ?? "Thanks — your feedback was saved." } : { kind: "error", message: result.message ?? UNAVAILABLE });
    return result.ok;
  }

  async function submitCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = correction.trim();
    if (text.length === 0) {
      setRating({ kind: "error", message: "Write the correction before sending it." });
      return;
    }
    if (await rate("suggest_correction", text)) {
      setCorrecting(false);
      // The correction becomes a submission draft — never an edit of the answer (§7.4).
      setSaving({ text, kind: "correction" });
    }
  }

  const busy = rating.kind === "busy";
  return (
    <div className={styles.feedback}>
      <div className={styles.controls} role="group" aria-label="Rate this answer">
        <button type="button" disabled={busy} onClick={() => void rate("useful")}>Useful</button>
        <button type="button" disabled={busy} onClick={() => void rate("incorrect")}>Incorrect</button>
        <button type="button" disabled={busy} onClick={() => setCorrecting((v) => !v)}>Suggest correction</button>
        <button
          type="button"
          disabled={busy || answer.dataClass === "restricted"}
          onClick={() => setSaving({ text: answer.summary, kind: "answer" })}
        >
          Save as knowledge
        </button>
      </div>
      {correcting && (
        <form className={styles.form} onSubmit={submitCorrection} aria-label="Suggest a correction">
          <label className={styles.field}>
            <span>Your correction</span>
            <textarea value={correction} maxLength={4000} onChange={(e) => setCorrection(e.target.value)} />
          </label>
          <button type="submit" disabled={busy}>Send correction</button>
        </form>
      )}
      {rating.kind === "ok" && <p role="status" className={styles.ok}>{rating.message}</p>}
      {rating.kind === "error" && <p role="alert" className={styles.error}>{rating.message}</p>}
      {saving !== null && (
        <SaveAsKnowledge answer={answer} initialText={saving.text} kind={saving.kind} onClose={() => setSaving(null)} />
      )}
    </div>
  );
}

function SaveAsKnowledge({
  answer,
  initialText,
  kind,
  onClose,
}: {
  answer: Answer;
  initialText: string;
  kind: "answer" | "correction";
  onClose: () => void;
}) {
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collectionId, setCollectionId] = useState("");
  const [text, setText] = useState(initialText);
  const [confirmed, setConfirmed] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const cited = citedVersions(answer);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch("/chat/collections", { headers: { accept: "application/json" } });
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; collections?: Collection[]; message?: string } | null;
        if (!live) return;
        if (!response.ok || payload?.ok !== true || !Array.isArray(payload.collections)) {
          setLoadError(payload?.message ?? UNAVAILABLE);
          return;
        }
        setCollections(payload.collections);
      } catch {
        if (live) setLoadError(UNAVAILABLE);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const chosen = collections?.find((c) => c.id === collectionId) ?? null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chosen === null || !confirmed || text.trim().length === 0) {
      setStatus({ kind: "error", message: "Choose who will see this, confirm it, and keep some text." });
      return;
    }
    setStatus({ kind: "busy" });
    const result = await postJson("/api/knowledge/submissions", {
      collectionId: chosen.id,
      kind,
      proposedText: text.trim(),
      contextDataClass: answer.dataClass,
      citedSourceVersionIds: cited,
      agentRunId: answer.runId,
    });
    setStatus(
      result.ok
        ? { kind: "ok", message: "Submitted for review. It becomes company knowledge only if a reviewer approves it." }
        : { kind: "error", message: result.message ?? UNAVAILABLE },
    );
  }

  return (
    <form className={styles.form} onSubmit={submit} aria-label="Save as knowledge">
      <p className={styles.note}>
        Proposed {kind === "correction" ? "correction" : "answer"} for review. It cites {cited.length} source
        {cited.length === 1 ? "" : "s"} from this answer and keeps at least its data class ({answer.dataClass}).
      </p>
      <label className={styles.field}>
        <span>Proposed text</span>
        <textarea value={text} maxLength={200000} onChange={(e) => setText(e.target.value)} />
      </label>
      {loadError !== null && <p role="alert" className={styles.error}>{loadError}</p>}
      {collections !== null && (
        <label className={styles.field}>
          <span>Who will see it (collection)</span>
          <select value={collectionId} onChange={(e) => { setCollectionId(e.target.value); setConfirmed(false); }}>
            <option value="">Choose a collection…</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.dataClass}{c.projectScoped ? ", project members only" : ""})
              </option>
            ))}
          </select>
        </label>
      )}
      {chosen !== null && (
        <label className={styles.check}>
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>
            I confirm this may be seen by readers of {chosen.name}
            {chosen.projectScoped ? " (project members only)" : ""}.
          </span>
        </label>
      )}
      <div className={styles.controls}>
        <button type="submit" disabled={status.kind === "busy" || chosen === null || !confirmed}>Submit for review</button>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {status.kind === "ok" && <p role="status" className={styles.ok}>{status.message}</p>}
      {status.kind === "error" && <p role="alert" className={styles.error}>{status.message}</p>}
    </form>
  );
}
