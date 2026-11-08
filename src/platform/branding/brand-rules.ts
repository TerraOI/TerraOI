/**
 * The rules every brand value passes through before it can reach a customer-visible surface
 * (plan §5.1 line 269: "Validate colors/assets/URLs; sanitize or reject uploaded SVG/HTML;
 * validate actual contrast. Do not permit arbitrary CSS or scripts", and
 * [T-103](../../../docs/tasks/T-103-tenant-shell-brand.md)'s negative acceptance boxes).
 *
 * These are deliberately dumb, total functions: no I/O, no throwing, and every rejection names a
 * reason class rather than echoing the offending value. A reason that echoes a value is how one
 * customer's name ends up in another customer's error page.
 */

export type BrandMode = "terraoi" | "powered" | "customer";

export const BRAND_MODES: readonly BrandMode[] = ["terraoi", "powered", "customer"];

/**
 * What a *tenant* may choose. `terraoi` is reserved for platform-owned surfaces (plan §5.1 line
 * 262: "`terraoi` | TerraOI identity for platform-owned surfaces"), so a tenant row asking for it
 * is a configuration error, not a supported setting. A tenant with no valid row still *shows*
 * platform branding through the fallback - that is the packet's failure box, not a mode.
 */
export const TENANT_BRAND_MODES: readonly BrandMode[] = ["powered", "customer"];

/**
 * WCAG 2.1 SC 1.4.3: 4.5:1 for normal text. `onPrimary` is body-size label text drawn on the
 * primary fill, so this is the pair that threshold governs. The choice of WCAG AA (rather than a
 * TerraOI-specific number) is a stated assumption in the PR: changing it edits one constant.
 */
export const CONTRAST_MIN_RATIO = 4.5;

/** WCAG 2.1 SC 1.4.11: 3:1 for non-text items - an accent rule, icon stroke or link color. */
export const ACCENT_CONTRAST_MIN_RATIO = 3;

/**
 * The surface accent-colored UI is drawn on, when the caller does not pass the kit token. The kit's
 * `02-system/tokens.json` says `semantic.surface` is `#FFFFFF`, and `kit-brand.ts` passes the real
 * token through, so this default only matters to callers that have no token handy.
 */
export const DEFAULT_SURFACE_COLOR = "#FFFFFF";

/**
 * Upper bound on a customer-supplied brand asset. plan §5.1 says to reject oversized SVG/HTML but
 * never fixes a number; 64 KiB is a stated assumption (question opened by this PR), and the kit's
 * own shipped artwork fits inside it, which `kit-brand.test.ts` measures rather than asserts.
 */
export const MAX_BRAND_ASSET_BYTES = 65_536;

/** Extensions a brand asset may have. `html` is deliberately absent: a brand asset is an image. */
export const BRAND_ASSET_EXTENSIONS: readonly string[] = ["svg", "png", "ico"];

/**
 * The kit's unfilled template values. WHITE-LABEL.md:17 - "Replace all Customer Brand placeholders
 * before delivery" - so a source still carrying one of these is a template, not a brand. Matched
 * exactly and case-folded, so a company genuinely named "Customer Service Ltd" is not rejected.
 */
const KIT_PLACEHOLDER_VALUES = new Set(["customer brand", "customer", "customer ops"]);

const MUSTACHE = /\{\{[^}]*\}\}/;

export function tenantModeIsAllowed(mode: unknown): boolean {
  return (TENANT_BRAND_MODES as readonly unknown[]).includes(mode);
}

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

/**
 * Only `#RRGGBB` survives. A named color, an `rgb()` expression, or a value carrying a semicolon
 * is the door through which arbitrary CSS reaches a customer page, so nothing else parses.
 */
export function parseHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!HEX_COLOR.test(value)) return null;
  return value.toUpperCase();
}

function channelLuminance(channel255: number): number {
  const srgb = channel255 / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 relative luminance. Null for anything that is not a parsed hex color. */
export function relativeLuminance(color: string | null): number | null {
  if (color === null) return null;
  const hex = color.slice(1);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/**
 * The WCAG contrast ratio of two colors, order-independent. NaN when either side is not a color -
 * callers must use `meetsContrast`, which turns that into a refusal instead of a comparison
 * against NaN that would silently pass.
 */
export function contrastRatio(a: unknown, b: unknown): number {
  const la = relativeLuminance(parseHexColor(a));
  const lb = relativeLuminance(parseHexColor(b));
  if (la === null || lb === null) return Number.NaN;
  const [light, dark] = la >= lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
}

export type ContrastVerdict = { ok: boolean; ratio: number | null };

/** A malformed color is a failed contrast check, never an exception and never a pass. */
export function meetsContrast(foreground: unknown, background: unknown, min: number = CONTRAST_MIN_RATIO): ContrastVerdict {
  const ratio = contrastRatio(foreground, background);
  if (Number.isNaN(ratio)) return { ok: false, ratio: null };
  return { ok: ratio >= min, ratio };
}

/** `{{company}}`, `{{ region }}`, or a kit template value that was never replaced. */
export function hasUnresolvedPlaceholder(value: unknown): boolean {
  if (typeof value !== "string") return true;
  if (MUSTACHE.test(value)) return true;
  return KIT_PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
}

/**
 * https only, no credentials in the authority, no scheme-relative or protocol-relative forms.
 * A support link is rendered into a customer's page, so `javascript:` and `http:` are refused here
 * rather than "fixed up" - and an `@` in the authority is refused because browsers accept
 * `https://admin:pw@host/` while readers do not.
 */
export function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username !== "" || url.password !== "") return false;
  if (url.hostname === "" || !url.hostname.includes(".")) return false;
  return true;
}

/**
 * What the caller that *read* the asset reports about it. `bytes` unmeasured means unmeasured: the
 * limit cannot be cleared by a guess, so an unmeasured asset is refused. `containsScript` is set by
 * whoever scanned the content; SVG with a script element or an event handler is refused outright
 * (plan §5.1 "sanitize or reject uploaded SVG/HTML").
 */
export type BrandAssetFact = { path: string; bytes?: number; containsScript?: boolean };

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  return path.slice(dot + 1).toLowerCase();
}

/**
 * Returns a human-safe problem description, or null when the asset clears every rule. The words
 * `path`, `type`, `size` and `content` are part of the contract: the tests and the admin copy map
 * them to reasons.
 */
export function assetFactProblem(fact: unknown): string | null {
  if (typeof fact !== "object" || fact === null) return "asset path is missing";
  const candidate = fact as { path?: unknown; bytes?: unknown; containsScript?: unknown };
  if (typeof candidate.path !== "string" || candidate.path.length === 0) return "asset path is missing";
  const path = candidate.path;
  // Paths are relative to the brand asset root (WHITE-LABEL.md:15), never absolute, never a URL,
  // never a data: URI, and never allowed to climb out with "..".
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return `asset path must be relative to the brand root, not a URL or data reference: ${path}`;
  if (path.startsWith("/") || path.startsWith("\\")) return `asset path must be relative to the brand root: ${path}`;
  if (path.split(/[\\/]/).some((segment) => segment === "..")) return `asset path escapes the brand root: ${path}`;
  if (/\s/.test(path)) return "asset path must not contain whitespace";
  const extension = extensionOf(path);
  if (!BRAND_ASSET_EXTENSIONS.includes(extension)) return `asset type is not allowed: .${extension || "(none)"}`;
  if (typeof candidate.bytes !== "number" || !Number.isFinite(candidate.bytes) || !Number.isInteger(candidate.bytes) || candidate.bytes <= 0) {
    return `asset size was not measured for ${path}`;
  }
  if (candidate.bytes > MAX_BRAND_ASSET_BYTES) return `asset size exceeds the limit of ${MAX_BRAND_ASSET_BYTES} bytes for ${path}`;
  if (candidate.containsScript === true) return `asset content for ${path} carries a script or event handler`;
  return null;
}

/** Field length ceilings, from the kit's own template fields; long enough for any real company. */
export const BRAND_TEXT_LIMITS = {
  displayName: 80,
  descriptor: 120,
  tagline: 200,
  supportLabel: 160,
  reportOwner: 80,
  emailSenderName: 80,
} as const;

/** A document prefix becomes a filename stem: uppercase alnum with dots and dashes only. */
export const DOCUMENT_PREFIX_SHAPE = /^[A-Z0-9][A-Z0-9.-]{1,11}$/;
