import type { BrandMode } from "./brand-rules";
import type { TenantBrand } from "./tenant-brand";

/**
 * T-204's mode contract: for one validated `TenantBrand`, what each surface is allowed to show.
 *
 * The three modes are fixed by the plan and the kit, and this file adds no rules of its own:
 *
 * | Mode | Rule | Source |
 * |---|---|---|
 * | `terraoi` | "TerraOI identity for platform-owned surfaces" | plan §5.1 line 262 |
 * | `powered` | "Customer identity with approved Powered by TerraOI attribution" | plan §5.1 line 263 |
 * | `customer` | "Customer identity without visible provider attribution in customer product content" | plan §5.1 line 264 |
 *
 * Two limits on `customer` come from plan §5.1 line 273 and are asserted in
 * [`brand-modes.test.ts`](./brand-modes.test.ts): it "cannot hide the provider name in the required
 * `company1.terraoi.app` URL or override necessary legal disclosures". So `hostDisplay` is the
 * resolved host in every mode, and the `legal` surface keeps `providerNameRequired`.
 *
 * What this module deliberately does **not** do:
 *
 * - **It does not render anything.** The surfaces are described; wiring login, shell, chat and email
 *   to them is slice 2, which waits on the PRs already inside those directories (#173, #139, T-131).
 *   Landing the contract first is what keeps slice 2 from inventing three per-surface vocabularies —
 *   the divergence ADR-0004 §3 warns about.
 * - **It takes no request state.** Mode comes from the validated brand, which comes from the host.
 *   `branding-boundary.test.ts` fails the build if this directory mentions a query string, a cookie
 *   or a header, so a public brand selector has nowhere to enter (plan §5.1 line 261).
 * - **It does not decide the brand's own validity.** Colors, contrast, assets, placeholders and the
 *   host/mode pairing are enforced by `tenant-brand.ts` before a `TenantBrand` exists at all.
 */

/**
 * The surfaces plan §5.1 line 271 lists. `metadata` covers "browser titles/social metadata,
 * manifest/icon behavior"; `legal` is the surface `/privacy` occupies on `main` today, named after
 * §5.1's "necessary legal disclosures" rather than after a page. Printed reports and document
 * metadata are absent on purpose: T-204 puts them out of scope.
 */
export type BrandSurface = "login" | "shell" | "chatEmpty" | "chatError" | "email" | "metadata" | "legal";

export const BRAND_SURFACES: readonly BrandSurface[] = ["login", "shell", "chatEmpty", "chatError", "email", "metadata", "legal"];

/** Where the "Powered by TerraOI" line may appear. `legal` text is a disclosure, not a credit. */
const ATTRIBUTION_SURFACES: readonly BrandSurface[] = BRAND_SURFACES.filter((surface) => surface !== "legal");

export type BrandSurfaceContract = {
  surface: BrandSurface;
  mode: BrandMode;
  /** What the surface calls the product. Never the provider, unless the provider is the product. */
  productName: string;
  /** Same field name as `SignInBrand.showPoweredBy`, so surfaces do not grow a third vocabulary. */
  showPoweredBy: boolean;
  /** Always the resolved host. A customer-mode surface may restyle it, never replace it. */
  hostDisplay: string;
  /** False only where the provider must not appear in product content: `customer` mode. */
  mayNameProviderInProductContent: boolean;
  /** True on the legal surface, where the provider must be named whatever the mode is. */
  providerNameRequired: boolean;
};

export function brandSurfaceContract(brand: TenantBrand, surface: BrandSurface): BrandSurfaceContract {
  return {
    surface,
    mode: brand.mode,
    productName: brand.displayName,
    showPoweredBy: brand.showPoweredBy && ATTRIBUTION_SURFACES.includes(surface),
    hostDisplay: brand.host,
    // The only mode-dependent rule in this file: `customer` keeps the provider out of product
    // content (plan §5.1 line 264) but never out of the legal surface (§5.1 line 273).
    mayNameProviderInProductContent: brand.mode !== "customer" || surface === "legal",
    providerNameRequired: surface === "legal",
  };
}

export type ProviderReference = { index: number; text: string; exempt: boolean };

export type ProductContentVerdict = { ok: boolean; references: ProviderReference[] };

/**
 * "Search visible customer output and metadata for unintended TerraOI references" is the kit's own
 * acceptance step, done by hand across every screen in every mode. This is that step as a function,
 * so a surface can assert its own text instead of a reviewer asserting it at release.
 *
 * The match is bounded on both sides, because an unbounded substring match is worse than a miss: it
 * would flag a customer genuinely named "TerraOils Ltd", telling a company its own name is not
 * allowed in its own product.
 */
const PROVIDER_TERMS: readonly string[] = ["terraoi"];

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The required host is not a leak: plan §5.1 line 273 says a customer cannot hide it, so a provider
 * reference inside it is exempt by rule rather than by oversight.
 */
function isInsideRequiredHost(host: string, text: string, index: number): boolean {
  if (host.length === 0) return false;
  const hostPattern = new RegExp(escapeForRegExp(host), "gi");
  for (let match = hostPattern.exec(text); match !== null; match = hostPattern.exec(text)) {
    if (index >= match.index && index < match.index + host.length) return true;
  }
  return false;
}

function findReferences(text: string): { index: number; text: string }[] {
  const pattern = new RegExp(PROVIDER_TERMS.map(escapeForRegExp).join("|"), "gi");
  const found: { index: number; text: string }[] = [];
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const before = match.index > 0 ? text[match.index - 1] ?? "" : "";
    const after = text[match.index + match[0].length] ?? "";
    if (/[A-Za-z0-9]/.test(before) || /[A-Za-z0-9]/.test(after)) continue;
    found.push({ index: match.index, text: match[0] });
  }
  return found;
}

/**
 * Would this text, on this surface, put the provider's name where the mode forbids it? Exempt
 * references are still reported, because a reviewer reading a failure needs to see what was counted
 * and what was not.
 */
export function checkProductContent(brand: TenantBrand, surface: BrandSurface, text: string): ProductContentVerdict {
  const contract = brandSurfaceContract(brand, surface);
  const references: ProviderReference[] = findReferences(text).map((reference) => ({
    ...reference,
    exempt: isInsideRequiredHost(brand.host, text, reference.index),
  }));

  if (references.length === 0) return { ok: true, references };
  if (contract.mayNameProviderInProductContent) return { ok: true, references };
  return { ok: references.every((reference) => reference.exempt), references };
}
