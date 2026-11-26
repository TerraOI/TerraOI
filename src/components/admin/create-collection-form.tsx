"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";

import styles from "./admin.module.css";

export type CreateCollectionFormProps = {
  csrfToken: string;
};

type DataClass = "public" | "internal" | "client_confidential";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "success"; collectionId: string };

/**
 * Create-collection form for `/admin/collections`. Posts JSON to the same-origin route; the org
 * id never leaves the server (FAQ-0011 / #41).
 */
export function CreateCollectionForm({ csrfToken }: CreateCollectionFormProps) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [service, setService] = useState("uav");
  const [dataClass, setDataClass] = useState<DataClass>("internal");
  const [projectId, setProjectId] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ kind: "submitting" });
    const trimmedProject = projectId.trim();
    try {
      const response = await fetch("/admin/collections/create", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          csrfToken,
          key,
          name,
          service,
          dataClass,
          projectId: trimmedProject.length === 0 ? null : trimmedProject,
        }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok: true; collectionId: string }
        | { ok: false; message?: string }
        | null;
      if (!response.ok || body === null || body.ok !== true) {
        const message =
          body !== null && "message" in body && typeof body.message === "string"
            ? body.message
            : "The collection could not be created. Please try again.";
        setState({ kind: "error", message });
        return;
      }
      setState({ kind: "success", collectionId: body.collectionId });
      setKey("");
      setName("");
      setService("uav");
      setDataClass("internal");
      setProjectId("");
    } catch {
      setState({
        kind: "error",
        message: "The service is temporarily unavailable. Please try again.",
      });
    }
  }

  return (
    <section className={styles.container} aria-labelledby="collections-heading">
      <header className={styles.header}>
        <Link className={styles.backLink} href="/admin">
          Back to admin
        </Link>
        <h1 id="collections-heading" className={styles.title}>
          Collections
        </h1>
        <p className={styles.subtitle}>
          Create a knowledge collection with a data class. Client-confidential collections require a
          project id.
        </p>
      </header>

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="collection-key">
            Key
          </label>
          <input
            id="collection-key"
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
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="collection-name">
            Name
          </label>
          <input
            id="collection-name"
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
          <label className={styles.label} htmlFor="collection-service">
            Service
          </label>
          <select
            id="collection-service"
            className={styles.select}
            name="service"
            value={service}
            onChange={(event) => setService(event.target.value)}
            disabled={state.kind === "submitting"}
          >
            <option value="uav">uav</option>
            <option value="gpr">gpr</option>
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="collection-data-class">
            Data class
          </label>
          <select
            id="collection-data-class"
            className={styles.select}
            name="dataClass"
            value={dataClass}
            onChange={(event) => setDataClass(event.target.value as DataClass)}
            disabled={state.kind === "submitting"}
          >
            <option value="public">public</option>
            <option value="internal">internal</option>
            <option value="client_confidential">client_confidential</option>
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="collection-project">
            Project id (optional)
          </label>
          <input
            id="collection-project"
            className={styles.input}
            name="projectId"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="Required for client_confidential"
            disabled={state.kind === "submitting"}
          />
          <p className={styles.hint}>Leave blank for organisation-scoped public or internal collections.</p>
        </div>

        {state.kind === "error" ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {state.message}
          </p>
        ) : null}
        {state.kind === "success" ? (
          <p className={`${styles.status} ${styles.statusOk}`} role="status">
            Collection created.
          </p>
        ) : null}

        <div className={styles.actions}>
          <button className={styles.primaryButton} type="submit" disabled={state.kind === "submitting"}>
            {state.kind === "submitting" ? "Creating…" : "Create collection"}
          </button>
        </div>
      </form>
    </section>
  );
}
