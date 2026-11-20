import { BRAND_FACT_MARKERS, type BrandMode } from "@/contracts/tenant-brand";

import type { LoadedBrand } from "./tenant-brand";

/** Re-export so existing branding callers keep a single import path (Round-2 B2 / #65). */
export { BRAND_FACT_MARKERS };

/**
 * T-204's mode contract: for one validated `LoadedBrand`, what each surface is allowed to show.
 *
 * Rules: plan §5.1 (mode table; customer presentation cannot hide the required host or override
 * necessary legal disclosures); WHITE-LABEL.md acceptance check; [#65](https://github.com/TerraOI/TerraOI/issues/65)
 * (2026-11-09) — customer mode forbids provider identity; routing/legal facts live only in
 * `data-brand-fact="routing"|"legal"` islands; after those islands are removed, `/terraoi/i` must not
 * appear elsewhere. The substring check stays strict outside those two marked islands.
 *
 * Two things this module deliberately does **not** do:
 *
 * - **It does not render anything.** Surfaces are described; wiring login, shell, chat and email is
 *   slice 2. Landing the contract first keeps slice 2 from inventing three per-surface vocabularies —
 *   the divergence ADR-0004 §3 warns about.
 * - **It takes no request state.** Mode comes from the validated brand, which comes from the host.
 *   `branding-boundary.test.ts` fails the build if this directory mentions a query string, a cookie
 *   or a header, so a public brand selector has nowhere to enter (plan §5.1 line 261).
 *
 * The two island markers live in [`src/contracts/tenant-brand.ts`](../../contracts/tenant-brand.ts)
 * (ADR-0004 / #216), as #65 names. This module re-exports them; it does not redefine them.
 */

/**
 * The surfaces plan §5.1 line 271 lists. `metadata` covers "browser titles/social metadata,
 * manifest/icon behavior"; `legal` is named after §5.1's "necessary legal disclosures" and #65's
 * category 3 ("dedicated legal elements"), not after a page. Printed reports and document metadata
 * are absent on purpose: T-204 puts them out of scope.
 */
export type BrandSurface = "login" | "shell" | "chatEmpty" | "chatError" | "email" | "metadata" | "legal";

export const BRAND_SURFACES: readonly BrandSurface[] = ["login", "shell", "chatEmpty", "chatError", "email", "metadata", "legal"];

/** Where the "Powered by TerraOI" line may appear. `legal` text is a disclosure, not a credit. */
const ATTRIBUTION_SURFACES: readonly BrandSurface[] = BRAND_SURFACES.filter((surface) => surface !== "legal");

/**
 * Surfaces that can carry the host as text. A browser title or a social-metadata tag cannot: it is
 * one line of text and has no element to mark, which is why #65's category 2 does not apply there -
 * and why a title is the surface most likely to leak identity by accident.
 */
const ROUTING_SURFACES: readonly BrandSurface[] = BRAND_SURFACES.filter((surface) => surface !== "metadata");

/** Key of a `data-brand-fact` marker; values come from the contract (#65 / ADR-0004). */
export type BrandFactKind = keyof typeof BRAND_FACT_MARKERS;

/** What a provider reference turned out to be, once classified: one of #65's three categories. */
export type ProviderFactKind = BrandFactKind | "identity";

export type BrandSurfaceContract = {
  surface: BrandSurface;
  mode: BrandMode;
  /** What the surface calls the product. Never the provider, unless the provider is the product. */
  productName: string;
  /** Same field name as `SignInBrand.showPoweredBy`, so surfaces do not grow a third vocabulary. */
  showPoweredBy: boolean;
  /** Always the resolved host. A customer-mode surface may restyle it, never replace it. */
  hostDisplay: string;
  /** True where this surface may render the host at all (every surface but `metadata`). */
  routingFact: boolean;
  /** False only where the provider must not appear in product content: `customer` mode. */
  mayNameProviderInProductContent: boolean;
  /** True on the legal surface, where the provider must be named whatever the mode is. */
  providerNameRequired: boolean;
};

export function brandSurfaceContract(brand: LoadedBrand, surface: BrandSurface): BrandSurfaceContract {
  return {
    surface,
    mode: brand.mode,
    productName: brand.displayName,
    showPoweredBy: brand.showPoweredBy && ATTRIBUTION_SURFACES.includes(surface),
    hostDisplay: brand.host,
    routingFact: ROUTING_SURFACES.includes(surface),
    // The only mode-dependent rule in this file: `customer` keeps provider identity out of product
    // content (plan §5.1 line 264, #65 category 1) but never out of the legal surface (category 3).
    mayNameProviderInProductContent: brand.mode !== "customer" || surface === "legal",
    providerNameRequired: surface === "legal",
  };
}

export type ProviderReference = { index: number; text: string; fact: ProviderFactKind };

export type ProductContentVerdict = { ok: boolean; references: ProviderReference[] };

/**
 * The provider names this check looks for. One today; the shape allows a reviewed legal name later
 * (ADR-0004 §2 lists `legalName` as a field it has not decided).
 */
const PROVIDER_TERMS: readonly string[] = ["terraoi"];

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strict `/terraoi/i` substring match. #65 keeps the substring check strict everywhere except the
 * two marked islands; those islands are removed before the scan runs, so this function never sees
 * them and never invents a host exemption that would let an unmarked title or paragraph pass.
 */
function findReferences(text: string): { index: number; text: string }[] {
  const pattern = new RegExp(PROVIDER_TERMS.map(escapeForRegExp).join("|"), "gi");
  const found: { index: number; text: string }[] = [];
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    found.push({ index: match.index, text: match[0] });
  }
  return found;
}

/**
 * Would this text, on this surface, put provider **identity** where the mode forbids it? References
 * are classified rather than dropped, because #65's point is that the substring and the categories
 * are different questions: a reviewer reading a failure needs to see which of the three each one was.
 *
 * A plain-text check cannot see a marked routing island. The host is therefore **not** exempted
 * here: an unmarked host string (including in metadata, where `routingFact` is false and no island
 * can exist) is identity. Routing facts are asserted by the remove-then-scan pair in the component
 * tests, which strips marked islands first. On the `legal` surface the whole surface is a dedicated
 * legal element, so every reference there is a legal fact.
 */
export function checkProductContent(brand: LoadedBrand, surface: BrandSurface, text: string): ProductContentVerdict {
  const contract = brandSurfaceContract(brand, surface);
  const references: ProviderReference[] = findReferences(text).map((reference) => ({
    ...reference,
    fact: classify(surface),
  }));

  if (references.length === 0) return { ok: true, references };
  if (contract.mayNameProviderInProductContent) return { ok: true, references };
  return { ok: references.every((reference) => reference.fact !== "identity"), references };
}

function classify(surface: BrandSurface): ProviderFactKind {
  if (surface === "legal") return BRAND_FACT_MARKERS.legal;
  return "identity";
}
