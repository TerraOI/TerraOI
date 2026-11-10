import { describe, expect, it } from "vitest";

import { loadTenantBrand } from "./load-tenant-brand";
import { brandAssetUrl, brandSourceReader, BrandSourceFailure, readBrandAsset } from "./brand-source";

// The port `load-tenant-brand.ts` injected, fed with the real projection
// (`load_public_brand(text)` from 20261109213000_brand_config.sql). The row below is that
// projection's out-parameters, written by hand so a change to either side fails here rather than in
// a staging render.

const ROW = {
  mode: "customer",
  display_name: "Company1 Geotechnics",
  descriptor: "Operational Intelligence",
  tagline: "Field data, answered",
  primary_color: "#007F78",
  on_primary_color: "#FFFFFF",
  accent_color: "#A48748",
  logo_path: "1/logo.svg",
  logo_bytes: 43,
  favicon_path: "1/favicon.ico",
  favicon_bytes: 4,
  support_label: "Contact your workspace administrator",
  support_url: "https://support.company1.example/help",
  report_owner: "Company1 Geotechnics",
  email_sender_name: "Company1 Geotechnics",
  document_prefix: "CO1",
  show_powered_by: false,
};

const env = { SUPABASE_URL: "https://synthetic.supabase.co", SUPABASE_ANON_KEY: "synthetic-anon-key" };

interface Captured {
  url: string;
  init: RequestInit;
}

function fetchReturning(payload: unknown, options: { status?: number } = {}) {
  const calls: Captured[] = [];
  const impl = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: input, init: init ?? {} });
    const status = options.status ?? 200;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

describe("brandSourceReader: the port F04 was waiting for", () => {
  it("maps the SQL projection onto the contract, in one place (ADR-0001)", async () => {
    const { impl, calls } = fetchReturning([ROW]);
    const source = await brandSourceReader(env, { fetchImpl: impl })("company1.terraoi.app");
    expect(source).toMatchObject({
      mode: "customer",
      displayName: "Company1 Geotechnics",
      primary: "#007F78",
      logo: { path: "1/logo.svg", bytes: 43 },
      favicon: { path: "1/favicon.ico", bytes: 4 },
      showPoweredBy: false,
    });
    // snake_case stays in SQL-land: nothing below this file should see a column name.
    expect(JSON.stringify(source)).not.toContain("_");
    expect(calls[0]?.url).toBe("https://synthetic.supabase.co/rpc/load_public_brand");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ p_host: "company1.terraoi.app" });
  });

  it("reads with the publishable key only, never a service-role key (§4.2)", async () => {
    const { impl, calls } = fetchReturning([ROW]);
    await brandSourceReader({ ...env, SUPABASE_SERVICE_ROLE_KEY: "poison-service-role-key" } as typeof env,
      { fetchImpl: impl })("company1.terraoi.app");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.apikey).toBe("synthetic-anon-key");
    expect(headers.authorization).toBe("Bearer synthetic-anon-key");
    expect(JSON.stringify(headers)).not.toContain("poison");
  });

  it("answers undefined for no row, which is the packet's failure box rather than an error", async () => {
    const { impl } = fetchReturning([]);
    await expect(brandSourceReader(env, { fetchImpl: impl })("company1.terraoi.app")).resolves.toBeUndefined();
  });

  it.each([
    ["two rows for one host", [ROW, ROW]],
    ["an unexpected column", { ...ROW, organisation_id: "11111111-1111-4111-8111-111111111111" }],
    ["a legal_name the public projection must never return", { ...ROW, legal_name: "Company1 Pty Ltd" }],
    ["a path without its size", { ...ROW, logo_bytes: null }],
    ["an unversioned path", { ...ROW, logo_path: "logo.svg" }],
    ["a disallowed extension", { ...ROW, logo_path: "1/logo.html" }],
    ["an over-64-KiB size", { ...ROW, logo_bytes: 65_537 }],
    ["a mode outside tenant configuration", { ...ROW, mode: "terraoi" }],
  ])("refuses %s instead of trusting the row", async (_label, payload) => {
    const { impl } = fetchReturning(Array.isArray(payload) ? payload : [payload]);
    await expect(brandSourceReader(env, { fetchImpl: impl })("company1.terraoi.app")).rejects.toBeInstanceOf(BrandSourceFailure);
  });

  it("refuses a deployment with no bindings, rather than reading some default tenant", async () => {
    const { impl } = fetchReturning([ROW]);
    await expect(brandSourceReader({}, { fetchImpl: impl })("company1.terraoi.app")).rejects.toBeInstanceOf(BrandSourceFailure);
  });

  it("refuses a non-2xx read", async () => {
    const { impl } = fetchReturning({ message: "synthetic" }, { status: 500 });
    await expect(brandSourceReader(env, { fetchImpl: impl })("company1.terraoi.app")).rejects.toBeInstanceOf(BrandSourceFailure);
  });
});

describe("loadTenantBrand over the real reader (F04 wired up)", () => {
  it("resolves a tenant-brand origin from a host, with the versioned asset path", async () => {
    const { impl } = fetchReturning([ROW]);
    const resolved = await loadTenantBrand({
      host: "company1.terraoi.app",
      readSource: brandSourceReader(env, { fetchImpl: impl }),
    });
    expect(resolved.origin).toBe("tenant");
    expect(resolved.fallback).toBeNull();
    expect(resolved.brand.host).toBe("company1.terraoi.app");
    expect(resolved.brand.logoPath).toBe("1/logo.svg");
    expect(brandAssetUrl(resolved.brand.logoPath)).toBe("/brand-assets/1/logo.svg");
  });

  it("falls back to platform branding when the read throws, and never caches identity data", async () => {
    const broken = fetchReturning([{ nope: true }]);
    const resolved = await loadTenantBrand({
      host: "company1.terraoi.app",
      readSource: brandSourceReader(env, { fetchImpl: broken.impl }),
      cache: true,
    });
    expect(resolved.origin).toBe("platform");
    // The reader throws, and a throw is a failed read rather than a malformed row: the loader's
    // `source_error` reason, with platform branding and an admin-visible note.
    expect(resolved.fallback?.reason).toBe("source_error");

    const working = fetchReturning([ROW]);
    const ok = await loadTenantBrand({
      host: "company2.terraoi.app",
      readSource: brandSourceReader(env, { fetchImpl: working.impl }),
      cache: { maxEntries: 8 },
    });
    expect(ok.origin).toBe("tenant");
    // #119 owns the cache instance (per-isolate, created per load today), so what this slice proves
    // is what can enter it: a value that carries no organisation id, membership or user field.
    const serialized = JSON.stringify(ok);
    expect(serialized).not.toMatch(/organisation/i);
    expect(serialized).not.toMatch(/member/i);
    expect(serialized).not.toMatch(/user/i);
    expect(serialized).toContain("company2.terraoi.app");
  });
});

describe("readBrandAsset", () => {
  const svgBytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');

  it("decodes the base64 body and keeps the declared size honest", async () => {
    const { impl, calls } = fetchReturning([
      { content_type: "image/svg+xml", content_base64: "PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=", byte_size: svgBytes.length },
    ]);
    const asset = await readBrandAsset(env, { host: "company1.terraoi.app", configVersion: "1", name: "logo.svg" }, { fetchImpl: impl });
    expect(asset?.contentType).toBe("image/svg+xml");
    expect(Array.from(asset?.bytes ?? [])).toEqual(Array.from(svgBytes));
    expect(calls[0]?.url).toBe("https://synthetic.supabase.co/rpc/load_public_brand_asset");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ p_host: "company1.terraoi.app", p_config_version: 1, p_name: "logo.svg" });
  });

  it.each([
    ["a declared size that does not match the bytes", { content_type: "image/svg+xml", content_base64: "PHN2Zy8+", byte_size: 999 }],
    ["a content type outside the allowed set", { content_type: "text/html", content_base64: "PHN2Zy8+", byte_size: 6 }],
    ["an oversized row", { content_type: "image/png", content_base64: "AAAA", byte_size: 65_537 }],
    ["an unexpected column", { content_type: "image/png", content_base64: "AAAA", byte_size: 3, organisation_id: "x" }],
  ])("refuses %s", async (_label, row) => {
    const { impl } = fetchReturning([row]);
    await expect(readBrandAsset(env, { host: "company1.terraoi.app", configVersion: "1", name: "logo.png" }, { fetchImpl: impl }))
      .rejects.toBeInstanceOf(BrandSourceFailure);
  });

  it("returns undefined for no row, which the route answers as the shared 404", async () => {
    const { impl } = fetchReturning([]);
    await expect(readBrandAsset(env, { host: "company1.terraoi.app", configVersion: "1", name: "nope.png" }, { fetchImpl: impl }))
      .resolves.toBeUndefined();
  });
});

describe("brandAssetUrl", () => {
  it("prefixes a versioned path and refuses anything else", () => {
    expect(brandAssetUrl("12/logo.svg")).toBe("/brand-assets/12/logo.svg");
    expect(brandAssetUrl(null)).toBeNull();
    expect(brandAssetUrl("logo.svg")).toBeNull();
    expect(brandAssetUrl("../1/logo.svg")).toBeNull();
    expect(brandAssetUrl("https://company2.terraoi.app/brand-assets/1/logo.svg")).toBeNull();
  });
});
