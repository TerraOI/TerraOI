import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearedCookie,
  cookieName,
  isHttpsUrl,
  parseCookieHeader,
  serializeSetCookie,
  type CookieSpec,
} from "./cookie";

// Plan §4.2: "Use host-only Secure, HttpOnly session cookies without Domain=.terraoi.app; use the
// __Host- prefix where the selected auth adapter supports its requirements." TerraOI *is* the
// adapter, so the prefix is available: these tests are the acceptance item "host-only cookie
// (no Domain=), Secure, HttpOnly, SameSite=Lax, __Host- prefix".
const BASE: CookieSpec = {
  name: "__Host-toi_session",
  value: "dGVzdHRva2Vu",
  maxAge: 28_800,
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
};

describe("serializeSetCookie (host-only session cookie)", () => {
  it("produces a host-only, Secure, HttpOnly, SameSite=Lax cookie with the __Host- prefix", () => {
    expect(serializeSetCookie(BASE)).toBe(
      "__Host-toi_session=dGVzdHRva2Vu; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Lax",
    );
  });

  it("never emits a Domain= attribute, even when a caller tries to smuggle one", () => {
    const smuggled = { ...BASE, domain: ".terraoi.app" } as unknown as CookieSpec;
    const header = serializeSetCookie(smuggled);
    expect(header).not.toMatch(/domain=/i);
    expect(header).not.toContain("terraoi.app;");
    // A sibling subdomain must not be able to read the session through a parent-domain cookie.
    expect(header.startsWith("__Host-")).toBe(true);
  });

  it("clears a cookie with Max-Age=0 rather than dropping the name", () => {
    expect(serializeSetCookie({ ...BASE, maxAge: 0 })).toContain("Max-Age=0");
  });

  it("refuses a __Host- name without Secure (the prefix would be ignored by the browser)", () => {
    expect(() => serializeSetCookie({ ...BASE, secure: false })).toThrow(/secure/i);
  });

  it("refuses a __Host- name scoped to a path below the root", () => {
    expect(() => serializeSetCookie({ ...BASE, path: "/login" })).toThrow(/path/i);
  });

  it("refuses SameSite=None without Secure, and never emits SameSite=None for a session", () => {
    expect(() => serializeSetCookie({ ...BASE, sameSite: "None", secure: false })).toThrow(/secure/i);
    expect(() => serializeSetCookie({ ...BASE, sameSite: "None" })).toThrow(/same-?site/i);
  });

  it("carries a signed token value verbatim (payload.signature needs no escaping)", () => {
    const token = "eyJ0eXAiOiJzZXNzaW9uIn0.dGhlLXNpZ25hdHVyZQ";
    expect(serializeSetCookie({ ...BASE, value: token })).toContain(`=${token};`);
  });

  it("accepts only opaque values: no separators, spaces, quotes or non-ASCII", () => {
    for (const value of [
      "a;b",
      "a b",
      "a=b",
      "a\"b",
      "",
      "café",
      "tok+en/",
      "tok=en",
    ]) {
      expect(() => serializeSetCookie({ ...BASE, value })).toThrow(/value/i);
    }
  });

  it("accepts only a cookie name that cannot inject attributes", () => {
    for (const name of ["", "bad name", "bad;name", "__Host-bäd", "x".repeat(200)]) {
      expect(() => serializeSetCookie({ ...BASE, name })).toThrow(/name/i);
    }
  });

  it("refuses a negative or non-integer Max-Age", () => {
    for (const maxAge of [-1, 1.5, Number.NaN]) {
      expect(() => serializeSetCookie({ ...BASE, maxAge })).toThrow(/max-age/i);
    }
  });
});

describe("parseCookieHeader", () => {
  it("reads the session cookie back out of a browser Cookie header", () => {
    const header = "__Host-toi_session=abc123; other=1; theme=dark";
    expect(parseCookieHeader(header)["__Host-toi_session"]).toBe("abc123");
  });

  it("returns nothing for a missing, empty or malformed header instead of guessing", () => {
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader("")).toEqual({});
    expect(parseCookieHeader("garbage")).toEqual({});
    expect(parseCookieHeader("=novalue; ok=1")).toEqual({ ok: "1" });
  });

  it("keeps the first value when a name is repeated, so a smuggled duplicate cannot shadow one", () => {
    expect(parseCookieHeader("a=first; a=second")["a"]).toBe("first");
  });
});

describe("cookieName / isHttpsUrl", () => {
  it("uses the __Host- prefix whenever the transport is secure", () => {
    expect(cookieName("toi_session", true)).toBe("__Host-toi_session");
  });

  it("recognizes only an https routed URL as a secure transport", () => {
    expect(isHttpsUrl("https://company1.terraoi.app/login")).toBe(true);
    expect(isHttpsUrl("http://company1.terraoi.app/login")).toBe(false);
    expect(isHttpsUrl("http://localhost:3000/login")).toBe(false);
    expect(isHttpsUrl("not a url")).toBe(false);
  });
});

// The PR #18 N1 lesson, applied to cookies: an escape hatch must be bound to the environment, not
// merely explicit at the call site. A production path that "works right because nobody passes
// false" is the bug shape, so the non-`__Host-`, non-`Secure` form exists only in a development
// runtime. That also protects the staging check the packet asks for: a mis-proxied `http://` request
// URL cannot quietly produce a non-Secure session cookie that nobody objects to.
describe("the non-__Host- form is bound to a development runtime", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses an unprefixed cookie name outside a development runtime", () => {
    expect(() => cookieName("toi_session", false)).toThrow(/development/i);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => cookieName("toi_session", false)).toThrow(/development/i);
  });

  it("refuses a cookie without Secure outside a development runtime, whatever the name", () => {
    expect(() => serializeSetCookie({ ...BASE, name: "toi_session", secure: false })).toThrow(/secure/i);
    vi.stubEnv("NODE_ENV", "production");
    expect(() => serializeSetCookie({ ...BASE, name: "toi_session", secure: false })).toThrow(/secure/i);
  });

  it("allows both in an explicit development runtime so `next dev` still works", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(cookieName("toi_session", false)).toBe("toi_session");
    expect(serializeSetCookie({ ...BASE, name: "toi_session", secure: false })).toBe(
      "toi_session=dGVzdHRva2Vu; Path=/; Max-Age=28800; HttpOnly; SameSite=Lax",
    );
  });

  it("still refuses a __Host- name without Secure even in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => serializeSetCookie({ ...BASE, secure: false })).toThrow(/secure/i);
  });

  it("a cleared cookie follows the same rule", () => {
    expect(() => clearedCookie("toi_session", false)).toThrow(/development/i);
    vi.stubEnv("NODE_ENV", "development");
    expect(serializeSetCookie(clearedCookie("toi_session", false))).toBe("toi_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
  });
});
