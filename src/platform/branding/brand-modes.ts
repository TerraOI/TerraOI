import type { BrandMode } from "./brand-rules";
import type { TenantBrand } from "./tenant-brand";

/**
 * T-204's mode contract: for one validated `TenantBrand`, what each surface is allowed to show.
 *
 * The rules are not this file's. They come from three places, quoted where they are used:
 *
 * | Rule | Source |
 * |---|---|
 * | `terraoi` = "TerraOI identity for platform-owned surfaces"; `powered` = "Customer identity with approved Powered by TerraOI attribution"; `customer` = "Customer identity without visible provider attribution in customer product content" | plan §5.1 lines 262-264 |
 * | Customer presentation "cannot hide the provider name in the required `company1.terraoi.app` URL or override necessary legal disclosures" | plan §5.1 line 273 |
 * | The three categories - **provider identity**, **routing facts**, **legal facts** - and the two `data-brand-fact` marker values | [#65](https://github.com/TerraOI/TerraOI/issues/65), supervisor answer of 2026-11-09 |
 * | "Search visible customer output and metadata for unintended TerraOI references" | [WHITE-LABEL.md](../../../brand/terraoi-brand-kit/05-guides/WHITE-LABEL.md) acceptance check |
 *
 * Two things this module deliberately does **not** do:
 *
 * - **It does not render anything.** The surfaces are described; wiring login, shell, chat and email
 *   to them is slice 2, which waits on the PRs already inside those directories (#173, #139, T-131).
 *   Landing the contract first is what keeps slice 2 from inventing three per-surface vocabularies -
 *   the divergence ADR-0004 §3 warns about.
 * - **It takes no request state.** Mode comes from the validated brand, which comes from the host.
 *   `branding-boundary.test.ts` fails the build if this directory mentions a query string, a cookie
 *   or a header, so a public brand selector has nowhere to enter (plan §5.1 line 261).
 *
 * It also does not decide where the contract type lives. #65's answer puts the two marker values in
 * `src/contracts/tenant-brand.ts`, and that file does not exist because [ADR-0004](../../../docs/decisions/0004-tenant-brand-contract.md)
 * is still `proposed`. Until it is accepted, `src/contracts/` is a protected path no builder may
 * create ([COORDINATION §2](../../../docs/COORDINATION.md)), so `BRAND_FACT_MARKERS` lives here - the
 * one module the brand contract already occupies - with the values fixed to the ruling's own words so
 * the ADR's PR is a move, not a redesign.
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

/**
 * The two island markers #65's answer prescribes verbatim: "routing and legal facts are rendered
 * inside elements marked `data-brand-fact="routing"` or `data-brand-fact="legal"`", and the
 * customer-mode test "removes those elements, then asserts no `/terraoi/i` anywhere else ... It also
 * asserts that the routing element exists and shows the host." Exporting the values, rather than
 * letting components type the attribute by hand, is what makes a typo a build error instead of a
 * surface that silently stops being checked.
 */
export const BRAND_FACT_MARKERS = { routing: "routing", legal: "legal" } as const;

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

export function brandSurfaceContract(brand: TenantBrand, surface: BrandSurface): BrandSurfaceContract {
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
 * The required host is not a leak: #65's category 2 says the host is "always shown, never hidden",
 * because "showing the real address is a security property: it lets a user tell the real site from a
 * phishing page". So a reference inside it is a routing fact by rule.
 */
function isInsideRequiredHost(host: string, text: string, index: number): boolean {
  if (host.length === 0) return false;
  const hostPattern = new RegExp(escapeForRegExp(host), "gi");
  for (let match = hostPattern.exec(text); match !== null; match = hostPattern.exec(text)) {
    if (index >= match.index && index < match.index + host.length) return true;
  }
  return false;
}

/**
 * Bounded on both sides, because an unbounded substring match is worse than a miss: it flags a
 * customer genuinely named "TerraOils Ltd", telling a company its own name is not allowed in its own
 * product. #65's own framing of the merged test is that a substring "cannot express that difference".
 */
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
 * Would this text, on this surface, put provider **identity** where the mode forbids it? References
 * are classified rather than dropped, because #65's point is that the substring and the categories
 * are different questions: a reviewer reading a failure needs to see which of the three each one was.
 *
 * The classification here is deliberately narrower than the ruling's DOM mechanism. A plain-text
 * check can see the routing island (the host is in the string); it cannot see a "dedicated legal
 * element", which is what `data-brand-fact="legal"` is for. On the `legal` surface the whole surface
 * is such an element, so every reference there is a legal fact; on a product surface, a legal
 * disclosure has to be inside a marked element, and that assertion belongs to the component tests of
 * slice 2, not to this function.
 */
export function checkProductContent(brand: TenantBrand, surface: BrandSurface, text: string): ProductContentVerdict {
  const contract = brandSurfaceContract(brand, surface);
  const references: ProviderReference[] = findReferences(text).map((reference) => ({
    ...reference,
    fact: classify(brand.host, text, reference.index, surface),
  }));

  if (references.length === 0) return { ok: true, references };
  if (contract.mayNameProviderInProductContent) return { ok: true, references };
  return { ok: references.every((reference) => reference.fact !== "identity"), references };
}

function classify(host: string, text: string, index: number, surface: BrandSurface): ProviderFactKind {
  if (isInsideRequiredHost(host, text, index)) return BRAND_FACT_MARKERS.routing;
  if (surface === "legal") return BRAND_FACT_MARKERS.legal;
  return "identity";
}
