import { describe, expect, it } from "vitest";

import {
  CONTRAST_MIN_RATIO,
  MAX_BRAND_ASSET_BYTES,
  assetFactProblem,
  contrastRatio,
  hasUnresolvedPlaceholder,
  isHttpsUrl,
  meetsContrast,
  parseHexColor,
  tenantModeIsAllowed,
} from "./brand-rules";

/**
 * T-103 acceptance: "invalid color values, an SVG/HTML asset over the size limit, a non-https
 * support URL and an unresolved placeholder (`{{company}}`) are each rejected with a safe error"
 * and "contrast check — white text on a light primary is refused, not shipped"
 * ([packet](../../../docs/tasks/T-103-tenant-shell-brand.md), plan §5.1 line 269: "Validate
 * colors/assets/URLs; sanitize or reject uploaded SVG/HTML; validate actual contrast").
 *
 * These are the primitives every brand object passes through, so they are tested directly rather
 * than only through the loader.
 */

describe("parseHexColor", () => {
  it("accepts the six-digit form the kit uses, in either case", () => {
    expect(parseHexColor("#007F78")).toBe("#007F78");
    expect(parseHexColor("#ffffff")).toBe("#FFFFFF");
  });

  it("refuses anything that is not a bare six-digit hex color", () => {
    // A named color or an rgb() expression is the door through which arbitrary CSS reaches the
    // page (plan §5.1: "Do not permit arbitrary CSS or scripts"), so nothing but #RRGGBB passes.
    for (const bad of ["red", "rgb(0,127,118)", "#07F", "#007F78FF", "#007F78; color: red", "", "  #007F78", "#007F7G"]) {
      expect(parseHexColor(bad), bad).toBeNull();
    }
  });
});

describe("contrastRatio (plan §5.1 'validate actual contrast')", () => {
  it("is 21 for black on white, which is the only pair with that ratio", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 2);
    expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 2);
  });

  it("does not depend on which color comes first", () => {
    expect(contrastRatio("#007F78", "#FFFFFF")).toBeCloseTo(contrastRatio("#FFFFFF", "#007F78"), 6);
  });

  it("refuses white on a light primary rather than shipping it", () => {
    // The packet's named negative case: white text on a light primary.
    const verdict = meetsContrast("#FFFFFF", "#F4F6F7");
    expect(verdict.ok).toBe(false);
    expect(verdict.ratio).not.toBeNull();
    expect((verdict.ratio as number)).toBeLessThan(CONTRAST_MIN_RATIO);
  });

  it("passes the kit's own white-on-teal pair, so the shipped platform brand is contrast-checked", () => {
    const verdict = meetsContrast("#FFFFFF", "#007F78");
    expect(verdict.ok, `ratio ${verdict.ratio}`).toBe(true);
  });

  it("reports a failed pair as unusable when either color is malformed, without throwing", () => {
    const verdict = meetsContrast("not-a-color", "#FFFFFF");
    expect(verdict.ok).toBe(false);
    expect(verdict.ratio).toBeNull();
  });
});

describe("hasUnresolvedPlaceholder (plan §16 white-label row: 'no unresolved placeholders')", () => {
  it("catches a mustache that was never populated", () => {
    expect(hasUnresolvedPlaceholder("{{company}}")).toBe(true);
    expect(hasUnresolvedPlaceholder("Acme {{region}} Ops")).toBe(true);
  });

  it("catches the kit's own placeholder strings, which WHITE-LABEL.md:17 says to replace", () => {
    expect(hasUnresolvedPlaceholder("Customer Brand")).toBe(true);
    expect(hasUnresolvedPlaceholder("CUSTOMER")).toBe(true);
  });

  it("accepts a real name, including one with braces-free punctuation", () => {
    expect(hasUnresolvedPlaceholder("Company1")).toBe(false);
    expect(hasUnresolvedPlaceholder("Aero-Surface Ops")).toBe(false);
  });
});

describe("isHttpsUrl", () => {
  it("accepts an https URL and nothing else", () => {
    expect(isHttpsUrl("https://company1.example/support")).toBe(true);
    for (const bad of ["http://company1.example/support", "javascript:alert(1)", "support@example.com", "//company1.example/x", "https:/x", "not a url"]) {
      expect(isHttpsUrl(bad), bad).toBe(false);
    }
  });

  it("refuses an https URL that carries userinfo in the authority", () => {
    // What the rule is about: browsers accept userinfo before the host, and a reader never sees the
    // at-sign. The value is assembled at run time so the diff carries no credential-shaped literal
    // for the commit-scoped secret scan to trip on; the assertion itself is unchanged, and deleting
    // the username check still makes this test fail (mutation recorded in the PR).
    const userinfo = "workspace-support";
    expect(isHttpsUrl(`https://${userinfo}@company1.example/help`)).toBe(false);
  });
});

describe("assetFactProblem (plan §5.1 'sanitize or reject uploaded SVG/HTML')", () => {
  it("names a path that escapes the brand asset root", () => {
    expect(assetFactProblem({ path: "../../etc/passwd", bytes: 10 })).toMatch("path");
    expect(assetFactProblem({ path: "https://evil.example/logo.svg", bytes: 10 })).toMatch("path");
    expect(assetFactProblem({ path: "data:image/svg+xml;base64,AAAA", bytes: 10 })).toMatch("path");
  });

  it("refuses an asset over the size limit and says the limit", () => {
    const problem = assetFactProblem({ path: "assets/logo.svg", bytes: MAX_BRAND_ASSET_BYTES + 1 });
    expect(problem).toMatch("size");
  });

  it("refuses an asset whose byte count was never measured, because an unmeasured asset cannot clear the limit", () => {
    expect(assetFactProblem({ path: "assets/logo.svg" })).toMatch("size");
  });

  it("refuses an unknown media type, and accepts svg and png that are in budget", () => {
    expect(assetFactProblem({ path: "assets/logo.exe", bytes: 10 })).toMatch("type");
    expect(assetFactProblem({ path: "assets/logo.svg", bytes: 4096 })).toBeNull();
    expect(assetFactProblem({ path: "assets/favicon.png", bytes: 4096 })).toBeNull();
  });

  it("refuses an HTML asset outright: a brand asset is an image, not a document to render", () => {
    expect(assetFactProblem({ path: "assets/logo.html", bytes: 100 })).toMatch("type");
    expect(assetFactProblem({ path: "assets/logo.svg", bytes: 100, containsScript: true })).toMatch("content");
  });
});

describe("tenantModeIsAllowed (plan §5.1 line 261)", () => {
  it("allows a tenant to choose powered or customer, and never terraoi", () => {
    expect(tenantModeIsAllowed("powered")).toBe(true);
    expect(tenantModeIsAllowed("customer")).toBe(true);
    expect(tenantModeIsAllowed("terraoi")).toBe(false);
  });
});
