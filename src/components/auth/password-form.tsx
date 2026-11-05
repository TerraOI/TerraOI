import type { FormAction } from "./magic-link-form";
import styles from "./sign-in.module.css";

/** Collapsed behind a native <details>, so it opens without client JS. */
/** `defaultOpen` keeps the form expanded after a failed attempt, so the user can retry. */
export function PasswordForm({ action, defaultOpen = false }: { action: FormAction; defaultOpen?: boolean }) {
  return (
    <details className={styles.passwordToggle} open={defaultOpen}>
      <summary className={styles.secondary}>Use a password instead</summary>
      <form className={styles.form} action={action}>
        <label className={styles.field}>
          <span className={styles.label}>Email</span>
          <input
            className={styles.input}
            name="email"
            type="email"
            autoComplete="username"
            inputMode="email"
            required
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Password</span>
          <input
            className={styles.input}
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </label>
        <button className={styles.primary} type="submit">
          Sign in
        </button>
      </form>
    </details>
  );
}
