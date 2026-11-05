import type { FormAction } from "./magic-link-form";
import styles from "./sign-in.module.css";

/** Collapsed behind a native <details>, so it opens without client JS. */
export function PasswordForm({ action }: { action: FormAction }) {
  return (
    <details className={styles.passwordToggle}>
      <summary className={styles.secondary}>Use a password instead</summary>
      <form className={styles.form} action={action}>
        <label className={styles.label} htmlFor="signin-password-email">
          Email
        </label>
        <input
          className={styles.input}
          id="signin-password-email"
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          required
        />
        <label className={styles.label} htmlFor="signin-password">
          Password
        </label>
        <input
          className={styles.input}
          id="signin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <button className={styles.primary} type="submit">
          Sign in
        </button>
      </form>
    </details>
  );
}
