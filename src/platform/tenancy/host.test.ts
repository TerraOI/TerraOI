import { afterEach, describe, expect, it, vi } from "vitest";

import { parseHost, requestHost } from "./host";

// The development override is environment-bound, so most of these run in the test runtime and the
// development case stubs NODE_ENV explicitly. Vitest restores it after each test.
afterEach(() => {
  vi.unstubAllEnvs();
});

// Plan §4.1 step 1: the externally routed host is validated, not repaired. Nothing here guesses
// a tenant from a suffix, and no preview alias gets to bypass the registry.
describe("parseHost (F01)", () => {
  it("classifies tenant, platform and admin hosts", () => {
    expect(parseHost("company1.terraoi.app")).toEqual({ ok: true, host: "company1.terraoi.app", class: "tenant" });
    expect(parseHost("company1-staging.terraoi.app")).toMatchObject({ class: "tenant" });
    expect(parseHost("terraoi.app")).toMatchObject({ class: "platform" });
    expect(parseHost("www.terraoi.app")).toMatchObject({ class: "platform" });
    expect(parseHost("admin.terraoi.app")).toMatchObject({ class: "admin" });
  });

  it("rejects malformed hosts instead of normalizing them into a tenant", () => {
    expect(parseHost("Company1.TerraOI.app")).toMatchObject({ ok: false, reason: "malformed_host" });
    expect(parseHost("company1.terraoi.app:8443")).toMatchObject({ ok: false, reason: "malformed_host" });
    expect(parseHost("https://company1.terraoi.app")).toMatchObject({ ok: false, reason: "malformed_host" });
    expect(parseHost("company1.terraoi.app/chat")).toMatchObject({ ok: false, reason: "malformed_host" });
    expect(parseHost(" company1.terraoi.app ")).toMatchObject({ ok: false, reason: "malformed_host" });
    expect(parseHost("")).toMatchObject({ ok: false, reason: "missing_host" });
    expect(parseHost(undefined)).toMatchObject({ ok: false, reason: "missing_host" });
  });

  it("rejects an extra subdomain level and a look-alike suffix", () => {
    expect(parseHost("deep.sub.company1.terraoi.app")).toMatchObject({ ok: false, reason: "too_many_labels" });
    expect(parseHost("company1.terraoi.app.evil.test")).toMatchObject({ ok: false, reason: "too_many_labels" });
    expect(parseHost("terraoi.app.evil.test")).toMatchObject({ ok: false, reason: "too_many_labels" });
  });

  it("rejects deployment aliases and IP literals (§4.1: no bypass through preview origins)", () => {
    expect(parseHost("my-project.workers.dev")).toMatchObject({ ok: false, reason: "preview_alias" });
    expect(parseHost("terraoi.workers.dev")).toMatchObject({ ok: false, reason: "preview_alias" });
    expect(parseHost("127.0.0.1")).toMatchObject({ ok: false, reason: "ip_literal" });
    expect(parseHost("localhost")).toMatchObject({ ok: false, reason: "malformed_host" });
  });
});

describe("requestHost (trusted deployment adapter)", () => {
  // F02: TerraOI runs on Workers, so there is no proxy that could have rewritten a host header.
  // Every request carries CF-Connecting-IP, which therefore proves nothing about X-Forwarded-Host.
  it("ignores a spoofed x-forwarded-host, with or without cf-connecting-ip", () => {
    const throughEdge = new Headers({
      host: "company1.terraoi.app",
      "x-forwarded-host": "company2.terraoi.app",
      "cf-connecting-ip": "203.0.113.7",
    });
    expect(requestHost({ url: "https://company1.terraoi.app/api/chat", headers: throughEdge })).toBe(
      "company1.terraoi.app",
    );

    const withoutEdgeMarker = new Headers({
      host: "company1.terraoi.app",
      "x-forwarded-host": "company2.terraoi.app",
    });
    expect(requestHost({ url: "https://company1.terraoi.app/api/chat", headers: withoutEdgeMarker })).toBe(
      "company1.terraoi.app",
    );
  });

  it("ignores a spoofed host header and a multi-value forwarded host", () => {
    const headers = new Headers({
      host: "company2.terraoi.app",
      "x-forwarded-host": "company1.terraoi.app, company2.terraoi.app",
      "x-organisation-id": "11111111-1111-4111-8111-111111111111",
    });
    expect(requestHost({ url: "https://company1.terraoi.app/", headers })).toBe("company1.terraoi.app");
  });

  it("normalizes the routed host the URL parser normalizes, and refuses anything malformed", () => {
    expect(requestHost({ url: "https://Company1.TerraOI.app/chat" })).toBe("company1.terraoi.app");
    // The path and query never leak into the host, and an unexpected port is refused rather than
    // silently dropped by the parser.
    expect(requestHost({ url: "https://company1.terraoi.app:8443/chat" })).toBeNull();
    expect(requestHost({ url: "not-a-url" })).toBeNull();
    expect(requestHost({ url: "" })).toBeNull();
  });

  it("uses the development host only when a development runtime passes one explicitly (§4.1 step 1)", () => {
    expect(requestHost({ url: "http://localhost/chat" })).toBe("localhost");
    // An explicit port is refused outright, which is why `next dev` needs the override below.
    expect(requestHost({ url: "http://localhost:3000/chat" })).toBeNull();
    vi.stubEnv("NODE_ENV", "development");
    expect(requestHost({ url: "http://localhost:3000/chat" }, { developmentHost: "company1.terraoi.app" })).toBe(
      "company1.terraoi.app",
    );
    expect(requestHost({ url: "http://localhost/chat" }, { developmentHost: "" })).toBe("localhost");
    // A development adapter that passes nothing still cannot be talked into another tenant by a
    // header, and the Workers adapter passes nothing.
    expect(
      requestHost(
        { url: "https://company1.terraoi.app/", headers: new Headers({ "x-forwarded-host": "company2.terraoi.app" }) },
        { developmentHost: undefined },
      ),
    ).toBe("company1.terraoi.app");
  });

  // #18 N1: the parameter alone is not the guard. Outside a development runtime the override is
  // ignored, so wiring copied into staging or production cannot route by a caller-chosen host.
  it("ignores a development host in any environment that is not development (plan §4.1 step 1)", () => {
    for (const env of ["production", "test", undefined] as const) {
      vi.stubEnv("NODE_ENV", env);
      expect(requestHost({ url: "http://localhost:3000/chat" }, { developmentHost: "company2.terraoi.app" })).toBeNull();
      expect(requestHost({ url: "http://localhost/chat" }, { developmentHost: "company2.terraoi.app" })).toBe("localhost");
      // The routed URL still wins, so an override handed to a real request changes nothing at all.
      expect(requestHost({ url: "https://company1.terraoi.app/chat" }, { developmentHost: "company2.terraoi.app" })).toBe(
        "company1.terraoi.app",
      );
    }
    // Positive control for the loop above: the same call in a development runtime does use the
    // override, so the three refusals are the environment guard and not a broken stub.
    vi.stubEnv("NODE_ENV", "development");
    expect(requestHost({ url: "http://localhost:3000/chat" }, { developmentHost: "company2.terraoi.app" })).toBe(
      "company2.terraoi.app",
    );
  });
});
