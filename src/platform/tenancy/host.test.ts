import { describe, expect, it } from "vitest";

import { parseHost, requestHost } from "./host";

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
  it("uses x-forwarded-host only when the request provably came through Cloudflare", () => {
    const throughEdge = new Headers({
      host: "internal-origin.render.local",
      "x-forwarded-host": "company1.terraoi.app",
      "cf-connecting-ip": "203.0.113.7",
    });
    expect(requestHost(throughEdge)).toBe("company1.terraoi.app");

    const direct = new Headers({
      host: "company2.terraoi.app",
      "x-forwarded-host": "company1.terraoi.app",
    });
    expect(requestHost(direct)).toBe("company2.terraoi.app");
  });

  it("ignores a multi-value forwarded host and any tenant-claiming custom header", () => {
    const headers = new Headers({
      host: "company2.terraoi.app",
      "x-forwarded-host": "company1.terraoi.app, evil.test",
      "cf-connecting-ip": "203.0.113.7",
      "x-organisation-id": "11111111-1111-4111-8111-111111111111",
    });
    expect(requestHost(headers)).toBe("company2.terraoi.app");
  });
});
