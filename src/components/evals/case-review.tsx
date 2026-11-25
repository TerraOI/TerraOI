"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import type { EvalReviewCase } from "@/platform/evals/review-queue";

import styles from "./evals.module.css";
import { CASE_TYPE_LABEL, DATA_CLASS_LABEL, ORIGIN_LABEL, STATUS_LABEL } from "./labels";

type State =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "done"; message: string };

const CASE_TYPES = Object.keys(CASE_TYPE_LABEL) as EvalReviewCase["caseType"][];

/**
 * T-303 case detail and decision controls (plan §14.1 step 3). Shows question, expected answer
 * points, expected source and locators, case type; posts approve / edit / reject with the version
 * token it was rendered from. The reviewer and time are recorded server-side; nothing here names them.
 */
export function EvalCaseReview({ evalCase, csrfToken }: { evalCase: EvalReviewCase; csrfToken: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "idle" });
  const [editing, setEditing] = useState(false);
  const [question, setQuestion] = useState(evalCase.question);
  const [caseType, setCaseType] = useState(evalCase.caseType);
  const [points, setPoints] = useState(evalCase.expectedAnswerPoints.join("\n"));
  const [expectedSource, setExpectedSource] = useState(evalCase.expectedSource ?? "");

  const busy = state.kind === "submitting";
  const locked = evalCase.authorIsCaller;

  async function send(payload: Record<string, unknown>, success: string) {
    setState({ kind: "submitting" });
    try {
      const response = await fetch("/evals/decide", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ csrfToken, caseId: evalCase.id, expectedUpdatedAt: evalCase.updatedAt, ...payload }),
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; message?: unknown } | null;
      if (!response.ok || body?.ok !== true) {
        setState({
          kind: "error",
          message: typeof body?.message === "string" ? body.message : "The decision could not be saved. Please try again.",
        });
        return;
      }
      setState({ kind: "done", message: success });
      setEditing(false);
      router.refresh();
    } catch {
      setState({ kind: "error", message: "The service is temporarily unavailable. Please try again." });
    }
  }

  function onEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const edits: Record<string, unknown> = {};
    const trimmedQuestion = question.trim();
    if (trimmedQuestion !== evalCase.question) edits.question = trimmedQuestion;
    if (caseType !== evalCase.caseType) edits.caseType = caseType;
    const nextPoints = points.split("\n").map((p) => p.trim()).filter((p) => p.length > 0);
    if (nextPoints.join("\n") !== evalCase.expectedAnswerPoints.join("\n")) edits.expectedAnswerPoints = nextPoints;
    const trimmedSource = expectedSource.trim();
    if (trimmedSource !== (evalCase.expectedSource ?? "") && trimmedSource.length > 0) edits.expectedSource = trimmedSource;
    if (Object.keys(edits).length === 0) {
      setState({ kind: "error", message: "Change at least one field before saving an edit." });
      return;
    }
    void send({ decision: "edit", edits }, "Edit saved. The case is back in pending review.");
  }

  return (
    <article className={styles.container} aria-labelledby="case-heading">
      <header>
        <Link href="/evals">Back to cases</Link>
        <h1 id="case-heading" className={styles.title}>
          {evalCase.caseKey}
        </h1>
        <p className={styles.meta}>
          <span className={styles.badge}>{evalCase.expertKey}</span>
          <span className={styles.badge}>{STATUS_LABEL[evalCase.status]}</span>
          <span className={styles.badge}>{CASE_TYPE_LABEL[evalCase.caseType]}</span>
          <span className={styles.badge}>{ORIGIN_LABEL[evalCase.origin]}</span>
          <span className={styles.badge}>{DATA_CLASS_LABEL[evalCase.dataClass] ?? evalCase.dataClass}</span>
        </p>
      </header>

      <section className={styles.section} aria-labelledby="q-heading">
        <h2 id="q-heading" className={styles.sectionTitle}>Question</h2>
        <p>{evalCase.question}</p>
      </section>

      <section className={styles.section} aria-labelledby="points-heading">
        <h2 id="points-heading" className={styles.sectionTitle}>Expected answer points</h2>
        {evalCase.expectedAnswerPoints.length === 0 ? (
          <p className={styles.note}>None recorded.</p>
        ) : (
          <ul className={styles.points}>
            {evalCase.expectedAnswerPoints.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section} aria-labelledby="source-heading">
        <h2 id="source-heading" className={styles.sectionTitle}>Why this case: expected source</h2>
        <p>{evalCase.expectedSource ?? "No expected source recorded."}</p>
        {evalCase.locators.length > 0 ? (
          <ul className={styles.points} aria-label="Source locators">
            {evalCase.locators.map((locator) => (
              <li key={locator.sourceVersionId + (locator.chunkId ?? "")}>
                Source version {locator.sourceVersionId}
                {locator.chunkId === null ? "" : `, chunk ${locator.chunkId}`}
              </li>
            ))}
          </ul>
        ) : null}
        {evalCase.sourcesValid ? null : (
          <p className={`${styles.status} ${styles.error}`} role="note">
            An expected source was revoked or is no longer available. This case cannot be approved until it is edited.
          </p>
        )}
      </section>

      {evalCase.status === "approved" && evalCase.approvedAt !== null ? (
        <p className={styles.note}>Approved {new Date(evalCase.approvedAt).toISOString().slice(0, 16).replace("T", " ")} UTC.</p>
      ) : null}

      {locked ? (
        <p className={styles.note} role="note">
          You drafted this case, so another reviewer must decide it.
        </p>
      ) : (
        <section className={styles.section} aria-label="Decision">
          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.button} ${styles.primary}`}
              disabled={busy || evalCase.status === "approved" || !evalCase.sourcesValid}
              onClick={() => void send({ decision: "approve" }, "Case approved.")}
            >
              Approve
            </button>
            <button type="button" className={styles.button} disabled={busy} onClick={() => setEditing((v) => !v)}>
              {editing ? "Cancel edit" : "Edit"}
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => void send({ decision: "reject" }, "Case rejected. It stays out of scored runs.")}
            >
              Reject
            </button>
          </div>

          {editing ? (
            <form className={styles.section} onSubmit={onEdit} aria-label="Edit case" noValidate>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="edit-question">Question</label>
                <textarea id="edit-question" className={styles.textarea} value={question} maxLength={4000}
                  onChange={(e) => setQuestion(e.target.value)} disabled={busy} />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="edit-case-type">Case type</label>
                <select id="edit-case-type" className={styles.select} value={caseType} disabled={busy}
                  onChange={(e) => setCaseType(e.target.value as EvalReviewCase["caseType"])}>
                  {CASE_TYPES.map((t) => (
                    <option key={t} value={t}>{CASE_TYPE_LABEL[t]}</option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="edit-points">Expected answer points (one per line)</label>
                <textarea id="edit-points" className={styles.textarea} value={points}
                  onChange={(e) => setPoints(e.target.value)} disabled={busy} />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="edit-source">Expected source</label>
                <input id="edit-source" className={styles.input} value={expectedSource} maxLength={2000}
                  onChange={(e) => setExpectedSource(e.target.value)} disabled={busy} />
              </div>
              <div className={styles.actions}>
                <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={busy}>Save edit</button>
              </div>
            </form>
          ) : null}
        </section>
      )}

      {state.kind === "error" ? (
        <p className={`${styles.status} ${styles.error}`} role="alert">{state.message}</p>
      ) : null}
      {state.kind === "done" ? (
        <p className={styles.status} role="status">{state.message}</p>
      ) : null}
    </article>
  );
}
