import { describe, expect, it, vi } from "vitest";

import {
  BRAND_ASSET_CACHE_CONTROL,
  BRAND_ASSET_SVG_CSP,
  serveBrandAsset,
  type BrandAssetDeps,
} from "./serve-brand-asset";

// FAQ-0008's customer half: the bytes behind `/brand-assets/{configVersion}/{name}`, host-resolved,
// one identical 404 for every refusal. The host comes from the routed request URL only (ADR-0006
// rule 3 for handlers), and the socket-level claims — the header set and the refusal shape as they
// leave the process — are asserted in `serve-brand-asset.loopback.test.ts`.

const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function route(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

function deps(asset?: { contentType: string; bytes: Uint8Array }, options: { throws?: boolean } = {}) {
  const calls: Array<{ host: string; configVersion: string; name: string }> = [];
  const dep: BrandAssetDeps = {
    async readAsset(input) {
      calls.push(input);
      if (options.throws) throw new Error("synthetic store failure carrying <sentinel-detail-must-not-be-logged>");
      return asset;
    },
  };
  return { dep, calls };
}

const pngHeaders = { contentType: "image/png", bytes: PNG } as const;

describe("serveBrandAsset: a served brand asset", () => {
  it("returns the stored bytes with the immutable cache directive (FAQ-0008, #117)", async () => {
    const { dep, calls } = deps(pngHeaders);
    const response = await serveBrandAsset(route("https://company1.terraoi.app/brand-assets/1/logo.png"),
      { configVersion: "1", name: "logo.png" }, dep);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe(BRAND_ASSET_CACHE_CONTROL);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    // A png needs no sandbox: the CSP belongs to the type that can carry script.
    expect(response.headers.get("content-security-policy")).toBeNull();
    expect(calls).toEqual([{ host: "company1.terraoi.app", configVersion: "1", name: "logo.png" }]);
  });

  it("sandboxes an SVG asset, because that is the allowed type with executable potential (§5.1 line 269)", async () => {
    const { dep } = deps({ contentType: "image/svg+xml", bytes: SVG });
    const response = await serveBrandAsset(route("https://company2.terraoi.app/brand-assets/7/logo.svg"),
      { configVersion: "7", name: "logo.svg" }, dep);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-security-policy")).toBe(BRAND_ASSET_SVG_CSP);
    expect(response.headers.get("cache-control")).toBe(BRAND_ASSET_CACHE_CONTROL);
  });

  it("takes the tenant from the routed URL and ignores a Host header that names someone else", async () => {
    const { dep, calls } = deps(pngHeaders);
    const response = await serveBrandAsset(
      route("https://company1.terraoi.app/brand-assets/1/logo.png", { headers: { host: "company2.terraoi.app" } }),
      { configVersion: "1", name: "logo.png" },
      dep,
    );
    expect(response.status).toBe(200);
    expect(calls[0]?.host).toBe("company1.terraoi.app");
  });
});

describe("serveBrandAsset: every refusal is the same answer", () => {
  const refusals: Array<[string, () => Promise<Response>]> = [];

  const push = (label: string, url: string, params: { configVersion: unknown; name: unknown }, d?: BrandAssetDeps) => {
    refusals.push([label, () => serveBrandAsset(route(url), params, d ?? deps().dep)]);
  };

  push("unknown host", "https://company9.terraoi.app/brand-assets/1/logo.png", { configVersion: "1", name: "logo.png" });
  push("platform host", "https://terraoi.app/brand-assets/1/logo.png", { configVersion: "1", name: "logo.png" });
  push("admin host", "https://admin.terraoi.app/brand-assets/1/logo.png", { configVersion: "1", name: "logo.png" });
  push("staging alias", "https://company1-staging.terraoi.app/brand-assets/1/logo.png", { configVersion: "1", name: "logo.png" });
  push("look-alike host", "https://company1.terraoi.app.evil.test/brand-assets/1/logo.png", { configVersion: "1", name: "logo.png" });
  push("version with a prefix", "https://company1.terraoi.app/brand-assets/v1/logo.png", { configVersion: "v1", name: "logo.png" });
  push("empty version", "https://company1.terraoi.app/brand-assets//logo.png", { configVersion: "", name: "logo.png" });
  push("version overflow", "https://company1.terraoi.app/brand-assets/99999999999999999999/logo.png",
    { configVersion: "99999999999999999999", name: "logo.png" });
  push("uppercase name", "https://company1.terraoi.app/brand-assets/1/Logo.PNG", { configVersion: "1", name: "Logo.PNG" });
  push("climbing name", "https://company1.terraoi.app/brand-assets/1/../secret.png", { configVersion: "1", name: "../secret.png" });
  push("disallowed type", "https://company1.terraoi.app/brand-assets/1/logo.html", { configVersion: "1", name: "logo.html" });
  push("no extension", "https://company1.terraoi.app/brand-assets/1/logo", { configVersion: "1", name: "logo" });

  it.each(refusals)("404s for %s, with no body to explain itself", async (_label, run) => {
    const response = await run();
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("does not consult the store at all for a host that is not a tenant host", async () => {
    for (const url of ["https://terraoi.app/brand-assets/1/logo.png", "https://admin.terraoi.app/brand-assets/1/logo.png"]) {
      const { dep, calls } = deps(pngHeaders);
      const response = await serveBrandAsset(route(url), { configVersion: "1", name: "logo.png" }, dep);
      expect(response.status).toBe(404);
      expect(calls).toHaveLength(0);
    }
  });

  it("answers an unknown version, an unknown name and another tenant's name identically", async () => {
    const shape = async (url: string, params: { configVersion: unknown; name: unknown }, d: BrandAssetDeps) => {
      const response = await serveBrandAsset(route(url), params, d);
      return {
        status: response.status,
        body: await response.text(),
        contentType: response.headers.get("content-type"),
        cacheControl: response.headers.get("cache-control"),
        csp: response.headers.get("content-security-policy"),
      };
    };
    // A store that knows exactly one asset: company1, version 1, logo.png. Every other key is the
    // same "no row" answer the SQL gives, which is what makes the three 404s indistinguishable.
    const store: BrandAssetDeps = {
      readAsset: async ({ host, configVersion, name }) =>
        host === "company1.terraoi.app" && configVersion === "1" && name === "logo.png"
          ? pngHeaders
          : undefined,
    };
    const missingName = await shape("https://company1.terraoi.app/brand-assets/1/other.png", { configVersion: "1", name: "other.png" }, store);
    const wrongVersion = await shape("https://company1.terraoi.app/brand-assets/2/logo.png", { configVersion: "2", name: "logo.png" }, store);
    const otherHost = await shape("https://company2.terraoi.app/brand-assets/1/logo.png", { configVersion: "1", name: "logo.png" }, store);
    expect(missingName).toEqual(wrongVersion);
    expect(missingName).toEqual(otherHost);
    expect(missingName.status).toBe(404);
  });

  it("refuses a store failure with the same 404 and logs no detail that could reach a client", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dep } = deps(undefined, { throws: true });
    const response = await serveBrandAsset(route("https://company1.terraoi.app/brand-assets/1/logo.png"),
      { configVersion: "1", name: "logo.png" }, dep);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    const logged = error.mock.calls.map((call) => JSON.stringify(call)).join("|");
    // The synthetic failure carries a credential-shaped detail and the asset name; neither may be
    // logged, because this line is the only place a brand read can leak to.
    expect(logged).not.toContain("sentinel-detail-must-not-be-logged");
    expect(logged).not.toContain("logo.png");
    expect(logged).toContain("readAsset");
    error.mockRestore();
  });

  it("refuses a row whose declared type disagrees with the name it is served under", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dep } = deps({ contentType: "image/png", bytes: SVG });
    const response = await serveBrandAsset(route("https://company1.terraoi.app/brand-assets/1/logo.svg"),
      { configVersion: "1", name: "logo.svg" }, dep);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    error.mockRestore();
  });

  it("refuses an oversized body rather than serving an immutable 64 KiB-plus URL (#117)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dep } = deps({ contentType: "image/png", bytes: new Uint8Array(65_537) });
    const response = await serveBrandAsset(route("https://company1.terraoi.app/brand-assets/1/logo.png"),
      { configVersion: "1", name: "logo.png" }, dep);
    expect(response.status).toBe(404);
    error.mockRestore();
  });
});
