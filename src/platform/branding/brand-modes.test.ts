import { describe, expect, it } from "vitest";

import { BRAND_FACT_MARKERS } from "@/contracts/tenant-brand";

import { BRAND_SURFACES, brandSurfaceContract, checkProductContent, type BrandSurface } from "./brand-modes";
import { platformBrand, platformBrandForHost } from "./kit-brand";
import { parseTenantBrand, type BrandSource, type LoadedBrand } from "./tenant-brand";

/**
 * T-204 acceptance, slice 1: the mode decides what each surface may show, and nothing else decides
 * the mode.
 *
 * The rules asserted here are not inventions of this file. Each one names its source:
 *
 * - plan §5.1 line 259-263 — the mode table, and "production mode is tenant configuration, never an
 *   arbitrary public `?brand=` or cross-customer selector";
 * - plan §5.1 line 273 — "Customer-only presentation cannot hide the provider name in the required
 *   `company1.terraoi.app` URL or override necessary legal disclosures";
 * - [WHITE-LABEL.md](../../../brand/terraoi-brand-kit/05-guides/WHITE-LABEL.md) — the mode table
 *   ("Attribution: Hidden / Powered by TerraOI / Hidden"), and its acceptance check "Search visible
 *   customer output and metadata for unintended TerraOI references";
 * - [T-204](../../../docs/tasks/T-204-brand-modes.md) — "each mode renders its surface set ...
 *   `customer` without provider attribution in product content, across login, shell, chat empty/error
 *   and email", and the negative box "`customer` mode still shows the real `company1.terraoi.app`
 *   host and keeps required legal disclosures".
 *
 * Nothing here renders a component: the surfaces are described, and the surfaces themselves are
 * wired in slice 2, once #173 (shell/login), #139 (email) and T-131 (signin components) land.
 */

function source(overrides: Partial<BrandSource> = {}): BrandSource {
  return {
    mode: "customer",
    displayName: "Company1",
    descriptor: "Operational Intelligence",
    tagline: "Company1 operations.",
    logo: { path: "assets/company1-logo.svg", bytes: 4096 },
    favicon: { path: "assets/company1-favicon.png", bytes: 1024 },
    primary: "#183B66",
    onPrimary: "#FFFFFF",
    accent: "#637D99",
    showPoweredBy: false,
    supportLabel: "Contact your workspace administrator",
    reportOwner: "Company1",
    emailSenderName: "Company1 Workspace",
    documentPrefix: "C1OPS",
    ...overrides,
  };
}

/** A validated tenant brand for one host, or a thrown assertion - the fixture, not the product, fails. */
function brandFor(host: string, overrides: Partial<BrandSource> = {}): LoadedBrand {
  const parsed = parseTenantBrand(host, source(overrides));
  if (!parsed.ok) throw new Error(`fixture brand refused: ${parsed.reasons.join(", ")}`);
  return parsed.brand;
}

const TENANT_HOST = "company1.terraoi.app";
const customerBrand = brandFor(TENANT_HOST, { mode: "customer", showPoweredBy: false });
const poweredBrand = brandFor(TENANT_HOST, { mode: "powered", showPoweredBy: true });

/** The six surfaces a tenant sees, i.e. everything except the platform's own legal text. */
const PRODUCT_SURFACES: readonly BrandSurface[] = BRAND_SURFACES.filter((surface) => surface !== "legal");

describe("attribution is a property of the mode, per surface (WHITE-LABEL mode table)", () => {
  it("shows attribution on every product surface in powered mode", () => {
    for (const surface of PRODUCT_SURFACES) {
      expect(brandSurfaceContract(poweredBrand, surface).showPoweredBy, surface).toBe(true);
    }
  });

  it("hides attribution on every product surface in customer mode", () => {
    for (const surface of PRODUCT_SURFACES) {
      expect(brandSurfaceContract(customerBrand, surface).showPoweredBy, surface).toBe(false);
    }
  });

  it("hides attribution on every product surface in terraoi mode, where TerraOI is the product", () => {
    for (const surface of PRODUCT_SURFACES) {
      expect(brandSurfaceContract(platformBrand(), surface).showPoweredBy, surface).toBe(false);
    }
  });

  it("keeps the attribution line off the legal surface even in powered mode", () => {
    // Assumption, stated rather than buried: WHITE-LABEL's attribution row and plan §5.1's
    // "necessary legal disclosures" are different things. A legal disclosure is not a marketing
    // credit, so the "Powered by TerraOI" line is not what satisfies it.
    expect(brandSurfaceContract(poweredBrand, "legal").showPoweredBy).toBe(false);
  });
});

describe("every mode defines the whole surface set", () => {
  it.each(["terraoi", "powered", "customer"] as const)("defines all %s surfaces", (mode) => {
    const brand = mode === "terraoi" ? platformBrand() : brandFor(TENANT_HOST, {
      mode,
      showPoweredBy: mode === "powered",
    });
    for (const surface of BRAND_SURFACES) {
      const contract = brandSurfaceContract(brand, surface);
      expect(contract.surface).toBe(surface);
      expect(contract.mode).toBe(mode);
    }
  });

  it("names the product after the brand in every mode, never after the provider", () => {
    expect(brandSurfaceContract(customerBrand, "login").productName).toBe("Company1");
    expect(brandSurfaceContract(poweredBrand, "login").productName).toBe("Company1");
    expect(brandSurfaceContract(platformBrand(), "login").productName).toBe("TerraOI");
  });
});

describe("customer presentation cannot hide the host or the provider's legal identity", () => {
  it("still shows the real host on every surface (plan §5.1 line 273)", () => {
    for (const surface of BRAND_SURFACES) {
      expect(brandSurfaceContract(customerBrand, surface).hostDisplay, surface).toBe(TENANT_HOST);
    }
  });

  it("never substitutes the customer's display name for the host", () => {
    const contract = brandSurfaceContract(customerBrand, "shell");
    expect(contract.hostDisplay).not.toBe(customerBrand.displayName);
    expect(contract.hostDisplay).toContain("terraoi.app");
  });

  it("still requires the provider name on the legal surface in every mode", () => {
    for (const brand of [customerBrand, poweredBrand, platformBrand()]) {
      expect(brandSurfaceContract(brand, "legal").providerNameRequired, brand.mode).toBe(true);
    }
  });

  it("forbids the provider name in customer-mode product content while allowing it in powered and terraoi", () => {
    expect(brandSurfaceContract(customerBrand, "chatEmpty").mayNameProviderInProductContent).toBe(false);
    expect(brandSurfaceContract(poweredBrand, "chatEmpty").mayNameProviderInProductContent).toBe(true);
    expect(brandSurfaceContract(platformBrand(), "chatEmpty").mayNameProviderInProductContent).toBe(true);
  });

  it("keeps the host required in customer mode even though the provider name is banned in content", () => {
    const contract = brandSurfaceContract(customerBrand, "shell");
    expect(contract.mayNameProviderInProductContent).toBe(false);
    expect(contract.providerNameRequired).toBe(false);
    expect(contract.hostDisplay).toBe(TENANT_HOST);
  });
});

describe("checkProductContent automates the kit's acceptance check", () => {
  it("flags a provider reference in customer-mode product content", () => {
    const verdict = checkProductContent(customerBrand, "login", "Continue with Powered by TerraOI");
    expect(verdict.ok).toBe(false);
    expect(verdict.references.filter((reference) => reference.fact === "identity")).toHaveLength(1);
  });

  it("treats a browser title as product content, because §5.1 lists browser titles", () => {
    const verdict = checkProductContent(customerBrand, "metadata", "TerraOI | Company1 operations");
    expect(verdict.ok).toBe(false);
    expect(verdict.references[0]?.text.toLowerCase()).toBe("terraoi");
  });

  it("flags an unmarked host string in product content — the host is not exempt outside islands", () => {
    // #65: substring stays strict everywhere except the two marked islands. Those islands are
    // stripped before the scan; this function never invents a host exemption for unmarked text.
    const verdict = checkProductContent(customerBrand, "shell", `Signed in at ${TENANT_HOST}`);
    expect(verdict.ok).toBe(false);
    expect(verdict.references.every((reference) => reference.fact === "identity")).toBe(true);
  });

  it("flags a metadata title that embeds the tenant host", () => {
    // metadata has routingFact:false — no island can exist — so a title carrying terraoi is identity.
    const verdict = checkProductContent(customerBrand, "metadata", `Company1 · ${TENANT_HOST}`);
    expect(verdict.ok).toBe(false);
    expect(verdict.references.some((reference) => reference.fact === "identity")).toBe(true);
  });

  it("matches the provider reference whatever its case", () => {
    const verdict = checkProductContent(customerBrand, "email", "Your terraoi workspace is ready");
    expect(verdict.ok).toBe(false);
  });

  it("flags a customer name that merely contains the provider substring (strict /terraoi/i)", () => {
    // No TerraOils carve-out: #65 keeps the substring strict. A word-boundary exception would need a
    // needs-supervisor decision; this suite does not invent one.
    const brand = brandFor(TENANT_HOST, { displayName: "TerraOils Ltd" });
    const verdict = checkProductContent(brand, "shell", "Quarterly report from TerraOils Ltd");
    expect(verdict.ok).toBe(false);
    expect(verdict.references.some((reference) => /terraoi/i.test(reference.text))).toBe(true);
  });

  it("allows the reference in powered mode and in terraoi mode", () => {
    expect(checkProductContent(poweredBrand, "shell", "Powered by TerraOI").ok).toBe(true);
    expect(checkProductContent(platformBrand(), "shell", "Powered by TerraOI").ok).toBe(true);
  });

  it("reports where the reference was found, so a failing surface is fixable", () => {
    const verdict = checkProductContent(customerBrand, "chatError", "Ask TerraOI to continue");
    expect(verdict.references[0]?.index).toBe(4);
  });
});

describe("the fallback brand is a brand too", () => {
  it("resolves to terraoi surfaces on the host it is served on", () => {
    // `loadTenantBrand` hands a broken or missing tenant row `platformBrandForHost(host)`, so the
    // surface contract has to be well defined for exactly that value: platform identity, no
    // attribution, and the *requested* host still shown.
    const brand = platformBrandForHost(TENANT_HOST);
    const contract = brandSurfaceContract(brand, "login");
    expect(contract.mode).toBe("terraoi");
    expect(contract.showPoweredBy).toBe(false);
    expect(contract.productName).toBe("TerraOI");
    expect(contract.hostDisplay).toBe(TENANT_HOST);
    expect(checkProductContent(brand, "login", "TerraOI workspace").ok).toBe(true);
  });
});

describe("the mode never arrives from the request", () => {
  it("refuses a tenant host asking for terraoi before any surface is built", () => {
    const parsed = parseTenantBrand(TENANT_HOST, source({ mode: "terraoi", showPoweredBy: false }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasons).toContain("mode_not_allowed");
  });

  it("refuses a platform host asking for a customer mode", () => {
    const parsed = parseTenantBrand("terraoi.app", source({ mode: "customer", showPoweredBy: false }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasons).toContain("mode_not_allowed");
  });

  it("builds surfaces from the brand object alone", () => {
    // The surface contract takes a validated brand and a surface id: there is no host, query,
    // cookie or header parameter to pass, and `branding-boundary.test.ts` fails the build if this
    // module ever starts reading request state.
    expect(brandSurfaceContract.length).toBe(2);
    expect(checkProductContent.length).toBe(3);
  });
});

/**
 * [#65](https://github.com/TerraOI/TerraOI/issues/65) (2026-11-09): "no provider identity", not
 * "no `terraoi` substring" — identity / routing / legal, with islands for the last two. Cited once
 * here; the remove-then-scan algorithm is in `brand-fact.test.tsx`.
 */
describe("the #65 categories: identity, routing, legal", () => {
  it("exports exactly the two marker values the ruling names, in the ruling's own words", () => {
    expect(BRAND_FACT_MARKERS).toEqual({ routing: "routing", legal: "legal" });
    expect(Object.keys(BRAND_FACT_MARKERS)).toEqual(["routing", "legal"]);
  });

  it("counts an unmarked host string as identity — routing facts need a marked island", () => {
    const verdict = checkProductContent(customerBrand, "shell", `You are on ${TENANT_HOST}`);
    expect(verdict.references[0]?.fact).toBe("identity");
    expect(verdict.ok).toBe(false);
  });

  it("counts a provider name in customer-mode product content as identity, category 1", () => {
    const verdict = checkProductContent(customerBrand, "chatError", "Ask TerraOI to continue");
    expect(verdict.references[0]?.fact).toBe("identity");
    expect(verdict.ok).toBe(false);
  });

  it("counts a provider name on the legal surface as a legal fact, category 3", () => {
    const verdict = checkProductContent(customerBrand, "legal", "TerraOI acts as our processor for this workspace");
    expect(verdict.references[0]?.fact).toBe("legal");
    expect(verdict.ok).toBe(true);
  });

  it("requires the routing fact to be present in customer mode, so hiding the host is not a fix", () => {
    const contract = brandSurfaceContract(customerBrand, "shell");
    expect(contract.routingFact).toBe(true);
    expect(contract.hostDisplay).toBe(TENANT_HOST);
    expect(brandSurfaceContract(customerBrand, "legal").routingFact).toBe(true);
  });

  it("marks browser metadata as an identity surface, because the ruling lists titles and social metadata", () => {
    expect(brandSurfaceContract(customerBrand, "metadata").mayNameProviderInProductContent).toBe(false);
    expect(brandSurfaceContract(customerBrand, "email").mayNameProviderInProductContent).toBe(false);
    // A title cannot carry a routing island, so the metadata surface has no routing fact to show.
    expect(brandSurfaceContract(customerBrand, "metadata").routingFact).toBe(false);
  });
});
