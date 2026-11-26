"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";

import styles from "./admin.module.css";

export type InviteMemberFormProps = {
  csrfToken: string;
};

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "success" };

/**
 * Invite an address into this workspace with a role. Org id never leaves the server (FAQ-0011).
 * Claim / active membership is T-201; this form only calls invite_member_v1 (#226).
 */
export function InviteMemberForm({ csrfToken }: InviteMemberFormProps) {
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ kind: "submitting" });
    try {
      const response = await fetch("/admin/members/invite", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ csrfToken, email: email.trim(), roleId: roleId.trim() }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok: true }
        | { ok: false; message?: string }
        | null;
      if (!response.ok || body === null || body.ok !== true) {
        const message =
          body !== null && "message" in body && typeof body.message === "string"
            ? body.message
            : "The invitation could not be sent. Please try again.";
        setState({ kind: "error", message });
        return;
      }
      setState({ kind: "success" });
      setEmail("");
      setRoleId("");
    } catch {
      setState({
        kind: "error",
        message: "The service is temporarily unavailable. Please try again.",
      });
    }
  }

  return (
    <section className={styles.container} aria-labelledby="invite-heading">
      <header className={styles.header}>
        <Link className={styles.backLink} href="/admin">
          Back to admin
        </Link>
        <h1 id="invite-heading" className={styles.title}>
          Invite a member
        </h1>
        <p className={styles.subtitle}>
          Send an invitation to a work email. They become active only after they claim it.
        </p>
      </header>

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="invite-email">
            Email
          </label>
          <input
            id="invite-email"
            className={styles.input}
            name="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
            disabled={state.kind === "submitting"}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="invite-role-id">
            Role id
          </label>
          <input
            id="invite-role-id"
            className={styles.input}
            name="roleId"
            value={roleId}
            onChange={(event) => setRoleId(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
            disabled={state.kind === "submitting"}
          />
          <p className={styles.hint}>Use the role uuid from this workspace — never from another tenant.</p>
        </div>

        {state.kind === "error" ? (
          <p className={`${styles.status} ${styles.statusError}`} role="alert">
            {state.message}
          </p>
        ) : null}
        {state.kind === "success" ? (
          <p className={`${styles.status} ${styles.statusOk}`} role="status">
            Invitation recorded.
          </p>
        ) : null}

        <div className={styles.actions}>
          <button className={styles.primaryButton} type="submit" disabled={state.kind === "submitting"}>
            {state.kind === "submitting" ? "Sending…" : "Send invitation"}
          </button>
        </div>
      </form>
    </section>
  );
}
