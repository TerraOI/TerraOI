import type { FormAction } from "./magic-link-form";
import styles from "./sign-in.module.css";

/** Collapsed behind a native <details>, so it opens without client JS. */
export function PasswordForm({ action }: { action: FormAction }) {
  return (
    <details className={styles.passwordToggle}>
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
