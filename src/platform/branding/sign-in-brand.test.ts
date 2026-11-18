import { describe, expect, it } from "vitest";

import { platformBrand } from "./kit-brand";
import { toSignInBrand } from "./sign-in-brand";

describe("toSignInBrand (ADR-0004 §3 projection)", () => {
  it("maps TenantBrand fields onto SignInBrand without inventing a third vocabulary", () => {
    const brand = platformBrand();
    expect(toSignInBrand(brand)).toEqual({
      name: brand.displayName,
      tagline: brand.tagline,
      logoUrl: brand.logoPath ?? "",
      primary: brand.primary,
      onPrimary: brand.onPrimary,
      accent: brand.accent,
      showPoweredBy: brand.showPoweredBy,
      supportLabel: brand.supportLabel,
    });
  });
});
