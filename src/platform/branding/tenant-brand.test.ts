import { describe, expect, it } from "vitest";

import { parseTenantBrand, type BrandSource } from "./tenant-brand";

/**
 * T-103 acceptance: a brand is one validated object or a safe rejection - never a half-rendered
 * shell. The source shape is strict, so a key that arrived from a query string, a header or a
 * cookie cannot ride along inside a brand source.
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

describe("parseTenantBrand: the positive path", () => {
  it("returns a frozen brand carrying the host it was resolved for", () => {
    const parsed = parseTenantBrand("company1.terraoi.app", source());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.brand.host).toBe("company1.terraoi.app");
    expect(parsed.brand.mode).toBe("customer");
    expect(parsed.brand.displayName).toBe("Company1");
    expect(Object.isFrozen(parsed.brand)).toBe(true);
  });

  it("keeps the colors as the single validated form so a CSS expression can never reach the page", () => {
    const parsed = parseTenantBrand("company1.terraoi.app", source({ primary: "#183b66" }));
    expect(parsed.ok && parsed.brand.primary).toBe("#183B66");
  });
});

describe("parseTenantBrand: what it refuses", () => {
  it("refuses a tenant choosing terraoi mode (plan §5.1: terraoi is for platform-owned surfaces)", () => {
    const parsed = parseTenantBrand("company1.terraoi.app", source({ mode: "terraoi" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasons).toContain("mode_not_allowed");
  });

  it("refuses an unknown host rather than treating it as a tenant with a brand", () => {
    const parsed = parseTenantBrand("Company1.TerraOI.app", source());
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasons).toContain("host");
  });

  it("refuses a source carrying keys the contract does not have, because that is how a ?brand= parameter would smuggle itself in", () => {
    const parsed = parseTenantBrand("company1.terraoi.app", { ...source(), theme: "dark" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasons).toContain("shape");
  });

  it("refuses each invalid field with a named reason instead of guessing a replacement", () => {
    const cases: Array<[Partial<BrandSource>, string]> = [
      [{ primary: "teal" }, "color"],
      [{ onPrimary: "#FFFFFF", primary: "#F4F6F7" }, "contrast"],
      [{ displayName: "{{company}}" }, "placeholder"],
      [{ documentPrefix: "CUSTOMER" }, "placeholder"],
      [{ supportUrl: "http://company1.example/support" }, "support_url"],
      [{ logo: { path: "assets/logo.svg", bytes: 10_000_000 } }, "asset_size"],
      [{ logo: { path: "../secrets/logo.svg", bytes: 100 } }, "asset_path"],
      [{ favicon: { path: "assets/logo.svg", bytes: 100, containsScript: true } }, "asset_content"],
    ];
    for (const [override, reason] of cases) {
      const parsed = parseTenantBrand("company1.terraoi.app", source(override));
      expect(parsed.ok, JSON.stringify(override)).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reasons, JSON.stringify(override)).toContain(reason);
    }
  });

  it("enforces the kit's attribution rules: customer mode hides TerraOI, powered mode shows it", () => {
    // WHITE-LABEL.md:17 - "Customer mode requires showPoweredBy: false. Powered mode requires it
    // to be true." Getting this wrong is a legal/contract disclosure miss, not a style choice.
    const customerShowing = parseTenantBrand("company1.terraoi.app", source({ mode: "customer", showPoweredBy: true }));
    expect(customerShowing.ok).toBe(false);
    if (!customerShowing.ok) expect(customerShowing.reasons).toContain("attribution");

    const poweredHiding = parseTenantBrand("company1.terraoi.app", source({ mode: "powered", showPoweredBy: false }));
    expect(poweredHiding.ok).toBe(false);
    if (!poweredHiding.ok) expect(poweredHiding.reasons).toContain("attribution");
  });

  it("refuses an accent color that is invisible against the light surface it is drawn on", () => {
    // The accent is a rule, an icon stroke or a link: WCAG 2.1 SC 1.4.11 puts non-text contrast at
    // 3:1, which is what ACCENT_CONTRAST_MIN_RATIO encodes.
    const parsed = parseTenantBrand("company1.terraoi.app", source({ accent: "#EFF1F3" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasons).toContain("contrast");
  });

  it("names every problem at once, so one fix does not uncover a second one later", () => {
    const parsed = parseTenantBrand("company1.terraoi.app", source({ primary: "teal", accent: "teal", displayName: "Customer Brand" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reasons).toEqual(expect.arrayContaining(["color", "placeholder"]));
    expect(parsed.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("never echoes the rejected value back into the reasons, so a brand name cannot leak through an error", () => {
    const parsed = parseTenantBrand("company1.terraoi.app", source({ primary: "#183B66; --secret: yes", displayName: "SecretCovertName" }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(JSON.stringify(parsed.reasons)).not.toContain("SecretCovertName");
    expect(JSON.stringify(parsed.reasons)).not.toContain("--secret");
  });
});

describe("parseTenantBrand: fields T-103 does not decide", () => {
  it("accepts an absent logo and favicon, and says so, because the platform artwork is a component", () => {
    const parsed = parseTenantBrand("company1.terraoi.app", source({ logo: undefined, favicon: undefined, mode: "powered", showPoweredBy: true }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.brand.logoPath).toBeNull();
  });

  it("carries no locale, timezone or verified-sender value: those are #67 and #64, not this packet", () => {
    const parsed = parseTenantBrand("company1.terraoi.app", source());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.brand).not.toHaveProperty("locale");
    expect(parsed.brand).not.toHaveProperty("timezone");
    expect(parsed.brand).not.toHaveProperty("emailReplyTo");
  });
});
