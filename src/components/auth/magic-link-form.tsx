import styles from "./sign-in.module.css";
import type { SignInFormAction } from "./types";

export type FormAction = SignInFormAction;

export function MagicLinkForm({
  action,
  csrfToken,
}: {
  action: FormAction | string;
  csrfToken?: string;
}) {
  const postsToUrl = typeof action === "string";
  return (
    <form className={styles.form} action={action} method={postsToUrl ? "post" : undefined}>
      {csrfToken ? <input type="hidden" name="csrf_token" value={csrfToken} /> : null}
      <label className={styles.field}>
        <span className={styles.label}>Work email</span>
        <input
          className={styles.input}
          name="email"
          type="email"
          autoComplete="username"
          inputMode="email"
          required
        />
      </label>
      <button className={styles.primary} type="submit">
        Email me a sign-in link
      </button>
    </form>
  );
}
