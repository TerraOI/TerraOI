import styles from "./sign-in.module.css";

export type FormAction = (form: FormData) => void | Promise<void>;

export function MagicLinkForm({ action }: { action: FormAction }) {
  return (
    <form className={styles.form} action={action}>
      <label className={styles.label} htmlFor="signin-email">
        Work email
      </label>
      <input
        className={styles.input}
        id="signin-email"
        name="email"
        type="email"
        autoComplete="username"
        inputMode="email"
        required
      />
      <button className={styles.primary} type="submit">
        Email me a sign-in link
      </button>
    </form>
  );
}
