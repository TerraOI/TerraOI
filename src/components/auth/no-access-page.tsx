import { AuthShell } from "./auth-shell";
import styles from "./sign-in.module.css";
import type { SignInBrand } from "./types";

// Same text as SAFE_FAILURE_MESSAGE.not_a_member in src/platform/tenancy/ (T-101). Duplicated
// because T-101 is not on main yet; import it from there once it is.
export const NO_ACCESS_COPY = "You do not have access to this workspace.";

export function NoAccessPage({ brand }: { brand: SignInBrand }) {
  return (
    <AuthShell brand={brand}>
      <h1 className={styles.heading}>No access</h1>
      <p className={styles.body}>{NO_ACCESS_COPY}</p>
    </AuthShell>
  );
}
