import { describe, expect, it } from "vitest";

import {
  BRAND_FACT_MARKERS,
  BrandMode,
  PublicBrand,
  TenantBrand,
  TenantBrandMode,
  showPoweredByFor,
} from "./tenant-brand";

const publicBrand = () => ({
  mode: "customer" as const,
  displayName: "Company1",
  descriptor: "Operational Intelligence",
  tagline: "Field data, answered.",
  logoPath: "3/logo.svg",
  faviconPath: null,
  primary: "#183B66",
  onPrimary: "#FFFFFF",
  accent: "#637D99",
  supportLabel: "Contact your workspace administrator",
  supportUrl: "https://company1.example/support",
});

const tenantBrand = () => ({
  ...publicBrand(),
  legalName: "Company1 Ltd",
  reportOwner: "Company1",
  emailSenderName: "Company1 Operations",
  emailReplyTo: null,
  documentPrefix: "CO1",
  configVersion: 3,
});

describe("BrandMode (plan §5.1 line 261, #62)", () => {
  it("knows the three kit modes, and a tenant row may hold only two", () => {
    expect(BrandMode.options).toEqual(["terraoi", "powered", "customer"]);
    expect(TenantBrandMode.safeParse("terraoi").success).toBe(false);
    expect(TenantBrandMode.safeParse("powered").success).toBe(true);
  });

  it("derives attribution from the mode", () => {
    expect(showPoweredByFor("powered")).toBe(true);
    expect(showPoweredByFor("customer")).toBe(false);
    expect(showPoweredByFor("terraoi")).toBe(false);
  });
});

describe("PublicBrand (pre-sign-in projection, #188)", () => {
  it("parses the projection", () => {
    expect(PublicBrand.parse(publicBrand()).displayName).toBe("Company1");
  });

  it("refuses the server-only fields, so they cannot reach an anonymous page", () => {
    for (const extra of [{ legalName: "Company1 Ltd" }, { configVersion: 3 }, { emailReplyTo: "ops@company1.example" }]) {
      expect(PublicBrand.safeParse({ ...publicBrand(), ...extra }).success).toBe(false);
    }
  });

  it("refuses a stored showPoweredBy: attribution is derived, never stored", () => {
    expect(PublicBrand.safeParse({ ...publicBrand(), showPoweredBy: true }).success).toBe(false);
  });

  it("accepts only normalized #RRGGBB colours", () => {
    for (const primary of ["#183b66", "red", "rgb(0,0,0)", "#183B66;", "#183B6"]) {
      expect(PublicBrand.safeParse({ ...publicBrand(), primary }).success).toBe(false);
    }
  });

  it("accepts only an https support link", () => {
    for (const supportUrl of ["http://company1.example", "javascript:alert(1)", "https://"]) {
      expect(PublicBrand.safeParse({ ...publicBrand(), supportUrl }).success).toBe(false);
    }
  });
});

describe("TenantBrand (full server-side shape, #188)", () => {
  it("parses the full shape", () => {
    expect(TenantBrand.parse(tenantBrand()).configVersion).toBe(3);
  });

  it("has no field that can hold a sender address, domain or credential (#64)", () => {
    for (const extra of [{ senderAddress: "no-reply@company1.example" }, { sendingDomain: "company1.example" }, { apiKey: "x" }]) {
      expect(TenantBrand.safeParse({ ...tenantBrand(), ...extra }).success).toBe(false);
    }
  });

  it("keeps locale and timezone out until #67 lands", () => {
    expect(TenantBrand.safeParse({ ...tenantBrand(), locale: "en-GB" }).success).toBe(false);
    expect(TenantBrand.safeParse({ ...tenantBrand(), timezone: "Europe/London" }).success).toBe(false);
  });

  it("checks reply-to, document prefix and config version shapes", () => {
    expect(TenantBrand.safeParse({ ...tenantBrand(), emailReplyTo: "ops@company1.example" }).success).toBe(true);
    expect(TenantBrand.safeParse({ ...tenantBrand(), emailReplyTo: "not an address" }).success).toBe(false);
    expect(TenantBrand.safeParse({ ...tenantBrand(), documentPrefix: "co1" }).success).toBe(false);
    expect(TenantBrand.safeParse({ ...tenantBrand(), configVersion: 0 }).success).toBe(false);
  });
});

describe("BRAND_FACT_MARKERS (#65)", () => {
  it("names exactly the routing and legal islands", () => {
    expect(BRAND_FACT_MARKERS).toEqual({ routing: "routing", legal: "legal" });
  });
});
