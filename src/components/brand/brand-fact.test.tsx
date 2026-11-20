// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { BRAND_FACT_MARKERS } from "@/contracts/tenant-brand";
import { checkProductContent } from "@/platform/branding/brand-modes";
import { parseTenantBrand, type BrandSource, type LoadedBrand } from "@/platform/branding/tenant-brand";
import { BrandFact, brandFactMarker } from "./brand-fact";

/**
 * #65's remove-then-scan mechanism, in code: a production island component plus the pair that strips
 * marked islands and asserts no `/terraoi/i` remains (ruling cited once in `brand-modes.ts`). Fixture
 * pages only — real login/shell/chat wiring is slice 2.
 */

afterEach(cleanup);

const TENANT_HOST = "company1.terraoi.app";

function customerBrand(): LoadedBrand {
  const source: BrandSource = {
    mode: "customer",
    displayName: "Company1",
    descriptor: "Operational Intelligence",
    tagline: "Company1 operations.",
    primary: "#183B66",
    onPrimary: "#FFFFFF",
    accent: "#637D99",
    showPoweredBy: false,
    supportLabel: "Contact your workspace administrator",
    reportOwner: "Company1",
    emailSenderName: "Company1 Workspace",
    documentPrefix: "C1OPS",
  };
  const parsed = parseTenantBrand(TENANT_HOST, source);
  if (!parsed.ok) throw new Error(`fixture brand refused: ${parsed.reasons.join(", ")}`);
  return parsed.brand;
}

describe("the island component", () => {
  it("marks a routing fact with the marker the contract exports, and shows the host as its text", () => {
    const { container } = render(<BrandFact kind="routing" host={TENANT_HOST} />);
    const island = container.querySelector(`[data-brand-fact="${BRAND_FACT_MARKERS.routing}"]`);
    expect(island).not.toBeNull();
    expect(island?.textContent).toBe(TENANT_HOST);
  });

  it("marks a legal fact with the legal marker and keeps its children", () => {
    const { container } = render(
      <BrandFact kind="legal">TerraOI acts as our processor for this workspace.</BrandFact>,
    );
    const island = container.querySelector(`[data-brand-fact="${BRAND_FACT_MARKERS.legal}"]`);
    expect(island?.textContent).toContain("processor");
  });

  it("refuses a kind that is not one of the two markers instead of rendering it unmarked", () => {
    // An unmarked island is not a cosmetic miss: it is the one way to make the customer-mode check
    // pass while still showing provider identity, which is what the ruling's "so a builder cannot
    // fix it by hiding the host" is guarding against.
    expect(() => brandFactMarker("host" as never)).toThrow(/data-brand-fact/);
    expect(() => brandFactMarker("" as never)).toThrow(/data-brand-fact/);
  });

  it("renders nothing for an empty host, so an island cannot claim to be a routing fact and show nothing", () => {
    const { container } = render(<BrandFact kind="routing" host="" />);
    expect(container.querySelector("[data-brand-fact]")).toBeNull();
  });
});

describe("the remove-then-scan pair #65 prescribes", () => {
  /** The ruling's first half: drop the marked islands, then scan what is left. */
  function withoutIslands(container: HTMLElement): string {
    for (const island of [...container.querySelectorAll("[data-brand-fact]")]) island.remove();
    return container.innerHTML;
  }

  /** The ruling's second half: the routing island has to be there, and it has to show the host. */
  function routingIslands(container: HTMLElement): Element[] {
    return [...container.querySelectorAll(`[data-brand-fact="${BRAND_FACT_MARKERS.routing}"]`)];
  }

  /**
   * Both halves together, which is the whole point of the pair: a page passes only if nothing
   * outside the islands names the provider **and** a routing island shows the real host. Either half
   * alone is satisfiable by a mistake - or, as the ruling puts it, by hiding the host.
   */
  function customerModePagePasses(brand: LoadedBrand, container: HTMLElement): { ok: boolean; reasons: string[] } {
    const reasons: string[] = [];
    // Islands are read before they are removed: stripping first would make every page look like it
    // hides the host, and the failure would be about the helper rather than about the page.
    const islands = routingIslands(container);
    const stripped = withoutIslands(container);
    const scan = checkProductContent(brand, "shell", stripped);
    if (!scan.ok) reasons.push("identity outside the islands");
    if (islands.length === 0) reasons.push("no routing island showing the host");
    else if (!islands.some((island) => island.textContent === brand.host)) reasons.push("routing island does not show the host");
    return { ok: reasons.length === 0, reasons };
  }

  it("passes a page that names the provider only inside marked islands", () => {
    const brand = customerBrand();
    const { container } = render(
      <div>
        <h1>Company1 operations</h1>
        <BrandFact kind="routing" host={TENANT_HOST} />
        <BrandFact kind="legal">TerraOI acts as our processor.</BrandFact>
      </div>,
    );
    // The whole page does contain the provider string - which is the point: the rule is not "no
    // substring, and an unstripped scan would flag it.
    expect(checkProductContent(brand, "shell", container.innerHTML).ok).toBe(false);
    expect(customerModePagePasses(brand, container)).toEqual({ ok: true, reasons: [] });
  });

  it("fails a page that puts the provider name in product content", () => {
    const brand = customerBrand();
    const { container } = render(
      <div>
        <h1>TerraOI for Company1</h1>
        <BrandFact kind="routing" host={TENANT_HOST} />
      </div>,
    );
    expect(customerModePagePasses(brand, container)).toEqual({ ok: false, reasons: ["identity outside the islands"] });
  });

  it("fails a page that hides the host, even when nothing else names the provider", () => {
    // This is the assertion a substring-only test could never make: satisfying "no terraoi anywhere"
    // by deleting the address is a phishing-window regression, not a fix.
    const brand = customerBrand();
    const { container } = render(
      <div>
        <h1>Company1 operations</h1>
        <BrandFact kind="legal">Our processor is named in the privacy notice.</BrandFact>
      </div>,
    );
    // Asserted on the raw HTML, before the helper strips anything: the page genuinely names no
    // provider, so the only thing wrong with it is the missing routing island.
    expect(container.innerHTML).not.toMatch(/terraoi/i);
    expect(customerModePagePasses(brand, container)).toEqual({ ok: false, reasons: ["no routing island showing the host"] });
  });

  it("does not let an unmarked host string count as the routing fact", () => {
    // Unmarked host text is identity under the strict scan; the page also lacks a routing island.
    const brand = customerBrand();
    const { container } = render(
      <div>
        <h1>Company1 operations</h1>
        <p>You are on {TENANT_HOST}</p>
      </div>,
    );
    expect(checkProductContent(brand, "shell", container.innerHTML).ok).toBe(false);
    expect(customerModePagePasses(brand, container)).toEqual({
      ok: false,
      reasons: ["identity outside the islands", "no routing island showing the host"],
    });
  });
});
