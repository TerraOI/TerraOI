import { brandAssetUrl } from "./brand-source";
import type { TenantBrand } from "./tenant-brand";

/**
 * Structural twin of `SignInBrand` in `src/components/auth/types.ts` (ADR-0004 §3).
 * Defined here so branding never imports UI modules (`branding-boundary.test.ts`).
 */
export type SignInBrandFields = {
  name: string;
  tagline: string;
  logoUrl: string;
  primary: string;
  onPrimary: string;
  accent: string;
  showPoweredBy: boolean;
  supportLabel: string;
};

/**
 * Projects the validated `TenantBrand` onto the presentational sign-in props shape
 * (ADR-0004 §3). One place only — pages and T-204 must not hand-write the mapping.
 *
 * Tenant logos arrive as versioned paths (`{configVersion}/{name}`); those become
 * `/brand-assets/...` via `brandAssetUrl`. Platform fallback has a null logo path.
 */
export function toSignInBrand(brand: TenantBrand): SignInBrandFields {
  return {
    name: brand.displayName,
    tagline: brand.tagline,
    logoUrl: brandAssetUrl(brand.logoPath) ?? brand.logoPath ?? "",
    primary: brand.primary,
    onPrimary: brand.onPrimary,
    accent: brand.accent,
    showPoweredBy: brand.showPoweredBy,
    supportLabel: brand.supportLabel,
  };
}
