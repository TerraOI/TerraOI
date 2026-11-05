import { AuthShell } from "./auth-shell";
import { STATUS_COPY } from "./copy";
import styles from "./sign-in.module.css";
import type { SignInBrand } from "./types";

/** Shown after a magic-link request. Identical whether or not the address has an account. */
export function CheckEmailPage({ brand }: { brand: SignInBrand }) {
  return (
    <AuthShell brand={brand}>
      <h1 className={styles.heading}>Check your email</h1>
      <p className={styles.body}>{STATUS_COPY.link_sent}</p>
    </AuthShell>
  );
}
