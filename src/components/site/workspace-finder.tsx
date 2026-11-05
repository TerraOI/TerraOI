"use client";

import { useId, useState, type FormEvent } from "react";
import { workspaceUrl } from "@/platform/site/workspace";
import styles from "./site.module.css";

type Props = {
  /** Injected for tests; the page uses a full navigation to the tenant host. */
  navigate?: (url: string) => void;
};

/** Goes straight to <slug>.terraoi.app. It never asks the server whether the workspace exists. */
export function WorkspaceFinder({ navigate = (url) => window.location.assign(url) }: Props) {
  const [hint, setHint] = useState<string | null>(null);
  const id = useId();
  const hintId = `${id}-hint`;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("workspace");
    const result = workspaceUrl(typeof value === "string" ? value : "");
    if (result.ok) {
      setHint(null);
      navigate(result.url);
    } else {
      setHint(result.hint);
    }
  }

  return (
    <form className={styles.finder} onSubmit={onSubmit} noValidate>
      <label className={styles.finderLabel} htmlFor={id}>
        Go to your workspace
      </label>
      <div className={styles.finderRow}>
        <div className={styles.finderField}>
          <input
            className={styles.finderInput}
            id={id}
            name="workspace"
            placeholder="yourcompany"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={hint ? true : undefined}
            aria-describedby={hint ? hintId : undefined}
          />
          <span className={styles.finderSuffix} aria-hidden="true">
            .terraoi.app
          </span>
        </div>
        <button className={styles.buttonPrimary} type="submit">
          Continue
        </button>
      </div>
      {hint && (
        <p className={styles.finderHint} id={hintId}>
          {hint}
        </p>
      )}
    </form>
  );
}
