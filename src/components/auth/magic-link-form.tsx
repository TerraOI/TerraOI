import styles from "./sign-in.module.css";

export type FormAction = (form: FormData) => void | Promise<void>;

export function MagicLinkForm({ action }: { action: FormAction }) {
  return (
    <form className={styles.form} action={action}>
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
