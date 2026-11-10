import { parseHost, requestHost } from "@/platform/tenancy/host";

import { BRAND_ASSET_EXTENSIONS, MAX_BRAND_ASSET_BYTES } from "./brand-rules";
import type { BrandAsset } from "./brand-source";

/**
 * `GET /brand-assets/{configVersion}/{name}` — the customer half of FAQ-0008. The version is in the
 * path, so the bytes behind a URL never change, which is what makes an immutable `Cache-Control`
 * honest rather than a hope.
 *
 * Two rules decide everything here:
 *
 * - **The host comes from the routed request URL only.** A route handler has a real request URL, so
 *   this follows ADR-0006 rule 3 and ADR-0004 §3: `requestHost` from `request.url`, never the proxy
 *   header that pages read, and never `Host` or `X-Forwarded-Host` (client-supplied on Workers,
 *   plan §4.1 step 1). A platform host is refused too: platform artwork is served from the
 *   build-time copy under `public/brand/v<kit version>/`, not from here.
 * - **Every refusal is the same answer.** Unknown host, unknown version, unknown name, wrong tenant,
 *   disallowed type, oversized body: one bodyless 404. The SQL read cannot distinguish the first
 *   three either (`load_public_brand_asset` returns no rows for each), so this endpoint cannot be
 *   used to ask whether another tenant holds an asset called `logo.svg`.
 */

export const BRAND_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * SVG is the one allowed type that carries executable potential. Plan §5.1 line 269 refuses scripted
 * SVG at the write path, and this header is the second answer: a served SVG runs in its own sandbox
 * with no scripts and only inline styling (the kit's own artwork is styled inline).
 */
export const BRAND_ASSET_SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

/** One flat version segment: digits, bounded so it cannot overflow the bigint the SQL expects. */
const VERSION_SEGMENT = /^\d{1,18}$/;

/** One flat lowercase filename, the same form `tenant_brand_assets.name` stores. */
const NAME_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export interface BrandAssetDeps {
  readAsset(input: { host: string; configVersion: string; name: string }): Promise<BrandAsset | undefined>;
}

export interface BrandAssetParams {
  /** The two path segments, as the framework hands them over: untrusted strings. */
  configVersion: unknown;
  name: unknown;
}

function notFound(): Response {
  // No body, no allow-list, no hint of which guard fired. A 404 that explains itself is an asset
  // enumeration endpoint.
  return new Response(null, { status: 404 });
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
};

export async function serveBrandAsset(
  request: Request,
  params: BrandAssetParams,
  deps: BrandAssetDeps,
): Promise<Response> {
  const configVersion = typeof params.configVersion === "string" ? params.configVersion : "";
  const name = typeof params.name === "string" ? params.name : "";
  if (!VERSION_SEGMENT.test(configVersion)) return notFound();
  if (!NAME_SEGMENT.test(name)) return notFound();

  const extension = extensionOf(name);
  if (!BRAND_ASSET_EXTENSIONS.includes(extension)) return notFound();

  const host = requestHost({ url: request.url });
  const parsed = parseHost(host);
  if (!parsed.ok || parsed.class !== "tenant") return notFound();

  let asset: BrandAsset | undefined;
  try {
    asset = await deps.readAsset({ host: parsed.host, configVersion, name });
  } catch {
    // The failure detail is not rendered and not returned: an error from the store can quote a
    // connection string. The reason the client gets is the same 404 as every other refusal.
    console.error("brand asset read failed", { host: parsed.host, step: "readAsset" });
    return notFound();
  }
  if (asset === undefined) return notFound();

  const declared = CONTENT_TYPE_BY_EXTENSION[extension];
  if (asset.contentType !== declared) {
    // The type the extension promises and the type the row carries must agree, or a browser would be
    // told one thing about bytes chosen by another. `nosniff` alone would not make that safe.
    console.error("brand asset type disagrees with its extension", { host: parsed.host, step: "contentType" });
    return notFound();
  }
  if (asset.bytes.length === 0 || asset.bytes.length > MAX_BRAND_ASSET_BYTES) {
    console.error("brand asset size refused", { host: parsed.host, step: "size" });
    return notFound();
  }

  // Copied into a fresh buffer so the body is a self-contained ArrayBuffer: the bytes arrive from a
  // decode that may hand back a view over a larger pool, and a Response must not read past the asset.
  const payload = new Uint8Array(asset.bytes);
  return new Response(payload.buffer as ArrayBuffer, {
    status: 200,
    headers: {
      "content-type": declared,
      "cache-control": BRAND_ASSET_CACHE_CONTROL,
      // FAQ-0008's header set. `nosniff` matters most for SVG: without it a text body can be
      // reinterpreted as something executable.
      "x-content-type-options": "nosniff",
      ...(extension === "svg" ? { "content-security-policy": BRAND_ASSET_SVG_CSP } : {}),
    },
  });
}
