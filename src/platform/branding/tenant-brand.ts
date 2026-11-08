import { z } from "zod";

import { parseHost } from "@/platform/tenancy/host";
import {
  ACCENT_CONTRAST_MIN_RATIO,
  BRAND_TEXT_LIMITS,
  CONTRAST_MIN_RATIO,
  DEFAULT_SURFACE_COLOR,
  DOCUMENT_PREFIX_SHAPE,
  assetFactProblem,
  hasUnresolvedPlaceholder,
  isHttpsUrl,
  meetsContrast,
  parseHexColor,
  tenantModeIsAllowed,
} from "./brand-rules";

/**
 * The one validated brand object (plan §5.1 line 269, F04). T-103's packet says the `TenantBrand`
 * contract "lands with this packet in `src/contracts/tenant-brand.ts` - **needs an ADR**"; that ADR
 * is [ADR-0004](../../../docs/decisions/0004-tenant-brand-contract.md), which is still **proposed**
 * and blocked on #62, #65 and #55. So this type lives in the platform module, not in
 * `src/contracts/`, and the packet's own interim instruction is followed: build against
 * `TenantContext` and the kit sources, read only through `src/platform/branding/`.
 *
 * What this file deliberately does **not** carry:
 *
 * - `locale` / `timezone`: the `organisations.locale` CHECK is being questioned in #67, and a brand
 *   object that pre-empted it would be a second source of truth;
 * - a verified email sender or reply-to address: #64 says no packet owns the outbound transport,
 *   and plan §5.1 line 271 is explicit that "a display name does not establish domain
 *   authorization". The *display* name is here; the address is validated and then dropped.
 *
 * Adding either field is a contract change and needs the ADR accepted first (AGENTS.md §6).
 */

const BrandAssetSchema = z.strictObject({
  path: z.string().min(1).max(300),
  bytes: z.number().int().nonnegative().optional(),
  containsScript: z.boolean().optional(),
});

/**
 * Strict on purpose: an unknown key is refused rather than ignored, because "ignored" is how a
 * query parameter naming a brand would travel from a URL into a brand object on its way to the page.
 */
export const BrandSourceSchema = z.strictObject({
  mode: z.enum(["terraoi", "powered", "customer"]),
  displayName: z.string().min(1).max(BRAND_TEXT_LIMITS.displayName),
  descriptor: z.string().min(1).max(BRAND_TEXT_LIMITS.descriptor),
  tagline: z.string().max(BRAND_TEXT_LIMITS.tagline),
  logo: BrandAssetSchema.optional(),
  favicon: BrandAssetSchema.optional(),
  primary: z.string(),
  onPrimary: z.string(),
  accent: z.string(),
  showPoweredBy: z.boolean(),
  supportLabel: z.string().min(1).max(BRAND_TEXT_LIMITS.supportLabel),
  supportUrl: z.string().max(400).optional(),
  reportOwner: z.string().min(1).max(BRAND_TEXT_LIMITS.reportOwner),
  emailSenderName: z.string().min(1).max(BRAND_TEXT_LIMITS.emailSenderName),
  emailReplyTo: z.string().max(254).optional(),
  documentPrefix: z.string().min(2).max(12),
});

export type BrandSource = z.infer<typeof BrandSourceSchema>;

/** The validated output. Everything downstream of this packet reads only these fields. */
export const TenantBrandSchema = z.strictObject({
  host: z.string().min(1).max(253),
  mode: z.enum(["terraoi", "powered", "customer"]),
  displayName: z.string().min(1).max(BRAND_TEXT_LIMITS.displayName),
  descriptor: z.string().min(1).max(BRAND_TEXT_LIMITS.descriptor),
  tagline: z.string().max(BRAND_TEXT_LIMITS.tagline),
  logoPath: z.string().max(300).nullable(),
  faviconPath: z.string().max(300).nullable(),
  primary: z.string().regex(/^#[0-9A-F]{6}$/),
  onPrimary: z.string().regex(/^#[0-9A-F]{6}$/),
  accent: z.string().regex(/^#[0-9A-F]{6}$/),
  showPoweredBy: z.boolean(),
  supportLabel: z.string().min(1).max(BRAND_TEXT_LIMITS.supportLabel),
  supportUrl: z.string().url().nullable(),
  reportOwner: z.string().min(1).max(BRAND_TEXT_LIMITS.reportOwner),
  emailSenderName: z.string().min(1).max(BRAND_TEXT_LIMITS.emailSenderName),
  documentPrefix: z.string().regex(DOCUMENT_PREFIX_SHAPE),
});

export type TenantBrand = z.infer<typeof TenantBrandSchema>;

export type BrandFallbackReason = "unknown_host" | "no_brand_row" | "invalid_brand" | "source_error";

export const ResolvedBrandSchema = z.strictObject({
  brand: TenantBrandSchema,
  origin: z.enum(["tenant", "platform"]),
  fallback: z.strictObject({ reason: z.enum(["unknown_host", "no_brand_row", "invalid_brand", "source_error"]), note: z.string() }).nullable(),
});

export type ResolvedBrand = z.infer<typeof ResolvedBrandSchema>;

/**
 * Reason *classes*, never the offending value. `invalid_brand` responses are handed to an admin
 * surface (T-202) and, in the worst case, logged; a reason that quoted the value would be a route
 * by which one tenant's configuration text appears in another tenant's diagnostics.
 */
export type BrandRejectReason =
  | "shape"
  | "host"
  | "mode_not_allowed"
  | "color"
  | "contrast"
  | "placeholder"
  | "attribution"
  | "prefix"
  | "support_url"
  | "reply_to"
  | "asset_path"
  | "asset_size"
  | "asset_type"
  | "asset_content";

export type BrandParse = { ok: true; brand: TenantBrand } | { ok: false; reasons: BrandRejectReason[] };

function assetReason(problem: string): BrandRejectReason {
  if (problem.includes("size")) return "asset_size";
  if (problem.includes("type")) return "asset_type";
  if (problem.includes("content")) return "asset_content";
  return "asset_path";
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export type ParseBrandOptions = { surfaceColor?: string };

/**
 * Validates one brand source for one host. Every problem found is reported at once, so fixing the
 * first one does not uncover a second one in production the next day.
 */
export function parseTenantBrand(host: unknown, input: unknown, options: ParseBrandOptions = {}): BrandParse {
  const reasons: BrandRejectReason[] = [];
  const surface = options.surfaceColor ?? DEFAULT_SURFACE_COLOR;

  const hostParse = parseHost(typeof host === "string" ? host : null);
  if (!hostParse.ok) {
    // A host that is not exactly what the router sent us can never own a brand. This is the same
    // rule F01 applies to tenancy (plan §4.1 step 1), applied one layer down.
    return { ok: false, reasons: ["host"] };
  }

  const parsed = BrandSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reasons: ["shape"] };
  const source = parsed.data;

  if (hostParse.class === "tenant" ? !tenantModeIsAllowed(source.mode) : source.mode !== "terraoi") {
    reasons.push("mode_not_allowed");
  }

  const primary = parseHexColor(source.primary);
  const onPrimary = parseHexColor(source.onPrimary);
  const accent = parseHexColor(source.accent);
  for (const color of [primary, onPrimary, accent]) {
    if (color === null) reasons.push("color");
  }

  if (primary !== null && onPrimary !== null && !meetsContrast(onPrimary, primary, CONTRAST_MIN_RATIO).ok) reasons.push("contrast");
  if (accent !== null && !meetsContrast(accent, surface, ACCENT_CONTRAST_MIN_RATIO).ok) reasons.push("contrast");

  const textFields: Array<[keyof typeof BRAND_TEXT_LIMITS, string]> = [
    ["displayName", source.displayName],
    ["descriptor", source.descriptor],
    ["tagline", source.tagline],
    ["supportLabel", source.supportLabel],
    ["reportOwner", source.reportOwner],
    ["emailSenderName", source.emailSenderName],
  ];
  for (const [, value] of textFields) {
    if (hasUnresolvedPlaceholder(value)) reasons.push("placeholder");
  }
  if (hasUnresolvedPlaceholder(source.documentPrefix)) reasons.push("placeholder");

  if (!DOCUMENT_PREFIX_SHAPE.test(source.documentPrefix)) reasons.push("prefix");

  // WHITE-LABEL.md:17 makes attribution a hard rule per mode, and plan §5.1 the same: attribution is
  // visible in powered mode, hidden in customer and terraoi modes.
  const attributionExpected = source.mode === "powered";
  if (source.showPoweredBy !== attributionExpected) reasons.push("attribution");

  if (source.supportUrl !== undefined && !isHttpsUrl(source.supportUrl)) reasons.push("support_url");
  if (source.emailReplyTo !== undefined && source.emailReplyTo !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(source.emailReplyTo)) {
    reasons.push("reply_to");
  }

  let logoPath: string | null = null;
  let faviconPath: string | null = null;
  for (const [slot, fact] of [["logo", source.logo], ["favicon", source.favicon]] as const) {
    if (fact === undefined) continue;
    const problem = assetFactProblem(fact);
    if (problem !== null) {
      reasons.push(assetReason(problem));
      continue;
    }
    if (slot === "logo") logoPath = fact.path;
    else faviconPath = fact.path;
  }

  if (reasons.length > 0) return { ok: false, reasons };

  const brand: TenantBrand = {
    host: hostParse.host,
    mode: source.mode,
    displayName: source.displayName,
    descriptor: source.descriptor,
    tagline: source.tagline,
    logoPath,
    faviconPath,
    primary: primary as string,
    onPrimary: onPrimary as string,
    accent: accent as string,
    showPoweredBy: source.showPoweredBy,
    supportLabel: source.supportLabel,
    supportUrl: source.supportUrl ?? null,
    reportOwner: source.reportOwner,
    emailSenderName: source.emailSenderName,
    documentPrefix: source.documentPrefix,
  };

  // Re-parsed on the way out so the type this function hands back is the type the cache and the
  // components rely on, and so a future edit cannot make this a pass-through.
  return { ok: true, brand: deepFreeze(TenantBrandSchema.parse(brand)) };
}
