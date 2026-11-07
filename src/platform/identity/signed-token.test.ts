import { describe, expect, it } from "vitest";

import { randomToken, signToken, verifyToken } from "./signed-token";

// The signing secret comes from a deployment binding. Nothing in this repository may carry one,
// and a token must never be signed with an empty or default key (AGENTS.md §4.6).
const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";

describe("signToken / verifyToken (HMAC, plan §4.2 host-bound session)", () => {
  it("round-trips claims", async () => {
    const claims = { typ: "session", sub: "00000000-0000-4000-8000-0000000000a1", host: "company1.terraoi.app", iat: 1000, exp: 2000 };
    const token = await signToken(claims, SECRET);
    expect(await verifyToken(token, SECRET)).toEqual(claims);
  });

  it("is a two-part opaque string that needs no escaping in a cookie or a query value", async () => {
    const token = await signToken({ typ: "session", sub: "x", exp: 1 }, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("survives a non-ASCII claim value", async () => {
    const claims = { typ: "state", note: "Zoë–Bücher 🛰", exp: 1 };
    expect(await verifyToken(await signToken(claims, SECRET), SECRET)).toEqual(claims);
  });

  it("refuses a token whose payload was edited, even re-encoded correctly", async () => {
    const token = await signToken({ typ: "session", sub: "user-a", host: "company1.terraoi.app", exp: 9999999999 }, SECRET);
    const [payload] = token.split(".");
    const edited = Buffer.from(JSON.stringify({ typ: "session", sub: "user-b", host: "company1.terraoi.app", exp: 9999999999 }), "utf8").toString("base64url");
    expect(await verifyToken(`${edited}.${payload === undefined ? "" : token.split(".")[1]}`, SECRET)).toBeNull();
    expect(await verifyToken(`${edited}.`, SECRET)).toBeNull();
  });

  it("refuses a flipped signature character", async () => {
    const [head, tail] = (await signToken({ typ: "session", sub: "a", exp: 1 }, SECRET)).split(".");
    const flipped = (tail ?? "").slice(0, -1) + ((tail ?? "").endsWith("A") ? "B" : "A");
    expect(await verifyToken(`${head}.${flipped}`, SECRET)).toBeNull();
  });

  it("refuses anything signed with another key", async () => {
    const token = await signToken({ typ: "session", sub: "a", exp: 1 }, SECRET);
    expect(await verifyToken(token, `${SECRET}-other`)).toBeNull();
  });

  it("refuses malformed input without throwing", async () => {
    for (const token of ["", ".", "abc", "abc.", ".def", "abc.def.ghi", "a b.c d"]) {
      expect(await verifyToken(token, SECRET)).toBeNull();
    }
  });

  it("refuses a payload that is not a JSON object of scalar claims", async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    for (const payload of [encode([1, 2]), encode("string"), encode(null), encode({ nested: { a: 1 } }), encode({})]) {
      const forged = `${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
      expect(await verifyToken(forged, SECRET)).toBeNull();
    }
  });

  it("fails closed on a missing or empty signing secret", async () => {
    await expect(signToken({ typ: "session", sub: "a", exp: 1 }, "")).rejects.toThrow();
    await expect(signToken({ typ: "session", sub: "a", exp: 1 }, undefined as unknown as string)).rejects.toThrow();
    await expect(verifyToken("abc.def", "")).rejects.toThrow();
  });

  it("rejects claims that are not scalars at signing time", async () => {
    await expect(signToken({ typ: "session", sub: { nested: 1 } } as never, SECRET)).rejects.toThrow();
    await expect(signToken({ typ: "session", sub: [1, 2] } as never, SECRET)).rejects.toThrow();
  });
});

describe("randomToken", () => {
  it("returns url-safe opaque values that do not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const value = randomToken();
      expect(value).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      seen.add(value);
    }
    expect(seen.size).toBe(200);
  });
});
