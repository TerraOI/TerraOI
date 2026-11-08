import { z } from "zod";

import brandConfigJson from "../../../brand/terraoi-brand-kit/02-system/brand-config.json";
import tokensJson from "../../../brand/terraoi-brand-kit/02-system/tokens.json";

import { BRAND_MODES, type BrandMode } from "./brand-rules";
import { parseTenantBrand, type BrandSource, type TenantBrand } from "./tenant-brand";

/**
 * The only file in this repository allowed to read the brand kit sources
 * ([brand/README.md](../../../brand/README.md) rule 1, [FAQ-0001](../../../docs/FAQ.md):
 * "`src/platform/branding/` reads `tokens.json` and `brand-config.json`, validates them against the
 * `TenantBrand` contract, and the app uses that"). `branding-boundary.test.ts` fails the build if a
 * second reader appears or if anything outside this module mentions the kit path.
 *
 * The import is a **build-time** read. The Worker never opens these files: there is no filesystem
 * at runtime, so the values are compiled into the bundle. That is also why a kit edit cannot quietly
 * change what a customer sees without a reviewed PR - the kit is a protected path.
 */

const KIT_MODE_ORDER: readonly BrandMode[] = BRAND_MODES;

/** The host the platform brand is *defined* for. Every platform and admin host renders this brand. */
export const PLATFORM_BRAND_HOST = "terraoi.app";

const KitModeEntry = z.strictObject({
  name: z.string().min(1),
  descriptor: z.string().min(1),
  tagline: z.string(),
  logo: z.string(),
  favicon: z.string(),
  primary: z.string(),
  onPrimary: z.string(),
  accent: z.string(),
  showPoweredBy: z.boolean(),
  supportLabel: z.string(),
  reportOwner: z.string(),
  emailSenderName: z.string(),
  emailReplyTo: z.string(),
  documentPrefix: z.string(),
});

const KitConfig = z.strictObject({
  version: z.string(),
  defaultMode: z.enum(["terraoi", "powered", "customer"]),
  modes: z.strictObject({ terraoi: KitModeEntry, powered: KitModeEntry, customer: KitModeEntry }),
});

/**
 * `semantic` is strict because the brand contract reads exactly those names; the file itself is
 * loose because the palette, typography, spacing and status tokens are consumed by the generated
 * stylesheet, not by this contract.
 */
const KitTokens = z.looseObject({
  version: z.string(),
  semantic: z.strictObject({
    primary: z.string(),
    accent: z.string(),
    text: z.string(),
    muted: z.string(),
    surface: z.string(),
    canvas: z.string(),
    border: z.string(),
    onPrimary: z.string(),
  }),
});

/**
 * Fail closed on a malformed kit. A kit that does not parse is a broken design source, and the
 * platform brand is what every login page, error page and empty state falls back to - rendering a
 * half-brand would be worse than a loud start-up failure in a reviewed build.
 */
const kitConfig = KitConfig.parse(brandConfigJson);
const kitTokens = KitTokens.parse(tokensJson);

export const BRAND_KIT_VERSION = kitConfig.version;
export const BRAND_TOKEN_VERSION = kitTokens.version;

/** The kit's `semantic.surface`, which is what an accent color has to be legible against. */
export const BRAND_SURFACE_COLOR = kitTokens.semantic.surface;

/**
 * Maps one kit mode entry onto the source shape. The kit's `logo` and `favicon` paths are **not**
 * carried: `public/` is empty and the platform artwork already ships as JSX
 * ([src/components/site/logo-wordmark.tsx](../../components/site/logo-wordmark.tsx), "the kit's
 * terraoi-logo-color.svg as JSX, geometry unchanged"). Serving kit files as HTTP assets is a
 * separate decision, asked in this PR rather than guessed here. The kit's own SVG sizes and
 * script-freeness are still measured, in `kit-brand.test.ts`, so the size budget is not
 * platform-exempt.
 */
export function kitBrandSourceForMode(mode: BrandMode): BrandSource {
  const entry = kitConfig.modes[mode];
  return {
    mode,
    displayName: entry.name,
    descriptor: entry.descriptor,
    tagline: entry.tagline,
    primary: entry.primary,
    onPrimary: entry.onPrimary,
    accent: entry.accent,
    showPoweredBy: entry.showPoweredBy,
    supportLabel: entry.supportLabel,
    reportOwner: entry.reportOwner,
    emailSenderName: entry.emailSenderName,
    emailReplyTo: entry.emailReplyTo,
    documentPrefix: entry.documentPrefix,
  };
}

export function kitModeNames(): BrandMode[] {
  // Fixed order rather than key order, so a consumer never depends on how JSON was parsed.
  return KIT_MODE_ORDER.filter((mode) => Object.prototype.hasOwnProperty.call(kitConfig.modes, mode));
}

let cachedPlatformBrand: TenantBrand | null = null;

/**
 * The validated `terraoi` mode brand. Memoized: this is a pure function of reviewed build input, so
 * parsing it once per isolate is the whole point of the public cache in plan §4.4.
 */
export function platformBrand(): TenantBrand {
  if (cachedPlatformBrand !== null) return cachedPlatformBrand;
  const parsed = parseTenantBrand(PLATFORM_BRAND_HOST, kitBrandSourceForMode(kitConfig.defaultMode), {
    surfaceColor: BRAND_SURFACE_COLOR,
  });
  if (!parsed.ok) {
    // Reasons only: never the offending values, and never a stack that quotes the kit's contents.
    throw new Error(`brand kit does not satisfy the brand contract: ${parsed.reasons.join(", ")}`);
  }
  cachedPlatformBrand = parsed.brand;
  return cachedPlatformBrand;
}

/** A platform brand stamped with the host it is being served on, for host-keyed caching. */
export function platformBrandForHost(host: string): TenantBrand {
  const base = platformBrand();
  if (base.host === host) return base;
  return Object.freeze({ ...base, host });
}
