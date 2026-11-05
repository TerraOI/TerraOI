import { afterEach, describe, expect, it, vi } from "vitest";
import { isPlatformHost, platformHostFromHeaders } from "./platform-host";

afterEach(() => vi.unstubAllEnvs());

describe("isPlatformHost", () => {
  it("accepts only the TerraOI site hosts, using the tenancy host rules", () => {
    expect(isPlatformHost("terraoi.app")).toBe(true);
    expect(isPlatformHost("www.terraoi.app")).toBe(true);
    for (const h of [
      "company1.terraoi.app", // a tenant
      "admin.terraoi.app", // the control plane
      "terraoi.app.evil.example",
      "TERRAOI.APP", // not normalized
      "terraoi.terraoi.workers.dev", // preview alias
      "203.0.113.7",
      "",
      null,
    ]) {
      expect(isPlatformHost(h), String(h)).toBe(false);
    }
  });
});

describe("platformHostFromHeaders", () => {
  const h = (init: Record<string, string>) => new Headers(init);

  it("returns the host only when Host names a platform host", () => {
    expect(platformHostFromHeaders(h({ host: "terraoi.app" }))).toBe("terraoi.app");
    expect(platformHostFromHeaders(h({ host: "www.terraoi.app" }))).toBe("www.terraoi.app");
    expect(platformHostFromHeaders(h({ host: "company1.terraoi.app" }))).toBeNull();
    expect(platformHostFromHeaders(h({}))).toBeNull();
  });

  it("refuses an explicit port, as requestHost does for the API", () => {
    expect(platformHostFromHeaders(h({ host: "terraoi.app:8443" }))).toBeNull();
  });

  it("never reads X-Forwarded-Host", () => {
    expect(platformHostFromHeaders(h({ host: "company1.terraoi.app", "x-forwarded-host": "terraoi.app" }))).toBeNull();
    expect(platformHostFromHeaders(h({ host: "terraoi.app", "x-forwarded-host": "company1.terraoi.app" }))).toBe(
      "terraoi.app",
    );
  });

  it("refuses a Host value that is not a bare host", () => {
    for (const host of ["terraoi.app/evil", "user@terraoi.app", "terraoi.app evil"]) {
      expect(platformHostFromHeaders(h({ host })), host).toBeNull();
    }
  });

  it("serves localhost as terraoi.app under next dev only", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(platformHostFromHeaders(h({ host: "localhost:3000" }))).toBe("terraoi.app");
    vi.stubEnv("TERRAOI_DEV_HOST", "company1.terraoi.app");
    expect(platformHostFromHeaders(h({ host: "localhost:3000" }))).toBeNull();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TERRAOI_DEV_HOST", "terraoi.app");
    expect(platformHostFromHeaders(h({ host: "localhost:3000" }))).toBeNull();
  });
});
