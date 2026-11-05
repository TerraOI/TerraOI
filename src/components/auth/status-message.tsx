import { STATUS_COPY } from "./copy";
import styles from "./sign-in.module.css";
import type { SignInStatus } from "./types";

/** Always mounted so screen readers announce changes; empty while idle. */
export function StatusMessage({ status }: { status: SignInStatus }) {
  // Own-key check: a value cast from a URL ("__proto__", "toString") must not reach the lookup.
  const text = status !== "idle" && Object.hasOwn(STATUS_COPY, status) ? STATUS_COPY[status] : "";
  return (
    <p className={styles.status} role="status" aria-live="polite">
      {text}
    </p>
  );
}
