import { z } from "zod";

/**
 * The tenant brand contract (ADR-0004, accepted under #62, #65 and #188; plan §5.1 lines 261–273,
 * §4.4, F04). The validator, loader and cache in `src/platform/branding/` build on these types, and
 * `SignInBrand` (`src/components/auth/types.ts`) stays a component projection, mapped by one pure
 * function (`src/platform/branding/sign-in-brand.ts`, ADR-0004 §3).
 *
 * Deliberately not representable here:
 * - any sender address, sending domain or credential: that is T-105's transport configuration (#64);
 * - `locale` and `timezone`: they join `PublicBrand` from `organisations` once #67's migration
 *   merges, and are never copied into `tenant_brands`.
 */

/** Plan §5.1 line 261. `terraoi` is the platform identity, never a tenant's choice (#62). */
export const BRAND_MODES = ["terraoi", "powered", "customer"] as const;
export const BrandMode = z.enum(BRAND_MODES);
export type BrandMode = z.infer<typeof BrandMode>;

/** The only modes a `tenant_brands` row may hold (`check (mode in ('powered','customer'))`, #62). */
export const TENANT_BRAND_MODES = ["powered", "customer"] as const;
export const TenantBrandMode = z.enum(TENANT_BRAND_MODES);
export type TenantBrandMode = z.infer<typeof TenantBrandMode>;

/** Attribution is derived from the mode and never stored (WHITE-LABEL.md:17, #188). */
export function showPoweredByFor(mode: BrandMode): boolean {
  return mode === "powered";
}

/**
 * Values of the `data-brand-fact` attribute (#65). In customer mode, routing facts (the host the
 * user is on) and legal facts (privacy notice, processor disclosure) may name TerraOI, and only
 * inside elements carrying one of these markers. Everything else is provider identity.
 */
export const BRAND_FACT_MARKERS = { routing: "routing", legal: "legal" } as const;
export type BrandFactMarker = (typeof BRAND_FACT_MARKERS)[keyof typeof BRAND_FACT_MARKERS];

/** Length ceilings shared by the validator and the `tenant_brands` CHECKs (brand_config.sql). */
export const BRAND_TEXT_LIMITS = {
  displayName: 80,
  descriptor: 120,
  tagline: 200,
  supportLabel: 160,
  reportOwner: 80,
  emailSenderName: 80,
  legalName: 200,
} as const;

/** `TOI`, `CUSTOMER`: uppercase, 2–12 characters, used in report and export identifiers. */
export const DOCUMENT_PREFIX_SHAPE = /^[A-Z0-9][A-Z0-9.-]{1,11}$/;

/** Normalized `#RRGGBB`. No named colour, no `rgb()`, nothing that can carry CSS (§5.1 line 269). */
const BrandColor = z.string().regex(/^#[0-9A-F]{6}$/);

/** A versioned asset reference, `<configVersion>/<name>`, served by `/brand-assets/` (FAQ-0008). */
const BrandAssetPath = z.string().min(1).max(300);

const HttpsUrl = z
  .string()
  .max(400)
  .url()
  .regex(/^https:\/\/\S+$/);

/**
 * The pre-sign-in projection: what a visitor to the tenant's own host may see (#62, #188). Never
 * carries `legalName`, `configVersion`, a reply-to address or anything membership-derived.
 */
export const PublicBrand = z.strictObject({
  mode: BrandMode,
  displayName: z.string().min(1).max(BRAND_TEXT_LIMITS.displayName),
  descriptor: z.string().min(1).max(BRAND_TEXT_LIMITS.descriptor),
  tagline: z.string().max(BRAND_TEXT_LIMITS.tagline),
  logoPath: BrandAssetPath.nullable(),
  faviconPath: BrandAssetPath.nullable(),
  primary: BrandColor,
  onPrimary: BrandColor,
  accent: BrandColor,
  supportLabel: z.string().min(1).max(BRAND_TEXT_LIMITS.supportLabel),
  supportUrl: HttpsUrl.nullable(),
});
export type PublicBrand = z.infer<typeof PublicBrand>;

/**
 * The full server-side shape of one tenant's brand (#188). `emailSenderName` is a display name
 * only: it does not establish domain authorization (§5.1 line 271). `emailReplyTo` is the
 * `email_reply_to` column under ADR-0001's single mapping; #188 calls it `replyTo`.
 */
export const TenantBrand = PublicBrand.extend({
  legalName: z.string().min(1).max(BRAND_TEXT_LIMITS.legalName).nullable(),
  reportOwner: z.string().min(1).max(BRAND_TEXT_LIMITS.reportOwner),
  emailSenderName: z.string().min(1).max(BRAND_TEXT_LIMITS.emailSenderName),
  // The same pattern as the column CHECK and the validator; the column's '' maps to null.
  emailReplyTo: z
    .string()
    .max(254)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/)
    .nullable(),
  documentPrefix: z.string().regex(DOCUMENT_PREFIX_SHAPE),
  configVersion: z.number().int().positive(),
});
export type TenantBrand = z.infer<typeof TenantBrand>;
