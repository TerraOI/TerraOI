import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ACCENT_CONTRAST_MIN_RATIO, MAX_BRAND_ASSET_BYTES, hasUnresolvedPlaceholder, meetsContrast } from "./brand-rules";
import { BRAND_SURFACE_COLOR, kitBrandSourceForMode, kitModeNames, platformBrand } from "./kit-brand";
import { parseTenantBrand } from "./tenant-brand";

/**
 * brand/README.md rule 1 and FAQ-0001: `src/platform/branding/` reads `tokens.json` and
 * `brand-config.json` and validates them; nothing else in the app may read `brand/`, and nothing
 * reads it through the filesystem at runtime (this ships to Workers, where there is no `fs`).
 *
 * The filesystem reads below are **test-side** checks on the design source that is committed to
 * this repository: they prove the shipped kit clears the same limits the validator enforces, and
 * that a kit change which breaks a rule fails CI instead of rendering a bad brand.
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const KIT = join(ROOT, "brand", "terraoi-brand-kit");

describe("platformBrand (the terraoi mode the platform hosts render)", () => {
  it("is a validated, frozen brand in terraoi mode with no fallback note", () => {
    const brand = platformBrand();
    expect(brand.mode).toBe("terraoi");
    expect(brand.displayName).toBe("TerraOI");
    expect(brand.showPoweredBy).toBe(false);
    expect(Object.isFrozen(brand)).toBe(true);
  });

  it("clears the contrast rules the tenant brands are held to", () => {
    const brand = platformBrand();
    expect(meetsContrast(brand.onPrimary, brand.primary).ok, `${brand.onPrimary} on ${brand.primary}`).toBe(true);
    expect(meetsContrast(brand.accent, BRAND_SURFACE_COLOR, ACCENT_CONTRAST_MIN_RATIO).ok, `accent ${brand.accent} on ${BRAND_SURFACE_COLOR}`).toBe(true);
  });

  it("carries no unresolved placeholder anywhere in its text fields", () => {
    const brand = platformBrand();
    for (const value of Object.values(brand)) {
      if (typeof value === "string") expect(hasUnresolvedPlaceholder(value), value).toBe(false);
    }
  });

  it("does not pretend to know a logo URL: the platform artwork is a component, not an asset path", () => {
    // src/components/site/logo-wordmark.tsx already carries the kit's SVG as JSX, and public/ is
    // empty. Serving kit artwork as a file is a separate decision (issue opened by this PR).
    expect(platformBrand().logoPath).toBeNull();
  });
});

describe("the kit's own placeholders stay placeholders", () => {
  it("exposes exactly the three modes the kit defines", () => {
    expect(kitModeNames()).toEqual(["terraoi", "powered", "customer"]);
  });

  it("refuses the powered and customer entries as a tenant brand, because they are unfilled templates", () => {
    // WHITE-LABEL.md:15-17: those entries hold "Customer Brand" and "CUSTOMER" and must be replaced
    // before delivery. Reading them as a live brand would show a customer the word "Customer".
    for (const mode of ["powered", "customer"] as const) {
      const parsed = parseTenantBrand("company1.terraoi.app", kitBrandSourceForMode(mode));
      expect(parsed.ok, mode).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reasons, mode).toContain("placeholder");
    }
  });
});

describe("the committed kit assets clear the same budget a customer asset must clear", () => {
  const svgDir = join(KIT, "01-identity", "svg");
  const faviconDir = join(KIT, "01-identity", "favicon");

  it("has no kit SVG or favicon over the brand asset size limit", () => {
    const checked: string[] = [];
    for (const dir of [svgDir, faviconDir]) {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name);
        if (!statSync(file).isFile()) continue;
        checked.push(name);
        const bytes = statSync(file).size;
        // Kit artwork is reviewed design source; if it outgrows the budget a customer asset is
        // held to, the budget is fiction. Fail rather than special-case the platform.
        expect(bytes, `${name} is ${bytes} bytes, limit ${MAX_BRAND_ASSET_BYTES}`).toBeLessThanOrEqual(MAX_BRAND_ASSET_BYTES);
      }
    }
    expect(checked.length).toBeGreaterThan(6);
  });

  it("has no script element or event handler in any kit SVG", () => {
    // plan §5.1 "sanitize or reject uploaded SVG/HTML": the rule is not only about uploads, and a
    // kit SVG that grew a <script> would be a self-XSS in every branded surface.
    for (const name of readdirSync(svgDir)) {
      const text = readFileSync(join(svgDir, name), "utf8");
      expect(text, name).not.toMatch(/<script|<foreignObject|\son[a-z]+=/i);
    }
  });
});
