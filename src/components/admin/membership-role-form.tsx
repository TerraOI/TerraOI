"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";

import styles from "./admin.module.css";

export type MembershipRoleFormProps = {
  csrfToken: string;
};

type Action = "grant" | "revoke";

type SubmitState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "success"; action: Action };

/**
 * Grant or revoke a membership role. User and role are addressed by id (Thin admin); the org id
 * never leaves the server (FAQ-0011). Revoke refusals for last-admin (#202) surface as plain copy.
 */
export function MembershipRoleForm({ csrfToken }: MembershipRoleFormProps) {
  const [action, setAction] = useState<Action>("grant");
  const [userId, setUserId] = useState("");
  const [roleId, setRoleId] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ kind: "submitting" });
    try {
      const response = await fetch("/admin/members/role", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ csrfToken, action, userId: userId.trim(), roleId: roleId.trim() }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok: true; action: Action }
        | { ok: false; message?: string }
        | null;
      if (!response.ok || body === null || body.ok !== true) {
        const message =
          body !== null && "message" in body && typeof body.message === "string"
            ? body.message
            : "The role change could not be applied. Please try again.";
        setState({ kind: "error", message });
        return;
      }
      setState({ kind: "success", action: body.action });
      setUserId("");
      setRoleId("");
    } catch {
      setState({
        kind: "error",
        message: "The service is temporarily unavailable. Please try again.",
      });
    }
  }

  return (
    <section className={styles.container} aria-labelledby="members-heading">
      <header className={styles.header}>
        <Link className={styles.backLink} href="/admin">
          Back to admin
        </Link>
        <h1 id="members-heading" className={styles.title}>
          Members and roles
        </h1>
        <p className={styles.subtitle}>
          Grant or revoke a role for a workspace member. The database refuses removing the last
          active admin.
        </p>
      </header>

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="member-action">
            Action
          </label>
          <select
            id="member-action"
            className={styles.select}
            name="action"
            value={action}
            onChange={(event) => setAction(event.target.value === "revoke" ? "revoke" : "grant")}
            disabled={state.kind === "submitting"}
          >
            <option value="grant">Grant role</option>
            <option value="revoke">Revoke role</option>
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="member-user-id">
            User id
          </label>
          <input
            id="member-user-id"
            className={styles.input}
            name="userId"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
            disabled={state.kind === "submitting"}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="member-role-id">
            Role id
          </label>
          <input
            id="member-role-id"
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
            {state.action === "grant" ? "Role granted." : "Role revoked."}
          </p>
        ) : null}

        <div className={styles.actions}>
          <button className={styles.primaryButton} type="submit" disabled={state.kind === "submitting"}>
            {state.kind === "submitting" ? "Saving…" : action === "grant" ? "Grant role" : "Revoke role"}
          </button>
        </div>
      </form>
    </section>
  );
}
