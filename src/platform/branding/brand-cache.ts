import { NormalizedHost } from "@/contracts/keys";
import { ResolvedBrandSchema, type ResolvedBrand } from "./tenant-brand";

/**
 * The public brand cache (plan §4.4: brand is public for a host, so it may be cached at the edge of
 * a Worker isolate - and only brand may be).
 *
 * T-103's acceptance box is exact: "the public brand cache is **hostname-keyed, bounded**, and
 * contains **no** membership data". All three are enforced here, not just documented:
 *
 * - hostname-keyed: the key must satisfy `NormalizedHost`, so one host gets one entry and a path,
 *   a wildcard or a mixed-case spelling can never open a second entry that a later request reads;
 * - bounded: a fixed capacity with least-recently-used eviction and a time to live. A `Map` that
 *   grows with traffic is an outage in a Worker isolate; an entry that never expires is a brand
 *   change that never arrives;
 * - no membership data: the **value** is re-parsed against `ResolvedBrandSchema`, which is strict,
 *   so a `userId`, `membershipId`, `roles` or token sitting alongside a brand makes the write fail
 *   instead of becoming a cross-principal hit.
 */

export type BrandCacheOptions = { maxEntries?: number; ttlMs?: number; now?: () => number };

export const DEFAULT_MAX_ENTRIES = 64;
/** Five minutes: long enough to absorb a page load's worth of surfaces, short enough that a brand
 * fix shows up in minutes without a deploy. Not a platform policy - it is a per-isolate cost lever,
 * and the packet says only "bounded". */
export const DEFAULT_TTL_MS = 300_000;

export type BrandCache = {
  get(host: string): ResolvedBrand | undefined;
  set(host: string, value: ResolvedBrand): boolean;
  delete(host: string): boolean;
  keys(): string[];
  size(): number;
  clear(): void;
};

type Entry = { value: ResolvedBrand; expiresAt: number };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function createBrandCache(options: BrandCacheOptions = {}): BrandCache {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, Entry>();

  function live(host: string): Entry | undefined {
    const entry = entries.get(host);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now()) {
      entries.delete(host);
      return undefined;
    }
    return entry;
  }

  return {
    get(host: string): ResolvedBrand | undefined {
      const entry = live(host);
      if (entry === undefined) return undefined;
      // Re-inserting marks it most recently used; `Map` iteration order is insertion order.
      entries.delete(host);
      entries.set(host, entry);
      return entry.value;
    },

    set(host: string, value: ResolvedBrand): boolean {
      if (!NormalizedHost.safeParse(host).success) return false;
      const parsed = ResolvedBrandSchema.safeParse(value);
      if (!parsed.success) return false;
      entries.delete(host);
      entries.set(host, { value: deepFreeze(parsed.data), expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
      return true;
    },

    delete(host: string): boolean {
      return entries.delete(host);
    },

    keys(): string[] {
      for (const host of [...entries.keys()]) live(host);
      return [...entries.keys()];
    },

    size(): number {
      for (const host of [...entries.keys()]) live(host);
      return entries.size;
    },

    clear(): void {
      entries.clear();
    },
  };
}

let shared: BrandCache | null = null;

/**
 * The per-isolate default cache. One instance per Worker isolate, bounded and host-keyed - which is
 * exactly the shape plan §4.4 allows for public data. `loadTenantBrand` only uses it when a caller
 * asks for caching, so a test or a one-off read never lands in the shared map.
 */
export function brandCache(options: BrandCacheOptions = {}): BrandCache {
  if (shared === null) shared = createBrandCache(options);
  return shared;
}

export { createBrandCache };
