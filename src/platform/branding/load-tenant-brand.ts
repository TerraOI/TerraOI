import { parseHost } from "@/platform/tenancy/host";
import { platformBrandForHost } from "./kit-brand";
import { parseTenantBrand, ResolvedBrandSchema, type BrandFallbackReason, type ResolvedBrand } from "./tenant-brand";
import { brandCache, type BrandCacheOptions } from "./brand-cache";

/**
 * F04 `loadTenantBrand` (plan §11 line 694): "Host-resolved org + config version -> safe product
 * identity". One call, one host, one validated brand - or the platform brand with a reason an admin
 * surface can show.
 *
 * The host comes in exactly as [F01](../tenancy/host.ts) produced it, and nothing here looks at a
 * query string, a cookie or a header: plan §5.1 line 261 says the mode is tenant configuration,
 * "never an arbitrary public brand selector or cross-customer selector", and `branding-boundary.test.ts`
 * fails the build if this module ever starts reading request state.
 *
 * **Where the tenant row comes from is not decided here.** #62 records that no packet owns
 * `tenant_brands` (the table, the mode column, and the ADR-0004 that ADR-0004 proposes). So the row
 * arrives through an injected reader, and the default reader answers "no row", which is the truth on
 * `main` today. When #62 lands, the deployment adapter supplies a reader that selects by
 * host-resolved organisation and nothing else; no surface between here and there changes.
 */

export type BrandSourceReader = (host: string) => unknown | Promise<unknown>;

export type LoadBrandOptions = {
  host: string;
  readSource?: BrandSourceReader;
  cache?: boolean | BrandCacheOptions;
};

export type { ResolvedBrand };

/** Admin-visible copy. Names the problem class, never the customer's data, and never the reason list. */
const FALLBACK_NOTES: Record<BrandFallbackReason, string> = {
  unknown_host: "This address is not a recognized workspace address, so platform branding is shown.",
  no_brand_row: "This workspace has not configured branding yet, so platform branding is shown.",
  invalid_brand: "This workspace's branding is incomplete or invalid, so platform branding is shown until it is fixed.",
  source_error: "Branding could not be read right now, so platform branding is shown.",
};

function fallback(reason: BrandFallbackReason, host: string): ResolvedBrand {
  return { brand: platformBrandForHost(host), origin: "platform", fallback: { reason, note: FALLBACK_NOTES[reason] } };
}

function resolveCache(options: LoadBrandOptions["cache"]): ReturnType<typeof brandCache> | null {
  if (options === undefined || options === false) return null;
  return brandCache(typeof options === "object" ? options : {});
}

/**
 * Never throws and never returns a half-brand: a page that renders chrome from this value must be
 * able to render *something* correct even when the configuration is broken (the packet's failure
 * box: "never a blank shell or a crash").
 */
export async function loadTenantBrand(options: LoadBrandOptions): Promise<ResolvedBrand> {
  const hostParse = parseHost(options.host);

  // An unrecognized host is not a tenant that happens to have no brand: nothing is read for it, so
  // there is no path from "I typed a wrong address" to "I just saw another customer's brand".
  if (!hostParse.ok) return fallback("unknown_host", typeof options.host === "string" ? options.host : "");

  const cache = resolveCache(options.cache);
  if (cache !== null) {
    const hit = cache.get(hostParse.host);
    if (hit !== undefined) return hit;
  }

  // Platform and admin surfaces are TerraOI-branded by definition (plan §5.1: `terraoi` mode is for
  // platform-owned surfaces), and they never consult a tenant row.
  if (hostParse.class !== "tenant") return finish(cache, { brand: platformBrandForHost(hostParse.host), origin: "platform", fallback: null });

  const read: BrandSourceReader = options.readSource ?? (() => undefined);
  let source: unknown;
  try {
    source = await read(hostParse.host);
  } catch {
    // The thrown value is deliberately unread: an error from the store can quote a connection
    // string, and this value is handed to a page.
    return finish(cache, fallback("source_error", hostParse.host));
  }

  if (source === undefined || source === null) return finish(cache, fallback("no_brand_row", hostParse.host));

  const parsed = parseTenantBrand(hostParse.host, source);
  if (!parsed.ok) return finish(cache, fallback("invalid_brand", hostParse.host));

  return finish(cache, { brand: parsed.brand, origin: "tenant", fallback: null });
}

function finish(cache: ReturnType<typeof brandCache> | null, value: ResolvedBrand): ResolvedBrand {
  if (cache !== null) cache.set(value.brand.host, value);
  // The schema is re-checked on the way out so that no caller can receive a value the cache would
  // have refused: a brand that only lives in one isolate's memory is the worst place to find a bug.
  return ResolvedBrandSchema.parse(value);
}
