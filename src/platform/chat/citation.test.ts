import { describe, expect, it } from "vitest";

import { chatPostgrestBase } from "./adapters";
import { contextFor, USER_ACCESS_TOKEN } from "./chat-fixtures";
import { CITATION_NOT_AVAILABLE, handleOpenCitation, type CitationDeps } from "./citation";

const CHUNK = "81000000-0000-4000-8000-000000000001";
const REF = "knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000001/v1.pdf";
const ROOT = "https://synthetic.supabase.co";

function deps(rpc: () => Response, storage: () => Response, session?: CitationDeps["session"]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const d: CitationDeps = {
    session: session ?? (async () => ({ ok: true, context: contextFor(), accessToken: USER_ACCESS_TOKEN })),
    postgrestBaseUrl: `${ROOT}/rest/v1`,
    supabaseUrl: ROOT,
    anonKey: "synthetic-anon-key",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return url.includes("/rpc/") ? rpc() : storage();
    },
  };
  return { d, calls };
}

const rows = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const get = () => new Request(`https://company1.terraoi.app/api/evidence/${CHUNK}`);

describe("handleOpenCitation (F24)", () => {
  it("re-authorizes, then streams the object with the reader's own token, sandboxed and uncached", async () => {
    const { d, calls } = deps(
      () => rows([{ object_ref: REF, data_class: "public" }]),
      () => new Response("%PDF-synthetic", { status: 200, headers: { "content-type": "application/pdf" } }),
    );
    const response = await handleOpenCitation(get(), CHUNK, d);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("%PDF-synthetic");
    expect(calls[0]?.url).toBe(`${ROOT}/rest/v1/rpc/cite_source_object_v1`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ p_chunk_id: CHUNK, p_organisation_id: contextFor().organisationId });
    expect(calls[1]?.url).toBe(`${ROOT}/storage/v1/object/authenticated/${REF}`);
    expect(new Headers(calls[1]?.init?.headers).get("authorization")).toBe(`Bearer ${USER_ACCESS_TOKEN}`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="v1.pdf"');
    // Nothing in the answer to the browser names the object key or a URL.
    expect([...response.headers.values()].join(" ")).not.toContain("knowledge/");
  });

  it("an HTML (or any unlisted) upload is never served inline", async () => {
    const { d } = deps(
      () => rows([{ object_ref: REF, data_class: "public" }]),
      () => new Response("<script>alert(1)</script>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const response = await handleOpenCitation(get(), CHUNK, d);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("a forged, foreign or revoked id (no row) is the same 404, and Storage is never dialled", async () => {
    const { d, calls } = deps(() => rows([]), () => new Response("x"));
    const response = await handleOpenCitation(get(), CHUNK, d);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { message: string }).message).toBe(CITATION_NOT_AVAILABLE);
    expect(calls).toHaveLength(1);
  });

  it("a Storage policy refusal reads exactly like a missing citation", async () => {
    const { d } = deps(() => rows([{ object_ref: REF, data_class: "public" }]), () => new Response("{}", { status: 400 }));
    const response = await handleOpenCitation(get(), CHUNK, d);
    expect(response.status).toBe(404);
  });

  it("a malformed id or a key SQL could not have issued is refused before any fetch of the object", async () => {
    const bad = deps(() => rows([]), () => new Response("x"));
    expect((await handleOpenCitation(get(), "../etc/passwd", bad.d)).status).toBe(404);
    expect(bad.calls).toHaveLength(0);
    const odd = deps(() => rows([{ object_ref: "https://evil.example/x", data_class: "public" }]), () => new Response("x"));
    expect((await handleOpenCitation(get(), CHUNK, odd.d)).status).toBe(503);
    expect(odd.calls).toHaveLength(1);
  });

  it("a signed-out visitor gets 401 and nothing is dialled", async () => {
    const { d, calls } = deps(() => rows([]), () => new Response("x"), async () => ({ ok: false, reason: "no_session" }));
    expect((await handleOpenCitation(get(), CHUNK, d)).status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe("chatPostgrestBase (R-5)", () => {
  it("derives /rest/v1 from the project root and leaves an explicit base alone", () => {
    expect(chatPostgrestBase({ SUPABASE_URL: "https://x.supabase.co/" })).toBe("https://x.supabase.co/rest/v1");
    expect(chatPostgrestBase({ SUPABASE_URL: "https://x.supabase.co/rest/v1" })).toBe("https://x.supabase.co/rest/v1");
    expect(chatPostgrestBase({})).toBeUndefined();
  });
});
