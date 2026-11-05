import { AuthShell } from "./auth-shell";
import styles from "./sign-in.module.css";
import type { SignInBrand } from "./types";

// For a host that maps to no tenant. It takes no brand prop on purpose: nothing about any
// tenant may show here, so the page cannot confirm or deny which workspaces exist.
// TerraOI-branded by supervisor ruling (2026-11-05, PR #20), even on white-label custom domains.
const TERRAOI_BRAND: SignInBrand = {
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
    <AuthShell brand={TERRAOI_BRAND}>
      <h1 className={styles.heading}>Workspace not found</h1>
      <p className={styles.body}>This address is not recognized.</p>
    </AuthShell>
  );
}
