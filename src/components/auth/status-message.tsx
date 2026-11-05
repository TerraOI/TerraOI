import { STATUS_COPY } from "./copy";
import styles from "./sign-in.module.css";
import type { SignInStatus } from "./types";

/** Always mounted so screen readers announce changes; empty while idle. */
export function StatusMessage({ status }: { status: SignInStatus }) {
  return (
    <p className={styles.status} role="status" aria-live="polite">
      {status === "idle" ? "" : STATUS_COPY[status]}
    </p>
  );
}
