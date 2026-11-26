"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";

import styles from "./admin.module.css";

export type CreateProjectFormProps = {
  csrfToken: string;
};

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "success"; projectId: string };

/**
 * Create-project form for `/admin/projects`. Posts JSON to the same-origin route; the org id
 * never leaves the server (FAQ-0011).
 */
export function CreateProjectForm({ csrfToken }: CreateProjectFormProps) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"organisation" | "project">("organisation");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ kind: "submitting" });
    try {
      const response = await fetch("/admin/projects/create", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ csrfToken, key, name, visibility }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok: true; projectId: string }
        | { ok: false; message?: string }
        | null;
      if (!response.ok || body === null || body.ok !== true) {
        const message =
          body !== null && "message" in body && typeof body.message === "string"
            ? body.message
            : "The project could not be created. Please try again.";
        setState({ kind: "error", message });
        return;
      }
      setState({ kind: "success", projectId: body.projectId });
      setKey("");
      setName("");
      setVisibility("organisation");
    } catch {
      setState({
        kind: "error",
        message: "The service is temporarily unavailable. Please try again.",
      });
    }
  }

  return (
    <section className={styles.container} aria-labelledby="projects-heading">
      <header className={styles.header}>
        <Link className={styles.backLink} href="/admin">
          Back to admin
        </Link>
        <h1 id="projects-heading" className={styles.title}>
          Projects
        </h1>
        <p className={styles.subtitle}>
          Create a project to bound collections and membership. Keys are lowercase and permanent.
        </p>
      </header>

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="project-key">
            Key
          </label>
          <input
            id="project-key"
            className={styles.input}
            name="key"
            value={key}
            onChange={(event) => setKey(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
            pattern="[a-z0-9][a-z0-9-]{0,62}"
            maxLength={63}
            disabled={state.kind === "submitting"}
          />
          <p className={styles.hint}>Lowercase letters, digits and hyphens. Example: site-alpha.</p>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="project-name">
            Name
          </label>
          <input
            id="project-name"
            className={styles.input}
            name="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            maxLength={200}
            disabled={state.kind === "submitting"}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="project-visibility">
            Visibility
          </label>
          <select
            id="project-visibility"
            className={styles.select}
            name="visibility"
            value={visibility}
            onChange={(event) =>
              setVisibility(event.target.value === "project" ? "project" : "organisation")
            }
            disabled={state.kind === "submitting"}
          >
            <option value="organisation">Organisation — visible to all members</option>
            <option value="project">Project — only project members</option>
          </select>
        </div>

        {state.kind === "error" ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {state.message}
          </p>
        ) : null}
        {state.kind === "success" ? (
          <p className={`${styles.status} ${styles.statusOk}`} role="status">
            Project created.
          </p>
        ) : null}

        <div className={styles.actions}>
          <button className={styles.primaryButton} type="submit" disabled={state.kind === "submitting"}>
            {state.kind === "submitting" ? "Creating…" : "Create project"}
          </button>
        </div>
      </form>
    </section>
  );
}
