import { describe, expect, it, vi } from "vitest";

import { createSignedUploadUrl, createSupabaseObjectStore, KNOWLEDGE_STORAGE_BUCKET } from "./object-store-supabase";

const TOKEN = "eyJhbGciOiJub25lIn0.e30.synthetic";
const URL = "https://example.supabase.test";

describe("createSupabaseObjectStore (#38)", () => {
  it("returns missing on 404", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const store = createSupabaseObjectStore({ supabaseUrl: URL, accessToken: TOKEN, fetchImpl });
    await expect(store.readBounded("knowledge/org/uploads/id/object", 100)).resolves.toEqual({ status: "missing" });
    expect(fetchImpl).toHaveBeenCalled();
    const calledUrl = String((fetchImpl.mock.calls as unknown as Array<[unknown]>)[0]?.[0] ?? "");
    expect(calledUrl).toContain(`/object/authenticated/${KNOWLEDGE_STORAGE_BUCKET}/`);
  });

  it("returns oversize when the body exceeds the bound", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    const store = createSupabaseObjectStore({ supabaseUrl: URL, accessToken: TOKEN, fetchImpl });
    await expect(store.readBounded("knowledge/org/uploads/id/object", 2)).resolves.toEqual({
      status: "oversize",
      sizeBytes: 4,
    });
  });

  it("returns ok bytes under the bound", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const fetchImpl = vi.fn(async () => new Response(bytes, { status: 200 }));
    const store = createSupabaseObjectStore({ supabaseUrl: URL, accessToken: TOKEN, fetchImpl });
    await expect(store.readBounded("knowledge/org/uploads/id/object", 10)).resolves.toEqual({ status: "ok", bytes });
  });
});

describe("createSignedUploadUrl (#38)", () => {
  it("builds an absolute upload URL from a relative Storage response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ url: "/storage/v1/object/upload/sign/knowledge/path?token=t" }), { status: 200 }),
    );
    const signed = await createSignedUploadUrl({
      supabaseUrl: URL,
      accessToken: TOKEN,
      objectRef: "knowledge/org/uploads/id/object",
      fetchImpl,
    });
    expect(signed?.uploadUrl).toBe(`${URL}/storage/v1/object/upload/sign/knowledge/path?token=t`);
  });

  it("returns null when Storage refuses", async () => {
    const fetchImpl = vi.fn(async () => new Response("no", { status: 403 }));
    await expect(
      createSignedUploadUrl({
        supabaseUrl: URL,
        accessToken: TOKEN,
        objectRef: "knowledge/org/uploads/id/object",
        fetchImpl,
      }),
    ).resolves.toBeNull();
  });
});
