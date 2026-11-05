// Fixture brands for tests and the /dev/sign-in preview. Values come from the brand kit;
// nothing here imports from brand/ (FAQ-0001). Real tenants get their brand from T-103.
import type { SignInBrand } from "./types";

// Inline SVG logos so the preview needs nothing in public/ (T-103 owns it). Real tenant logos
// are same-origin or https URLs validated by T-103; data: URIs are for these fixtures only.
function svgLogo(fill: string, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="32" viewBox="0 0 128 32"><rect width="32" height="32" rx="6" fill="${fill}"/><text x="40" y="22" font-family="Inter,sans-serif" font-size="16" font-weight="600" fill="#17252B">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const terraoiBrand: SignInBrand = {
  name: "TerraOI",
  tagline: "AI operations for air, surface, and subsurface.",
  logoUrl: svgLogo("#007F78", "TerraOI"),
  primary: "#007F78",
  onPrimary: "#FFFFFF",
  accent: "#A48748",
  showPoweredBy: false,
  supportLabel: "Contact your workspace administrator",
};

const company1Base = {
  name: "Company1",
  tagline: "Your operational workspace.",
  logoUrl: svgLogo("#183B66", "Company1"),
  primary: "#183B66",
  onPrimary: "#FFFFFF",
  accent: "#637D99",
  supportLabel: "Contact your workspace administrator",
} as const;

export const company1Powered: SignInBrand = { ...company1Base, showPoweredBy: true };
export const company1Customer: SignInBrand = { ...company1Base, showPoweredBy: false };
