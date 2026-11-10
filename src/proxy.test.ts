import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { ROUTED_HOST_HEADER } from "@/platform/tenancy/page-host";

import proxy, { routedHostHeaders } from "./proxy";

// ADR-0006, rule 1: `src/proxy.ts` reads the host off `new URL(request.url).host`, **deletes any
// inbound `x-toi-routed-host`**, and sets it fresh. A client can never supply the value, because
// the proxy overwrites it on every request. These are the packet's three named negatives, at the
// proxy layer: the forged inbound header is replaced (also as a duplicate header line), the value
// comes from the URL and never from `Host`, and the proxy always passes the request through.

function inbound(headers: Record<string, string | string[]>): Headers {
  const h = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const v of value) h.append(name, v);
    else h.set(name, value);
  }
  return h;
}

describe("routedHostHeaders (ADR-0006 rule 1, pure half)", () => {
  it("replaces a forged inbound x-toi-routed-host with the routed URL's host", () => {
    const h = inbound({
      host: "company1.terraoi.app",
      [ROUTED_HOST_HEADER]: "company2.terraoi.app",
    });
    const out = routedHostHeaders(h, "https://company1.terraoi.app/login");
    expect(out.get(ROUTED_HOST_HEADER)).toBe("company1.terraoi.app");
  });

  it("collapses duplicate forged lines to exactly one authoritative value", () => {
    const h = inbound({
      host: "company1.terraoi.app",
      [ROUTED_HOST_HEADER]: ["company2.terraoi.app", "evil.example"],
    });
    // Before the rewrite the two forged values are both present; after it, neither survives.
    expect(h.get(ROUTED_HOST_HEADER)).toBe("company2.terraoi.app, evil.example");
    const out = routedHostHeaders(h, "https://company1.terraoi.app/login");
    expect(out.get(ROUTED_HOST_HEADER)).toBe("company1.terraoi.app");
  });

  it("takes the host from the URL, never from Host or X-Forwarded-Host", () => {
    const h = inbound({
      host: "company2.terraoi.app",
      "x-forwarded-host": "company2.terraoi.app",
    });
    const out = routedHostHeaders(h, "https://company1.terraoi.app/chat");
    expect(out.get(ROUTED_HOST_HEADER)).toBe("company1.terraoi.app");
    // The headers a page must never read are passed through untouched: the proxy does not
    // sanitize them, it only makes the authoritative one available (ADR-0006 rule 2).
    expect(out.get("host")).toBe("company2.terraoi.app");
    expect(out.get("x-forwarded-host")).toBe("company2.terraoi.app");
  });

  it("does not mutate the caller's headers object", () => {
    const h = inbound({ [ROUTED_HOST_HEADER]: "forged.example" });
    routedHostHeaders(h, "https://company1.terraoi.app/");
    expect(h.get(ROUTED_HOST_HEADER)).toBe("forged.example");
  });

  it("sets nothing when the URL cannot be parsed, so the page fails closed instead of guessing", () => {
    const h = inbound({ [ROUTED_HOST_HEADER]: "forged.example" });
    const out = routedHostHeaders(h, "not a url");
    expect(out.get(ROUTED_HOST_HEADER)).toBeNull();
  });

  it("keeps the inbound cookie and other headers intact", () => {
    const h = inbound({ cookie: "toi_session=opaque", "user-agent": "ua" });
    const out = routedHostHeaders(h, "https://company1.terraoi.app/login");
    expect(out.get("cookie")).toBe("toi_session=opaque");
    expect(out.get("user-agent")).toBe("ua");
    expect(out.get(ROUTED_HOST_HEADER)).toBe("company1.terraoi.app");
  });
});

describe("proxy(request) (ADR-0006 rule 1, Next half)", () => {
  it("sends the routed host as a request-header override and drops the forged value", () => {
    // Next applies a proxy's request-header rewrite through `x-middleware-override-headers` plus
    // one `x-middleware-request-<name>` entry per overridden header — the shape the edge forwards
    // to the page. Observed against Next 16.4.5 before this test was written, not assumed.
    const request = new NextRequest("https://company1.terraoi.app/login", {
      headers: inbound({
        host: "company1.terraoi.app",
        [ROUTED_HOST_HEADER]: "company2.terraoi.app",
        cookie: "toi_session=opaque",
      }),
    });
    const res = proxy(request);
    expect(res.headers.get("x-middleware-override-headers")).toContain(ROUTED_HOST_HEADER);
    expect(res.headers.get(`x-middleware-request-${ROUTED_HOST_HEADER}`)).toBe("company1.terraoi.app");
    expect([...res.headers.values()].join("\n")).not.toContain("company2.terraoi.app");
  });

  it("always passes the request through: never a redirect, never a block", () => {
    const request = new NextRequest("https://company1.terraoi.app/anything/at/all");
    const res = proxy(request);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.status).toBe(200);
  });

  it("adds the header on a request that carried none (a page with no header is the proxy's job to fix)", () => {
    const request = new NextRequest("https://company2.terraoi.app/login", {
      headers: inbound({ host: "company2.terraoi.app" }),
    });
    const res = proxy(request);
    expect(res.headers.get(`x-middleware-request-${ROUTED_HOST_HEADER}`)).toBe("company2.terraoi.app");
  });
});
