import { AuthShell } from "./auth-shell";
import styles from "./sign-in.module.css";
import type { SignInBrand } from "./types";

// For a host that maps to no tenant. It takes no brand prop on purpose: nothing about any
// tenant may show here, so the page cannot confirm or deny which workspaces exist.
const NEUTRAL_BRAND: SignInBrand = {
  name: "TerraOI",
  tagline: "AI operations for air, surface, and subsurface.",
  logoUrl: "",
  primary: "#007F78",
  onPrimary: "#FFFFFF",
  accent: "#A48748",
  showPoweredBy: false,
  supportLabel: "Check the address and try again.",
};

export function UnknownAddressPage() {
  return (
    <AuthShell brand={NEUTRAL_BRAND}>
      <h1 className={styles.heading}>Workspace not found</h1>
      <p className={styles.body}>This address is not recognized.</p>
    </AuthShell>
  );
}
