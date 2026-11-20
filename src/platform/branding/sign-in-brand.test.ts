import { describe, expect, it } from "vitest";

import { platformBrand } from "./kit-brand";
import { toSignInBrand } from "./sign-in-brand";
import type { LoadedBrand } from "./tenant-brand";

describe("toSignInBrand (ADR-0004 §3 projection)", () => {
  it("maps LoadedBrand fields onto SignInBrand without inventing a third vocabulary", () => {
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

  it("prefixes a versioned tenant logo path for /brand-assets (FAQ-0008)", () => {
    const brand = {
      ...platformBrand(),
      host: "company1.terraoi.app",
      mode: "customer",
      displayName: "Company1 Geotechnics",
      showPoweredBy: false,
      logoPath: "1/logo.svg",
    } as LoadedBrand;
    expect(toSignInBrand(brand).logoUrl).toBe("/brand-assets/1/logo.svg");
  });

  it("drops a non-versioned logo path rather than handing it to <img src> (#211 N2)", () => {
    const brand = {
      ...platformBrand(),
      logoPath: "assets/logo.svg",
    } as LoadedBrand;
    expect(toSignInBrand(brand).logoUrl).toBe("");
  });
});
