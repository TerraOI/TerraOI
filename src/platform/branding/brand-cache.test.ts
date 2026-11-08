import { NormalizedHost } from "@/contracts/keys";
import { describe, expect, it } from "vitest";

import { platformBrand } from "./kit-brand";
import { createBrandCache } from "./brand-cache";
import type { ResolvedBrand } from "./load-tenant-brand";

/**
 * T-103 acceptance: "the public brand cache is hostname-keyed, bounded, and contains **no**
 * membership data" (plan §4.4: the brand cache is a public cache, so anything keyed on a member is
 * a cross-principal leak waiting to happen, and an unbounded map in a Worker isolate is an outage).
 */

function resolved(displayName = "Company1 Drilling"): ResolvedBrand {
  return {
    brand: { ...platformBrand(), displayName, host: "company1.terraoi.app", mode: "powered" },
    origin: "tenant",
    fallback: null,
  };
}

describe("bounded", () => {
  it("never grows past maxEntries and drops the least recently used host", () => {
    const cache = createBrandCache({ maxEntries: 3 });
    for (const host of ["a.terraoi.app", "b.terraoi.app", "c.terraoi.app", "d.terraoi.app"]) {
      cache.set(host, resolved(host));
    }
    expect(cache.size()).toBe(3);
    expect(cache.get("a.terraoi.app")).toBeUndefined();
    expect(cache.get("d.terraoi.app")?.brand.displayName).toBe("d.terraoi.app");
  });

  it("counts a read as use, so a host being served is not the one evicted", () => {
    const cache = createBrandCache({ maxEntries: 2 });
    cache.set("a.terraoi.app", resolved("A"));
    cache.set("b.terraoi.app", resolved("B"));
    cache.get("a.terraoi.app");
    cache.set("c.terraoi.app", resolved("C"));
    expect(cache.get("a.terraoi.app")?.brand.displayName).toBe("A");
    expect(cache.get("b.terraoi.app")).toBeUndefined();
  });

  it("expires an entry after its time to live, using an injected clock", () => {
    let now = 1_000_000;
    const cache = createBrandCache({ maxEntries: 4, ttlMs: 60_000, now: () => now });
    cache.set("a.terraoi.app", resolved("A"));
    expect(cache.get("a.terraoi.app")?.brand.displayName).toBe("A");
    now += 59_000;
    expect(cache.get("a.terraoi.app")).toBeDefined();
    now += 2_000;
    expect(cache.get("a.terraoi.app")).toBeUndefined();
    expect(cache.size()).toBe(0);
  });
});

describe("hostname-keyed", () => {
  it("stores one entry per host and nothing else in the key space", () => {
    const cache = createBrandCache({ maxEntries: 8 });
    cache.set("company1.terraoi.app", resolved("one"));
    cache.set("company2.terraoi.app", resolved("two"));
    expect(cache.size()).toBe(2);
    for (const key of cache.keys()) {
      expect(NormalizedHost.safeParse(key).success, key).toBe(true);
    }
  });

  it("refuses a key that is not a normalized host, so one tenant cannot get two entries or a path", () => {
    const cache = createBrandCache({ maxEntries: 8 });
    for (const bad of ["Company1.TerraOI.app", "company1.terraoi.app/settings", "", "*.terraoi.app", "company1.terraoi.app?brand=customer"]) {
      expect(cache.set(bad, resolved()), bad).toBe(false);
    }
    expect(cache.size()).toBe(0);
    expect(cache.get("company1.terraoi.app")).toBeUndefined();
  });

  it("keeps the two halves of a hostname apart: a suffix never aliases to another tenant", () => {
    const cache = createBrandCache({ maxEntries: 8 });
    cache.set("company1.terraoi.app", resolved("Company1"));
    expect(cache.get("company2.terraoi.app")).toBeUndefined();
    expect(cache.get("terraoi.app")).toBeUndefined();
  });
});

describe("contains no membership data", () => {
  it("refuses a value carrying identity fields, even alongside a valid brand", () => {
    const cache = createBrandCache({ maxEntries: 8 });
    const smuggled = {
      ...resolved(),
      userId: "11111111-1111-4111-8111-111111111111",
      membershipId: "22222222-2222-4222-8222-222222222222",
      roles: ["knowledge.admin"],
    } as unknown as ResolvedBrand;
    expect(cache.set("company1.terraoi.app", smuggled)).toBe(false);
    expect(cache.get("company1.terraoi.app")).toBeUndefined();
  });

  it("refuses a brand value whose shape was not validated, because a cached bad brand outlives the request that produced it", () => {
    const cache = createBrandCache({ maxEntries: 8 });
    const malformed = { brand: { mode: "customer" }, origin: "tenant", fallback: null } as unknown as ResolvedBrand;
    expect(cache.set("company1.terraoi.app", malformed)).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("serves a deep-frozen value, so a render cannot widen a cached brand in place", () => {
    const cache = createBrandCache({ maxEntries: 8 });
    cache.set("company1.terraoi.app", resolved("Company1"));
    const hit = cache.get("company1.terraoi.app");
    expect(hit).toBeDefined();
    expect(Object.isFrozen(hit)).toBe(true);
    expect(Object.isFrozen(hit?.brand)).toBe(true);
  });

  it("holds no cookie, token or credential material in any entry", () => {
    const cache = createBrandCache({ maxEntries: 8 });
    cache.set("company1.terraoi.app", resolved("Company1"));
    cache.set("terraoi.app", { brand: platformBrand(), origin: "platform", fallback: null });
    const dump = JSON.stringify([...cache.keys()].map((key) => cache.get(key)));
    expect(dump).not.toMatch(/(eyJ[A-Za-z0-9_-]{10,}|Set-Cookie|accessToken|refreshToken|serviceRole|anonKey)/i);
  });
});
