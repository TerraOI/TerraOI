import type { ObjectReadResult, ObjectStore } from "./object-store";

/**
 * Supabase Storage `ObjectStore` (#38): private bucket, caller's access token only — no service-role.
 *
 * The object key is the server-issued `object_ref` from `begin_upload_session_v1`
 * (`knowledge/<org>/uploads/<uuid>/object`). Storage RLS (migration) gates insert/select on that
 * path against an open session owned by the caller.
 */

export const KNOWLEDGE_STORAGE_BUCKET = "knowledge";

export interface SupabaseObjectStoreConfig {
  /** Supabase project URL (same as PostgREST origin). */
  supabaseUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
}

function storageBase(url: string): string {
  return `${url.replace(/\/+$/, "")}/storage/v1`;
}

export function createSupabaseObjectStore(config: SupabaseObjectStoreConfig): ObjectStore {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;

  return {
    async readBounded(objectRef: string, maxBytes: number): Promise<ObjectReadResult> {
      const response = await fetchImpl(
        `${storageBase(config.supabaseUrl)}/object/authenticated/${encodeURIComponent(KNOWLEDGE_STORAGE_BUCKET)}/${objectRef
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${config.accessToken}`,
            // Ask for at most maxBytes+1 so an oversize object is detected without buffering it all
            // when the runtime honours Range; Storage may still return the whole object.
            range: `bytes=0-${maxBytes}`,
          },
        },
      );

      if (response.status === 404 || response.status === 400) return { status: "missing" };
      if (!response.ok) throw new Error("storage_read_failed");

      const contentLengthHeader = response.headers.get("content-length");
      const contentLength =
        contentLengthHeader !== null && contentLengthHeader !== ""
          ? Number.parseInt(contentLengthHeader, 10)
          : null;
      if (contentLength !== null && Number.isFinite(contentLength) && contentLength > maxBytes) {
        return { status: "oversize", sizeBytes: contentLength };
      }

      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) {
        return { status: "oversize", sizeBytes: buffer.byteLength };
      }
      return { status: "ok", bytes: buffer };
    },
  };
}

/**
 * Mint a signed upload URL for the server-issued object key (#38). Uses the caller's token;
 * Storage RLS must allow insert on that path for the open session.
 */
export async function createSignedUploadUrl(input: {
  supabaseUrl: string;
  accessToken: string;
  objectRef: string;
  fetchImpl?: typeof fetch;
}): Promise<{ uploadUrl: string; token: string } | null> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(
    `${storageBase(input.supabaseUrl)}/object/upload/sign/${encodeURIComponent(KNOWLEDGE_STORAGE_BUCKET)}/${input.objectRef
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { url?: unknown; token?: unknown };
  if (typeof body.url !== "string" || body.url.length === 0) return null;
  const absolute =
    body.url.startsWith("http://") || body.url.startsWith("https://")
      ? body.url
      : `${input.supabaseUrl.replace(/\/+$/, "")}${body.url.startsWith("/") ? "" : "/"}${body.url}`;
  return {
    uploadUrl: absolute,
    token: typeof body.token === "string" ? body.token : "",
  };
}
