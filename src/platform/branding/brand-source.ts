import { z } from "zod";

import type { BrandSource } from "./tenant-brand";
import type { BrandSourceReader } from "./load-tenant-brand";
import { BRAND_ASSET_EXTENSIONS, MAX_BRAND_ASSET_BYTES } from "./brand-rules";

/**
 * The deployment reader F04 has been waiting for (#62 answered, T-103's second half).
 * `load-tenant-brand.ts` kept its source as an injected port whose honest default was "no row";
 * this file is what replaces that default with the real `tenant_brands` row, and it is the only
 * place in the module that talks to the database.
 *
 * What it deliberately does **not** do:
 *
 * - It reads no request state. `branding-boundary.test.ts` fails the build if this module ever
 *   mentions a header, a cookie or a query string, and that rule is the plan §5.1 line 261 rule
 *   ("tenant configuration, never an arbitrary public selector") made unbreakable. The caller hands
 *   in a host it already resolved through F01, and this file trusts that.
 * - It asks for nothing beyond the public projection. `load_public_brand(text)` in
 *   `20261109213000_brand_config.sql` returns the presentation columns only — no `config_version`
 *   column, no `legal_name`, no reply-to, no organisation id — so a reader bug cannot leak a
 *   never-pre-sign-in field, and the cache in §4.4 can only ever hold what this row can carry.
 * - It does not accept a row it cannot fully check. A row with an unexpected key, an unmeasured
 *   asset or a path that is not this system's own `<version>/<name>` form throws, and
 *   `loadTenantBrand` turns any throw into the `source_error` fallback with platform branding: a
 *   half-trusted brand row never reaches a page.
 */

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface BrandSourceEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
}

const RPC_LOAD_BRAND = "/rpc/load_public_brand";
const RPC_LOAD_ASSET = "/rpc/load_public_brand_asset";

/**
 * The row exactly as `load_public_brand` returns it: snake_case, because that is the SQL projection,
 * mapped to the contract's camelCase here and nowhere else (ADR-0001: the mapping happens once).
 * `strict` matters — an extra column appearing in the projection is a schema change someone should
 * notice here rather than a value that silently travels into a page.
 */
const PublicBrandRowSchema = z.strictObject({
  mode: z.enum(["powered", "customer"]),
  display_name: z.string(),
  descriptor: z.string(),
  tagline: z.string(),
  primary_color: z.string(),
  on_primary_color: z.string(),
  accent_color: z.string(),
  logo_path: z.string().nullable(),
  logo_bytes: z.number().int().nullable(),
  favicon_path: z.string().nullable(),
  favicon_bytes: z.number().int().nullable(),
  support_label: z.string(),
  support_url: z.string().nullable(),
  report_owner: z.string(),
  email_sender_name: z.string(),
  document_prefix: z.string(),
  show_powered_by: z.boolean(),
});

/**
 * `<config_version>/<name>` as the SQL composes it, and the only form the asset route can serve. A
 * path that did not come from this composition — a bare name, a deeper path, an uppercase variant —
 * is refused rather than normalized, because the version segment is what makes the served URL
 * immutable (FAQ-0008).
 */
const VERSIONED_ASSET_PATH = /^\d{1,18}\/[a-z0-9][a-z0-9._-]{0,99}$/;

export class BrandSourceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandSourceFailure";
  }
}

function rpcBindings(env: BrandSourceEnv): { baseUrl: string; anonKey: string } {
  const baseUrl = typeof env.SUPABASE_URL === "string" ? env.SUPABASE_URL.replace(/\/+$/, "") : "";
  const anonKey = typeof env.SUPABASE_ANON_KEY === "string" ? env.SUPABASE_ANON_KEY : "";
  if (baseUrl.length === 0 || anonKey.length === 0) {
    // The same binding rule the merged identity adapter uses. A missing binding is a deployment
    // error, and loadTenantBrand reports it as `source_error` with platform branding rather than
    // letting a page render a half-brand.
    throw new BrandSourceFailure("SUPABASE_URL and SUPABASE_ANON_KEY bindings are required");
  }
  return { baseUrl, anonKey };
}

async function callRpc<T>(
  env: BrandSourceEnv,
  path: string,
  body: Record<string, unknown>,
  fetchImpl: FetchImpl,
): Promise<T[]> {
  const { baseUrl, anonKey } = rpcBindings(env);
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: "POST",
    // The publishable key only: this projection is the one an anonymous visitor of that host is
    // allowed to see, and a service-role key here would be a §4.2 privileged path with no ADR.
    headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new BrandSourceFailure(`brand read refused with status ${response.status}`);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new BrandSourceFailure("brand read returned an unreadable body");
  }
  if (!Array.isArray(payload)) throw new BrandSourceFailure("brand read returned an unexpected shape");
  return payload as T[];
}

function assetOf(path: string | null, bytes: number | null): { path: string; bytes: number } | null {
  if (path === null && bytes === null) return null;
  if (path === null || bytes === null) {
    // One half of the pair without the other is a projection bug, and treating it as "no logo" is
    // exactly the half-brand the packet's failure box forbids.
    throw new BrandSourceFailure("brand asset path and size must agree");
  }
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (!VERSIONED_ASSET_PATH.test(path) || !BRAND_ASSET_EXTENSIONS.includes(extension)) {
    throw new BrandSourceFailure("brand asset path is not a versioned brand asset");
  }
  if (bytes <= 0 || bytes > MAX_BRAND_ASSET_BYTES) {
    // Both the unmeasured and the oversized case are refusals: brand-rules.ts cannot clear a limit it
    // has no number for, and #117's 64 KiB ceiling is not negotiable at read time either.
    throw new BrandSourceFailure("brand asset size is outside the allowed range");
  }
  return { path, bytes };
}

function rowToSource(row: unknown): BrandSource {
  const parsed = PublicBrandRowSchema.safeParse(row);
  if (!parsed.success) throw new BrandSourceFailure("brand row does not match the public projection");
  const r = parsed.data;
  const logo = assetOf(r.logo_path, r.logo_bytes);
  const favicon = assetOf(r.favicon_path, r.favicon_bytes);
  return {
    mode: r.mode,
    displayName: r.display_name,
    descriptor: r.descriptor,
    tagline: r.tagline,
    primary: r.primary_color,
    onPrimary: r.on_primary_color,
    accent: r.accent_color,
    showPoweredBy: r.show_powered_by,
    supportLabel: r.support_label,
    reportOwner: r.report_owner,
    emailSenderName: r.email_sender_name,
    documentPrefix: r.document_prefix,
    ...(r.support_url !== null ? { supportUrl: r.support_url } : {}),
    ...(logo !== null ? { logo } : {}),
    ...(favicon !== null ? { favicon } : {}),
  };
}

/**
 * The reader to pass as `loadTenantBrand({ readSource })`. `undefined` means "this host has no brand
 * row", which is the packet's failure box (platform fallback plus an admin-visible note); a throw
 * means "the read failed", which the loader turns into the same shape with a different reason.
 */
export function brandSourceReader(
  env: BrandSourceEnv,
  options: { fetchImpl?: FetchImpl } = {},
): BrandSourceReader {
  const fetchImpl: FetchImpl = options.fetchImpl ?? ((fetch as unknown) as FetchImpl);
  return async (host: string): Promise<BrandSource | undefined> => {
    const rows = await callRpc<unknown>(env, RPC_LOAD_BRAND, { p_host: host }, fetchImpl);
    if (rows.length === 0) return undefined;
    // One host, one row: `unique (organisation_id)` in the schema makes more than one a bug, and a
    // silent first-of-many would be a brand chosen by ordering.
    if (rows.length > 1) throw new BrandSourceFailure("more than one brand row for one host");
    return rowToSource(rows[0]);
  };
}

export interface BrandAsset {
  contentType: string;
  bytes: Uint8Array;
}

const BRAND_CONTENT_TYPES: readonly string[] = ["image/svg+xml", "image/png", "image/x-icon"];

const AssetRowSchema = z.strictObject({
  content_type: z.string(),
  content_base64: z.string(),
  byte_size: z.number().int(),
});

function decodeBase64(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value.replace(/=+$/, "")) {
    const index = digits.indexOf(character);
    if (index < 0) return null;
    buffer = (buffer << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * The bytes behind one `/brand-assets/{version}/{name}` URL, for the host that was routed to. No row
 * is a normal answer, and it is the same answer for an unknown host, version or name: the SQL side
 * cannot tell those cases apart either, which is what lets the route serve one identical 404.
 *
 * `content_base64` rather than a raw byte column on the wire is a migration decision with a reason
 * (see that function's comment): PostgREST renders `bytea` according to the connection's
 * `bytea_output`, and a logo should not depend on that.
 */
export async function readBrandAsset(
  env: BrandSourceEnv,
  input: { host: string; configVersion: string; name: string },
  options: { fetchImpl?: FetchImpl } = {},
): Promise<BrandAsset | undefined> {
  const fetchImpl: FetchImpl = options.fetchImpl ?? ((fetch as unknown) as FetchImpl);
  const rows = await callRpc<unknown>(
    env,
    RPC_LOAD_ASSET,
    { p_host: input.host, p_config_version: Number(input.configVersion), p_name: input.name },
    fetchImpl,
  );
  if (rows.length === 0) return undefined;
  const parsed = AssetRowSchema.safeParse(rows[0]);
  if (!parsed.success) throw new BrandSourceFailure("brand asset row does not match the projection");
  if (!BRAND_CONTENT_TYPES.includes(parsed.data.content_type) || parsed.data.byte_size <= 0
      || parsed.data.byte_size > MAX_BRAND_ASSET_BYTES) {
    throw new BrandSourceFailure("brand asset type or size is not allowed");
  }
  const bytes = decodeBase64(parsed.data.content_base64);
  if (bytes === null || bytes.length !== parsed.data.byte_size) {
    // The declared size and the delivered bytes must agree before a single byte is served, so a
    // truncated body cannot be presented as a complete immutable asset.
    throw new BrandSourceFailure("brand asset bytes do not match the declared size");
  }
  return { contentType: parsed.data.content_type, bytes };
}

/**
 * How a page turns the projection's `logoPath` into a URL. The path is already versioned, so this is
 * prefix-only: nothing here chooses a version, and a page cannot ask for another tenant's asset by
 * editing a name (FAQ-0008).
 */
export function brandAssetUrl(versionedPath: string | null): string | null {
  if (versionedPath === null || !VERSIONED_ASSET_PATH.test(versionedPath)) return null;
  return `/brand-assets/${versionedPath}`;
}
