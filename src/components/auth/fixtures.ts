// Fixture brands for tests and the /dev/sign-in preview. Values come from the brand kit;
// nothing here imports from brand/ (FAQ-0001). Real tenants get their brand from T-103.
import type { SignInBrand } from "./types";

export const terraoiBrand: SignInBrand = {
  name: "TerraOI",
  tagline: "AI operations for air, surface, and subsurface.",
  logoUrl: "/brand/terraoi-mark.svg",
  primary: "#007F78",
  onPrimary: "#FFFFFF",
  accent: "#A48748",
  showPoweredBy: false,
  supportLabel: "Contact your workspace administrator",
};

const company1Base = {
  name: "Company1",
  tagline: "Your operational workspace.",
  logoUrl: "/dev/company1-logo.svg",
  primary: "#183B66",
  onPrimary: "#FFFFFF",
  accent: "#637D99",
  supportLabel: "Contact your workspace administrator",
} as const;

export const company1Powered: SignInBrand = { ...company1Base, showPoweredBy: true };
export const company1Customer: SignInBrand = { ...company1Base, showPoweredBy: false };
