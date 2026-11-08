import { describe, expect, it, vi } from "vitest";

import { loadTenantBrand } from "./load-tenant-brand";
import type { BrandSource } from "./tenant-brand";

/**
 * F04 `loadTenantBrand` (plan §11 line 694): "Host-resolved org + config version -> safe product
 * identity". The packet's boxes covered here:
 *
 * - positive: mode `terraoi` for platform hosts, `customer`/`powered` selectable only by tenant
 *   configuration - never by a query parameter or header;
 * - negative: an unknown host, or a tenant with no brand row, falls back to the platform brand and
 *   leaks no other customer's name, logo or colors;
 * - failure: brand row missing/partial -> platform fallback plus an admin-visible note, never a
 *   blank shell or a crash.
 *
 * There is no brand row to read yet - issue #62 says no packet owns `tenant_brands` - so the row
 * arrives through an injected reader and the only honest implementation today answers "no row".
 * The tests drive that reader directly, which is also how T-204's admin write path will drive it
 * once the table exists.
 */

function company1Source(overrides: Partial<BrandSource> = {}): BrandSource {
  return {
    mode: "powered",
    displayName: "Company1 Drilling",
    descriptor: "Operational Intelligence",
    tagline: "Company1 field operations.",
    logo: { path: "assets/company1-logo.svg", bytes: 4096 },
    favicon: { path: "assets/company1-favicon.png", bytes: 1024 },
    primary: "#183B66",
    onPrimary: "#FFFFFF",
    accent: "#637D99",
    showPoweredBy: true,
    supportLabel: "Call the Company1 duty officer",
    reportOwner: "Company1 Drilling",
    emailSenderName: "Company1 Workspace",
    documentPrefix: "C1OPS",
    ...overrides,
  };
}

describe("platform and admin hosts", () => {
  it("renders terraoi mode on terraoi.app, www, staging and admin, and never reads a brand row", async () => {
    const readSource = vi.fn(() => company1Source());
    for (const host of ["terraoi.app", "www.terraoi.app", "staging.terraoi.app", "admin.terraoi.app"]) {
      const resolved = await loadTenantBrand({ host, readSource });
      expect(resolved.brand.mode, host).toBe("terraoi");
      expect(resolved.brand.displayName, host).toBe("TerraOI");
      expect(resolved.origin, host).toBe("platform");
      expect(resolved.fallback, host).toBeNull();
    }
    expect(readSource).not.toHaveBeenCalled();
  });

  it("refuses to treat a preview alias or an IP literal as a tenant with a brand", async () => {
    const readSource = vi.fn(() => company1Source());
    for (const host of ["company1-preview.workers.dev", "10.0.0.7", "Company1.TerraOI.app", "company1.terraoi.app/", ""]) {
      const resolved = await loadTenantBrand({ host, readSource });
      expect(resolved.brand.mode, host).toBe("terraoi");
      expect(resolved.fallback?.reason, host).toBe("unknown_host");
    }
    expect(readSource).not.toHaveBeenCalled();
  });
});

describe("tenant hosts", () => {
  it("applies a tenant's own powered/customer configuration when the row is valid", async () => {
    const resolved = await loadTenantBrand({ host: "company1.terraoi.app", readSource: () => company1Source() });
    expect(resolved.origin).toBe("tenant");
    expect(resolved.brand.mode).toBe("powered");
    expect(resolved.brand.displayName).toBe("Company1 Drilling");
    expect(resolved.brand.showPoweredBy).toBe(true);
    expect(resolved.fallback).toBeNull();
  });

  it("hands the reader only the normalized host - nothing about the visitor", async () => {
    const seen: unknown[] = [];
    await loadTenantBrand({
      host: "company1.terraoi.app",
      readSource: (input) => {
        seen.push(input);
        return company1Source();
      },
    });
    expect(seen).toEqual(["company1.terraoi.app"]);
  });

  it("answers no_brand_row with the platform brand when the reader finds nothing", async () => {
    const resolved = await loadTenantBrand({ host: "company2.terraoi.app", readSource: () => undefined });
    expect(resolved.brand.mode).toBe("terraoi");
    expect(resolved.brand.displayName).toBe("TerraOI");
    expect(resolved.origin).toBe("platform");
    expect(resolved.fallback?.reason).toBe("no_brand_row");
  });

  it("never puts one tenant's identity on another host, because the reader is asked per host", async () => {
    const rows: Record<string, BrandSource> = { "company1.terraoi.app": company1Source() };
    const readSource = (host: string) => rows[host];
    const one = await loadTenantBrand({ host: "company1.terraoi.app", readSource });
    const two = await loadTenantBrand({ host: "company2.terraoi.app", readSource });
    expect(one.brand.displayName).toBe("Company1 Drilling");
    expect(two.brand.displayName).toBe("TerraOI");
    const serialized = JSON.stringify(two);
    expect(serialized).not.toContain("Company1");
    expect(serialized).not.toContain("#183B66");
    expect(serialized).not.toContain("company1-logo");
  });

  it("falls back with a named reason when the row is partial, and never echoes the bad value", async () => {
    const broken = { ...company1Source(), primary: "navy blue" } as unknown;
    const resolved = await loadTenantBrand({ host: "company1.terraoi.app", readSource: () => broken });
    expect(resolved.origin).toBe("platform");
    expect(resolved.brand.mode).toBe("terraoi");
    expect(resolved.fallback?.reason).toBe("invalid_brand");
    // The fallback note is admin-visible, so it names the problem class and not the customer's data.
    expect(JSON.stringify(resolved.fallback)).not.toContain("Company1 Drilling");
    expect(JSON.stringify(resolved)).not.toContain("navy blue");
  });

  it("treats a reader that throws as a fallback, and does not leak the error text", async () => {
    const resolved = await loadTenantBrand({
      host: "company1.terraoi.app",
      readSource: () => {
        // A host and port only. A connection string with a password inside it would be a committed
        // credential-shaped string, and the secret scan is not something a test works around.
        throw new Error("connect ECONNREFUSED db.internal:5432");
      },
    });
    expect(resolved.fallback?.reason).toBe("source_error");
    expect(resolved.brand.displayName).toBe("TerraOI");
    expect(JSON.stringify(resolved)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(resolved)).not.toContain("db.internal");
  });

  it("refuses a tenant row that asks for terraoi mode instead of serving TerraOI branding to that customer", async () => {
    const resolved = await loadTenantBrand({
      host: "company1.terraoi.app",
      readSource: () => company1Source({ mode: "terraoi" }),
    });
    expect(resolved.origin).toBe("platform");
    expect(resolved.fallback?.reason).toBe("invalid_brand");
    expect(resolved.brand.displayName).toBe("TerraOI");
  });

  it("always returns a shell the page can render: no nulls in the fields a layout reads", async () => {
    for (const readSource of [
      () => company1Source(),
      () => undefined,
      () => ({ mode: "powered" }),
      () => {
        throw new Error("boom");
      },
    ]) {
      const resolved = await loadTenantBrand({ host: "company1.terraoi.app", readSource });
      for (const field of ["displayName", "descriptor", "tagline", "supportLabel", "reportOwner", "documentPrefix", "primary", "onPrimary", "accent"]) {
        expect(typeof resolved.brand[field as keyof typeof resolved.brand], `${field} via ${String(readSource)}`).toBe("string");
      }
      expect(["terraoi", "powered", "customer"]).toContain(resolved.brand.mode);
      if (resolved.fallback) expect(resolved.brand.mode).toBe("terraoi");
    }
  });
});

describe("caching is opt-in and host-keyed", () => {
  it("serves a second request for the same host from the cache without reading again", async () => {
    const readSource = vi.fn(() => company1Source());
    const first = await loadTenantBrand({ host: "company1.terraoi.app", readSource, cache: true });
    const second = await loadTenantBrand({ host: "company1.terraoi.app", readSource, cache: true });
    expect(readSource).toHaveBeenCalledTimes(1);
    expect(second.brand).toEqual(first.brand);
  });

  it("does not serve company1's brand to company2 out of a cache keyed on something looser than the host", async () => {
    const rows: Record<string, BrandSource> = {
      "company1.terraoi.app": company1Source(),
      "company2.terraoi.app": company1Source({ displayName: "Company2 Mining", documentPrefix: "C2OPS" }),
    };
    const readSource = (host: string) => rows[host];
    const one = await loadTenantBrand({ host: "company1.terraoi.app", readSource, cache: true });
    const two = await loadTenantBrand({ host: "company2.terraoi.app", readSource, cache: true });
    expect(one.brand.displayName).toBe("Company1 Drilling");
    expect(two.brand.displayName).toBe("Company2 Mining");
  });
});
