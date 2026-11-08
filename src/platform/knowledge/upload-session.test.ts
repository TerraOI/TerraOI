import { describe, expect, it } from "vitest";

import { createTenantContext, type TenantContext } from "@/contracts/tenant-context";
import type { TenantResolution } from "@/platform/tenancy/resolve-tenant-context";

import { buildSyntheticPdf, sha256Hex, syntheticExecutableBytes } from "./fixtures";
import type { ObjectReadResult } from "./object-store";
import {
  handleCompleteUpload,
  handleCreateUpload,
  type RegisterResult,
  type UploadDeps,
  type UploadSession,
  type UploadStore,
} from "./upload-session";

// T-112 capture (plan §7.2 steps 1–2, §9.2.1; #13(1)/(2), FAQ-0004).
//
// The store below is a faithful stand-in for the scoped RPCs of
// 20261106100000_knowledge_uploads.sql: it issues the object key itself, ignores every
// client-supplied identity, re-checks publish permission at completion time, scopes the session to
// the caller's tenant and uploader, enforces per-collection content dedup and writes the version +
// one job + one outbox event in one step. The pgTAP file pins the same rules in SQL; here the
// handler is what is under test, so no database or storage credential is needed.

const COMPANY1 = "11111111-1111-4111-8111-111111111111";
const COMPANY2 = "22222222-2222-4222-8222-222222222222";
const OWNER1 = "00000000-0000-4000-8000-0000000000a1";
const FIELD2 = "00000000-0000-4000-8000-0000000000a2";
const DUAL = "00000000-0000-4000-8000-0000000000a4";
const OWNER2 = "00000000-0000-4000-8000-0000000000b1";

const TENANT_WIDE_C1 = "51000000-0000-4000-8000-000000000001";
const PROJECT_C1 = "51000000-0000-4000-8000-000000000002";
const TENANT_WIDE_C2 = "52000000-0000-4000-8000-000000000001";

function context(organisationId: string, userId: string, host: string): TenantContext {
  return createTenantContext({
    organisationId,
    host,
    userId,
    membershipId: `00000000-0000-4000-8000-0000000000${userId.slice(-2)}`,
    membershipStatus: "active",
    roles: ["member"],
    permittedServiceKeys: [],
    permittedProjectIds: [],
    policyRevision: 1,
    resolvedAt: new Date().toISOString(),
  });
}

interface FakeCollection {
  id: string;
  organisationId: string;
  dataClass: "public" | "internal" | "client_confidential";
}

interface FakeVersion {
  id: string;
  sourceId: string;
  organisationId: string;
  collectionId: string;
  uploadedBy: string;
  objectRef: string;
  contentHash: string;
  sizeBytes: number;
  state: string;
  dataClass: string;
}

interface FakeOptions {
  collections?: FakeCollection[];
  mayPublish?: string[];
  mayRead?: string[];
  members?: string[];
  openSessionLimit?: number;
  /** tenant → the generation of its active `corpus` embedding index; absent = none is active. */
  activeIndexGeneration?: Record<string, number>;
}

const key = (a: string, b: string): string => `${a}|${b}`;

function makeFakeStore(options: FakeOptions = {}) {
  const collections = new Map<string, FakeCollection>(
    (options.collections ?? [
      { id: TENANT_WIDE_C1, organisationId: COMPANY1, dataClass: "public" },
      { id: PROJECT_C1, organisationId: COMPANY1, dataClass: "client_confidential" },
      { id: TENANT_WIDE_C2, organisationId: COMPANY2, dataClass: "public" },
    ]).map((c) => [c.id, c]),
  );
  const mayPublish = new Set(options.mayPublish ?? [key(TENANT_WIDE_C1, OWNER1), key(PROJECT_C1, OWNER1), key(TENANT_WIDE_C2, OWNER2), key(TENANT_WIDE_C2, DUAL)]);
  const mayRead = new Set(options.mayRead ?? [...mayPublish]);
  const members = new Set(options.members ?? [key(COMPANY1, OWNER1), key(COMPANY1, FIELD2), key(COMPANY2, OWNER2), key(COMPANY2, DUAL)]);
  const activeIndexGeneration: Record<string, number> = options.activeIndexGeneration ?? { [COMPANY1]: 1, [COMPANY2]: 1 };

  const sessions = new Map<string, UploadSession>();
  const versions: FakeVersion[] = [];
  const jobs: { organisationId: string; sourceVersionId: string; stage: string; parserGeneration: string; indexGeneration: number }[] = [];
  const outbox: { organisationId: string; eventType: string; aggregateId: string }[] = [];
  const reads: string[] = [];

  const store: UploadStore = {
    async beginSession(cmd) {
      if (!members.has(key(cmd.organisationId, cmd.userId))) return { status: "no_tenant_scope" };
      const collection = collections.get(cmd.collectionId);
      // Another tenant's collection id and an unknown one look identical: no existence signal.
      if (!collection || collection.organisationId !== cmd.organisationId) return { status: "collection_not_found" };
      if (!mayPublish.has(key(cmd.collectionId, cmd.userId))) return { status: "not_publishable" };
      const open = [...sessions.values()].filter(
        (s) => s.organisationId === cmd.organisationId && s.createdBy === cmd.userId && s.state === "awaiting_upload" && Date.parse(s.expiresAt) > Date.now(),
      );
      if (open.length >= (options.openSessionLimit ?? 10)) return { status: "quota_exceeded" };
      const existing = [...sessions.values()].find(
        (s) => s.organisationId === cmd.organisationId && s.createdBy === cmd.userId && s.idempotencyKey === cmd.idempotencyKey,
      );
      if (existing) return { status: "ok", session: existing };
      const id = crypto.randomUUID();
      const session: UploadSession = {
        id,
        organisationId: cmd.organisationId,
        collectionId: cmd.collectionId,
        createdBy: cmd.userId,
        idempotencyKey: cmd.idempotencyKey,
        // The key is issued here, exactly as the SQL RPC issues it: no caller input contributes.
        objectRef: `knowledge/${cmd.organisationId}/uploads/${id}/object`,
        maxBytes: cmd.maxBytes,
        state: "awaiting_upload",
        reasonCode: null,
        expiresAt: new Date(Date.now() + cmd.sessionTtlSeconds * 1000).toISOString(),
        createdAt: new Date().toISOString(),
        sourceId: null,
        sourceVersionId: null,
      };
      sessions.set(id, session);
      return { status: "ok", session };
    },

    async findSession(cmd) {
      const session = sessions.get(cmd.uploadId);
      if (!session) return null;
      if (session.organisationId !== cmd.organisationId || session.createdBy !== cmd.userId) return null;
      return session;
    },

    async registerVersion(cmd) {
      const session = sessions.get(cmd.uploadId);
      if (!session || session.organisationId !== cmd.organisationId || session.createdBy !== cmd.userId) {
        return { status: "refused", reason: "session_not_found" };
      }
      if (session.state === "completed") {
        const existing = versions.find((v) => v.id === session.sourceVersionId);
        return { status: "ok", sourceId: existing?.sourceId ?? "", sourceVersionId: session.sourceVersionId ?? "", state: "received", alreadyUploaded: true };
      }
      if (session.state !== "awaiting_upload") return { status: "refused", reason: "session_closed" };
      if (Date.parse(session.expiresAt) <= Date.now()) {
        session.state = "expired";
        session.reasonCode = "session_expired";
        return { status: "refused", reason: "session_expired" };
      }
      if (!mayPublish.has(key(session.collectionId, cmd.userId))) return { status: "refused", reason: "not_publishable" };
      if (!/^[0-9a-f]{64}$/.test(cmd.contentHash)) return { status: "refused", reason: "invalid_hash" };
      if (cmd.sizeBytes < 1 || cmd.sizeBytes > session.maxBytes) {
        session.state = "failed";
        session.reasonCode = "size_exceeded";
        return { status: "refused", reason: "size_exceeded" };
      }
      // The index generation is read from the tenant's active `corpus` index, never invented: with
      // no active generation the capture fails atomically (no version, no job, no event).
      const indexGeneration = activeIndexGeneration[cmd.organisationId];
      if (indexGeneration === undefined) return { status: "refused", reason: "index_generation_missing" };
      const collection = collections.get(session.collectionId) as FakeCollection;
      const duplicate = versions.find((v) => v.collectionId === session.collectionId && v.contentHash === cmd.contentHash);
      if (duplicate) {
        if (!mayRead.has(key(session.collectionId, cmd.userId))) return { status: "refused", reason: "duplicate_unreadable" };
        session.state = "completed";
        session.sourceId = duplicate.sourceId;
        session.sourceVersionId = duplicate.id;
        return { status: "ok", sourceId: duplicate.sourceId, sourceVersionId: duplicate.id, state: "received", alreadyUploaded: true };
      }
      const version: FakeVersion = {
        id: crypto.randomUUID(),
        sourceId: crypto.randomUUID(),
        organisationId: cmd.organisationId, // never cmd.bodyTenant: there is no such field
        collectionId: session.collectionId,
        uploadedBy: cmd.userId, // never a body-supplied author: the RPC takes auth.uid()
        objectRef: session.objectRef,
        contentHash: cmd.contentHash,
        sizeBytes: cmd.sizeBytes,
        state: "received",
        dataClass: collection.dataClass,
      };
      versions.push(version);
      // The merged migration writes the capture event with a trigger; this fake mirrors it so the
      // "one version, one event, one job" assertions mean the same thing as in SQL.
      outbox.push({ organisationId: version.organisationId, eventType: "knowledge.source_version.received", aggregateId: version.id });
      const jobKey = `${version.organisationId}|${version.id}|extract|v1|${indexGeneration}`;
      if (!jobs.some((j) => `${j.organisationId}|${j.sourceVersionId}|${j.stage}|${j.parserGeneration}|${j.indexGeneration}` === jobKey)) {
        jobs.push({ organisationId: version.organisationId, sourceVersionId: version.id, stage: "extract", parserGeneration: "v1", indexGeneration });
      }
      session.state = "completed";
      session.sourceId = version.sourceId;
      session.sourceVersionId = version.id;
      return { status: "ok", sourceId: version.sourceId, sourceVersionId: version.id, state: "received", alreadyUploaded: false };
    },

    async recordOutcome(cmd) {
      const session = sessions.get(cmd.uploadId);
      if (!session || session.organisationId !== cmd.organisationId || session.createdBy !== cmd.userId) return;
      if (session.state === "completed") return;
      session.state = cmd.state;
      session.reasonCode = cmd.reason;
    },
  };

  return { store, sessions, versions, jobs, outbox, reads, mayPublish, mayRead };
}

function makeObjects(objects: Map<string, Uint8Array>, fake: { reads: string[] }): {
  objects: Map<string, Uint8Array>;
  readBounded(ref: string, maxBytes: number): Promise<ObjectReadResult>;
} {
  return {
    objects,
    async readBounded(ref, maxBytes) {
      fake.reads.push(ref);
      const bytes = objects.get(ref);
      if (!bytes) return { status: "missing" };
      if (bytes.byteLength > maxBytes) return { status: "oversize", sizeBytes: bytes.byteLength };
      return { status: "ok", bytes };
    },
  };
}

function makeDeps(options: {
  fake: ReturnType<typeof makeFakeStore>;
  objects: Map<string, Uint8Array>;
  ctx?: TenantResolution;
}): Pick<UploadDeps, "store" | "objects" | "resolveContext"> {
  const fakeObjects = makeObjects(options.objects, options.fake);
  return {
    store: options.fake.store,
    objects: fakeObjects,
    resolveContext: async () =>
      options.ctx ?? { ok: true, context: context(COMPANY1, OWNER1, "company1.terraoi.app") },
  };
}

function createRequest(body: unknown, host = "company1.terraoi.app", origin: string | null = `https://company1.terraoi.app`): Request {
  return new Request(`https://${host}/api/knowledge/uploads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin === null ? {} : { origin }),
    },
    body: JSON.stringify(body),
  });
}

function completeRequest(uploadId: string, body: unknown, host = "company1.terraoi.app"): Request {
  return new Request(`https://${host}/api/knowledge/uploads/${uploadId}/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `https://${host}` },
    body: JSON.stringify(body),
  });
}

async function begin(deps: UploadDeps, body: Record<string, unknown> = {}): Promise<{
  response: Response;
  payload: Record<string, unknown>;
  uploadId: string;
  objectRef: string;
}> {
  const response = await handleCreateUpload(
    createRequest({
      collectionId: TENANT_WIDE_C1,
      filename: "synthetic-manual.pdf",
      idempotencyKey: crypto.randomUUID(),
      ...body,
    }),
    deps,
  );
  const payload = (await response.json()) as Record<string, unknown>;
  return {
    response,
    payload,
    uploadId: typeof payload["uploadId"] === "string" ? payload["uploadId"] : "",
    objectRef: typeof payload["objectRef"] === "string" ? payload["objectRef"] : "",
  };
}

function codeOf(payload: Record<string, unknown>): string {
  const error = payload["error"] as { code?: string } | undefined;
  return error?.code ?? "";
}

async function finish(deps: UploadDeps, uploadId: string, bytes: Uint8Array): Promise<Response> {
  return handleCompleteUpload(completeRequest(uploadId, { sha256: await sha256Hex(bytes) }), deps);
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function errorCode(response: Response): Promise<string> {
  const body = await bodyOf(response);
  const error = body["error"] as { code?: string } | undefined;
  return error?.code ?? "";
}

describe("POST /api/knowledge/uploads (session)", () => {
  it("issues an object key the client cannot choose", async () => {
    const fake = makeFakeStore();
    const deps = makeDeps({ fake, objects: new Map() }) as UploadDeps;
    const { response, uploadId, objectRef } = await begin(deps, { filename: "quarterly-report.pdf" });
    expect(response.status).toBe(201);
    expect(uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(objectRef.startsWith(`knowledge/${COMPANY1}/`)).toBe(true);
    // The client's file name appears nowhere in the key, and no client field does.
    expect(objectRef).not.toContain("quarterly");
    expect(objectRef).not.toContain("..");
    const again = await begin(deps, { filename: "quarterly-report.pdf", idempotencyKey: crypto.randomUUID() });
    expect(again.objectRef).not.toBe(objectRef);
    const session = fake.sessions.get(uploadId);
    expect(session?.objectRef).toBe(objectRef);
  });

  it("ignores a body that tries to name the tenant, the uploader or the object key", async () => {
    const fake = makeFakeStore();
    const deps = makeDeps({ fake, objects: new Map() }) as UploadDeps;
    const response = await handleCreateUpload(
      createRequest({
        collectionId: TENANT_WIDE_C1,
        filename: "x.pdf",
        idempotencyKey: crypto.randomUUID(),
        organisationId: COMPANY2,
        uploadedBy: OWNER2,
        objectRef: `knowledge/${COMPANY2}/uploads/stolen/object`,
        dataClass: "restricted",
      }),
      deps,
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_request");
    expect(fake.sessions.size).toBe(0);
  });

  it("another tenant's collection id is a generic not-found with no existence signal", async () => {
    const fake = makeFakeStore();
    const deps = makeDeps({ fake, objects: new Map() }) as UploadDeps;
    const begun = await begin(deps, { collectionId: TENANT_WIDE_C2 });
    expect(begun.response.status).toBe(404);
    expect(codeOf(begun.payload)).toBe("not_found");
    expect(JSON.stringify(begun.payload)).not.toContain("52000000");
  });

  it("a member without collection publish permission gets 403 and no session or source row", async () => {
    const fake = makeFakeStore();
    const deps = makeDeps({
      fake,
      objects: new Map(),
      ctx: { ok: true, context: context(COMPANY1, FIELD2, "company1.terraoi.app") },
    }) as UploadDeps;
    const begun = await begin(deps);
    expect(begun.response.status).toBe(403);
    expect(codeOf(begun.payload)).toBe("not_publishable");
    expect(fake.sessions.size).toBe(0);
    expect(fake.versions).toHaveLength(0);
  });

  it("re-posting the same logical begin returns the same session and key (retry-safe)", async () => {
    const fake = makeFakeStore();
    const deps = makeDeps({ fake, objects: new Map() }) as UploadDeps;
    const idempotencyKey = crypto.randomUUID();
    const first = await begin(deps, { idempotencyKey });
    const second = await begin(deps, { idempotencyKey });
    expect(second.uploadId).toBe(first.uploadId);
    expect(second.objectRef).toBe(first.objectRef);
    expect(fake.sessions.size).toBe(1);
  });

  it("refuses with 429 once the caller has too many open sessions", async () => {
    const fake = makeFakeStore({ openSessionLimit: 1 });
    const deps = makeDeps({ fake, objects: new Map() }) as UploadDeps;
    await begin(deps);
    const second = await begin(deps, { idempotencyKey: crypto.randomUUID() });
    expect(second.response.status).toBe(429);
    expect(codeOf(second.payload)).toBe("quota_exceeded");
  });

  it("a request without a session or with a mismatched Origin is rejected before the store is touched", async () => {
    const fake = makeFakeStore();
    const anonymous = makeDeps({ fake, objects: new Map(), ctx: { ok: false, reason: "no_session" } }) as UploadDeps;
    const unauthenticated = await handleCreateUpload(createRequest({}), anonymous);
    expect(unauthenticated.status).toBe(401);

    const forgedOrigin = makeDeps({ fake, objects: new Map() }) as UploadDeps;
    const response = await handleCreateUpload(
      createRequest({ collectionId: TENANT_WIDE_C1, filename: "x.pdf", idempotencyKey: crypto.randomUUID() }, "company1.terraoi.app", "https://evil.example"),
      forgedOrigin,
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("origin_mismatch");
    expect(fake.sessions.size).toBe(0);
  });

  it("rejects a non-JSON body and an unknown content type", async () => {
    const fake = makeFakeStore();
    const deps = makeDeps({ fake, objects: new Map() }) as UploadDeps;
    const notJson = await handleCreateUpload(
      new Request("https://company1.terraoi.app/api/knowledge/uploads", { method: "POST", headers: { origin: "https://company1.terraoi.app", "content-type": "text/plain" }, body: "hello" }),
      deps,
    );
    expect(notJson.status).toBe(415);
    const malformed = await handleCreateUpload(
      new Request("https://company1.terraoi.app/api/knowledge/uploads", { method: "POST", headers: { origin: "https://company1.terraoi.app", "content-type": "application/json" }, body: "{" }),
      deps,
    );
    expect(malformed.status).toBe(400);
    expect(fake.sessions.size).toBe(0);
  });
});

describe("POST /api/knowledge/uploads/:id/complete", () => {
  async function capture(bytes: Uint8Array, options: FakeOptions = {}): Promise<{
    response: Response;
    body: Record<string, unknown>;
    fake: ReturnType<typeof makeFakeStore>;
    objectRef: string;
  }> {
    const fake = makeFakeStore(options);
    const objects = new Map<string, Uint8Array>();
    const deps = makeDeps({ fake, objects }) as UploadDeps;
    const { uploadId, objectRef } = await begin(deps);
    objects.set(objectRef, bytes);
    const response = await finish(deps, uploadId, bytes);
    return { response, body: await bodyOf(response), fake, objectRef };
  }

  it("verifies the object and creates exactly one version, one job and one outbox event", async () => {
    const bytes = await buildSyntheticPdf({ pages: [{ lines: ["Synthetic pre-flight manual."] }] });
    const { response, body, fake, objectRef } = await capture(bytes);
    expect(response.status).toBe(200);
    expect(body["state"]).toBe("received");
    expect(body["alreadyUploaded"]).toBe(false);
    expect(typeof body["sourceVersionId"]).toBe("string");
    expect(fake.versions).toHaveLength(1);
    expect(fake.jobs).toHaveLength(1);
    expect(fake.outbox).toHaveLength(1);
    expect(fake.jobs[0]?.stage).toBe("extract");
    // Provenance: the calling auth.uid() and the host-resolved tenant, never the body.
    expect(fake.versions[0]?.uploadedBy).toBe(OWNER1);
    expect(fake.versions[0]?.organisationId).toBe(COMPANY1);
    expect(fake.versions[0]?.objectRef).toBe(objectRef);
    expect(fake.versions[0]?.dataClass).toBe("public");
    // The object that was read is the one the session issued.
    expect(fake.reads).toEqual([objectRef]);
  });

  it("the enqueued stage carries the tenant's active index generation, never a made-up one", async () => {
    const bytes = await buildSyntheticPdf({ pages: [{ lines: ["Synthetic manual, third generation."] }] });
    const fake = makeFakeStore({ activeIndexGeneration: { [COMPANY1]: 3, [COMPANY2]: 1 } });
    const objects = new Map<string, Uint8Array>();
    const deps = makeDeps({ fake, objects }) as UploadDeps;
    const { uploadId, objectRef } = await begin(deps);
    objects.set(objectRef, bytes);
    const response = await finish(deps, uploadId, bytes);
    expect(response.status).toBe(200);
    expect(fake.jobs).toHaveLength(1);
    expect(fake.jobs[0]?.indexGeneration).toBe(3);
    expect(fake.jobs[0]?.parserGeneration).toBe("v1");
  });

  it("no active embedding generation fails the capture atomically (issue #6 is not ours to invent)", async () => {
    const bytes = await buildSyntheticPdf({ pages: [{ lines: ["Synthetic manual, unpinned tenant."] }] });
    const fake = makeFakeStore({ activeIndexGeneration: {} });
    const objects = new Map<string, Uint8Array>();
    const deps = makeDeps({ fake, objects }) as UploadDeps;
    const { uploadId, objectRef } = await begin(deps);
    objects.set(objectRef, bytes);
    const response = await finish(deps, uploadId, bytes);
    expect(response.status).toBe(409);
    expect(await errorCode(response)).toBe("index_generation_missing");
    expect(fake.versions).toHaveLength(0);
    expect(fake.jobs).toHaveLength(0);
    expect(fake.outbox).toHaveLength(0);
    // The session stays open, so the same completion can succeed once the tenant pins a
    // generation; nothing was half-written in the meantime.
    expect(fake.sessions.get(uploadId)?.state).toBe("awaiting_upload");
  });

  it("the version's data class is inherited from the collection, not from the request", async () => {
    const fake = makeFakeStore();
    const objects = new Map<string, Uint8Array>();
    const deps = makeDeps({ fake, objects }) as UploadDeps;
    const { uploadId, objectRef } = await begin(deps, { collectionId: PROJECT_C1 });
    const bytes = await buildSyntheticPdf({ pages: [{ lines: ["Synthetic site note."] }] });
    objects.set(objectRef, bytes);
    const response = await finish(deps, uploadId, bytes);
    expect(response.status).toBe(200);
    expect(fake.versions[0]?.dataClass).toBe("client_confidential");
  });

  it("a session created for one tenant cannot be completed on another tenant's host", async () => {
    const fake = makeFakeStore();
    const objects = new Map<string, Uint8Array>();
    const company1Deps = makeDeps({ fake, objects }) as UploadDeps;
    const { uploadId } = await begin(company1Deps);
    const bytes = await buildSyntheticPdf({});
    const dualOnCompany2 = makeDeps({
      fake,
      objects,
      ctx: { ok: true, context: context(COMPANY2, DUAL, "company2.terraoi.app") },
    }) as UploadDeps;
    const response = await handleCompleteUpload(completeRequest(uploadId, { sha256: await sha256Hex(bytes) }, "company2.terraoi.app"), dualOnCompany2);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("session_not_found");
    expect(fake.versions).toHaveLength(0);
    expect(fake.sessions.get(uploadId)?.state).toBe("awaiting_upload");
  });

  it("re-checks publish permission at completion: a permission lost mid-flight writes nothing", async () => {
    const fake = makeFakeStore();
    const objects = new Map<string, Uint8Array>();
    const deps = makeDeps({ fake, objects }) as UploadDeps;
    const { uploadId, objectRef } = await begin(deps, { collectionId: PROJECT_C1 });
    const bytes = await buildSyntheticPdf({});
    objects.set(objectRef, bytes);
    fake.mayPublish.delete(key(PROJECT_C1, OWNER1));
    const response = await finish(deps, uploadId, bytes);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("not_publishable");
    expect(fake.versions).toHaveLength(0);
    expect(fake.outbox).toHaveLength(0);
  });

  it("posting the same completion twice creates one version and one job", async () => {
    const bytes = await buildSyntheticPdf({ pages: [{ lines: ["Synthetic manual."] }] });
    const fake = makeFakeStore();
    const objects = new Map<string, Uint8Array>();
    const deps = makeDeps({ fake, objects }) as UploadDeps;
    const { uploadId, objectRef } = await begin(deps);
    objects.set(objectRef, bytes);
    const first = await finish(deps, uploadId, bytes);
    const second = await finish(deps, uploadId, bytes);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await bodyOf(first);
    const secondBody = await bodyOf(second);
    expect(secondBody["sourceVersionId"]).toBe(firstBody["sourceVersionId"]);
    expect(secondBody["alreadyUploaded"]).toBe(true);
    expect(fake.versions).toHaveLength(1);
    expect(fake.jobs).toHaveLength(1);
    expect(fake.outbox).toHaveLength(1);
  });

  it("re-uploading the same bytes into the same collection hints at the copy this uploader can read", async () => {
    const bytes = await buildSyntheticPdf({ pages: [{ lines: ["Synthetic duplicate."] }] });
    const hash = await sha256Hex(bytes);
    const fake = makeFakeStore();
    const objects = new Map<string, Uint8Array>();
    const deps = makeDeps({ fake, objects }) as UploadDeps;
    const first = await begin(deps);
    objects.set(first.objectRef, bytes);
    await finish(deps, first.uploadId, bytes);
    const second = await begin(deps, { idempotencyKey: crypto.randomUUID() });
    objects.set(second.objectRef, bytes);
    const response = await handleCompleteUpload(completeRequest(second.uploadId, { sha256: hash }), deps);
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    expect(body["alreadyUploaded"]).toBe(true);
    expect(body["sourceVersionId"]).toBe(fake.versions[0]?.id);
    expect(fake.versions).toHaveLength(1);
  });

  it("the same bytes in another tenant's collection create their own version with no existence signal", async () => {
    const bytes = await buildSyntheticPdf({ pages: [{ lines: ["Synthetic corpus document."] }] });
    const hash = await sha256Hex(bytes);
    const fake = makeFakeStore();
    const objects = new Map<string, Uint8Array>();

    // Company2 captures the identical bytes first, in its own collection.
    const company2 = makeDeps({
      fake,
      objects,
      ctx: { ok: true, context: context(COMPANY2, OWNER2, "company2.terraoi.app") },
    }) as UploadDeps;
    const foreign = await begin(company2, { collectionId: TENANT_WIDE_C2, idempotencyKey: crypto.randomUUID() });
    expect(foreign.response.status).toBe(201);
    objects.set(foreign.objectRef, bytes);
    const foreignCompletion = await handleCompleteUpload(
      completeRequest(foreign.uploadId, { sha256: hash }, "company2.terraoi.app"),
      company2,
    );
    expect(foreignCompletion.status).toBe(200);
    const foreignCopy = fake.versions[0] as FakeVersion;
    expect(foreignCopy.organisationId).toBe(COMPANY2);

    // Company1 uploads the same bytes: dedup is per collection (#13(2)), so this is its own
    // version and the response carries nothing about the copy in the other tenant.
    const company1 = makeDeps({ fake, objects }) as UploadDeps;
    const mine = await begin(company1, { idempotencyKey: crypto.randomUUID() });
    objects.set(mine.objectRef, bytes);
    const response = await handleCompleteUpload(completeRequest(mine.uploadId, { sha256: hash }), company1);
    const body = await bodyOf(response);
    expect(response.status).toBe(200);
    expect(body["alreadyUploaded"]).toBe(false);
    expect(JSON.stringify(body)).not.toContain(foreignCopy.id);
    expect(JSON.stringify(body)).not.toContain(COMPANY2);
    expect(fake.versions).toHaveLength(2);
    expect(fake.outbox).toHaveLength(2);
  });

  it("the same bytes in a project corpus the uploader cannot read still yield their own version and no hint", async () => {
    const bytes = await buildSyntheticPdf({ pages: [{ lines: ["Synthetic project-corpus document."] }] });
    const hash = await sha256Hex(bytes);
    // OWNER1 may publish into both collections; a second user may publish into the tenant-wide
    // collection only and cannot read the project corpus where a copy already sits.
    const fake = makeFakeStore({
      mayPublish: [key(PROJECT_C1, OWNER1), key(TENANT_WIDE_C1, OWNER1), key(TENANT_WIDE_C1, DUAL)],
      mayRead: [key(PROJECT_C1, OWNER1), key(TENANT_WIDE_C1, OWNER1)],
      members: [key(COMPANY1, OWNER1), key(COMPANY1, DUAL)],
    });
    const objects = new Map<string, Uint8Array>();
    const owner = makeDeps({ fake, objects }) as UploadDeps;
    const seeded = await begin(owner, { collectionId: PROJECT_C1, idempotencyKey: crypto.randomUUID() });
    objects.set(seeded.objectRef, bytes);
    expect((await finish(owner, seeded.uploadId, bytes)).status).toBe(200);
    const hiddenCopy = fake.versions[0] as FakeVersion;

    const dual = makeDeps({
      fake,
      objects,
      ctx: { ok: true, context: context(COMPANY1, DUAL, "company1.terraoi.app") },
    }) as UploadDeps;
    const mine = await begin(dual, { idempotencyKey: crypto.randomUUID() });
    objects.set(mine.objectRef, bytes);
    const response = await handleCompleteUpload(completeRequest(mine.uploadId, { sha256: hash }), dual);
    const body = await bodyOf(response);
    expect(response.status).toBe(200);
    expect(body["alreadyUploaded"]).toBe(false);
    expect(JSON.stringify(body)).not.toContain(hiddenCopy.id);
    expect(fake.versions).toHaveLength(2);
  });

  it("an unsafe object ends quarantined or failed with a safe reason and no source row", async () => {
    const cases: { label: string; bytes: Uint8Array; code: string; state: "quarantined" | "failed"; limits?: UploadDeps["limits"] }[] = [
      { label: "an .exe renamed .pdf", bytes: syntheticExecutableBytes(), code: "signature_mismatch", state: "quarantined" },
      { label: "a 0-byte object", bytes: new Uint8Array(), code: "empty_object", state: "failed" },
      { label: "an encrypted PDF", bytes: await buildSyntheticPdf({ encrypted: true }), code: "encrypted_pdf", state: "quarantined" },
      {
        label: "a stream that explodes",
        bytes: await buildSyntheticPdf({ pages: [{ compressed: true, lines: ["x"] }], expandContentToBytes: 2_000_000 }),
        code: "decompression_bomb",
        state: "quarantined",
        limits: { maxDecompressedBytes: 200_000 },
      },
    ];
    for (const testCase of cases) {
      const fake = makeFakeStore();
      const objects = new Map<string, Uint8Array>();
      const deps = { ...makeDeps({ fake, objects }), ...(testCase.limits ? { limits: testCase.limits } : {}) } as UploadDeps;
      const { uploadId, objectRef } = await begin(deps);
      objects.set(objectRef, testCase.bytes);
      const response = await finish(deps, uploadId, testCase.bytes);
      expect(response.status, testCase.label).toBeGreaterThanOrEqual(400);
      expect(response.status, testCase.label).toBeLessThan(500);
      expect(await errorCode(response), testCase.label).toBe(testCase.code);
      expect(fake.versions, testCase.label).toHaveLength(0);
      expect(fake.jobs, testCase.label).toHaveLength(0);
      expect(fake.outbox, testCase.label).toHaveLength(0);
      const session = fake.sessions.get(uploadId);
      expect(session?.state, testCase.label).toBe(testCase.state);
      expect(session?.reasonCode, testCase.label).toBe(testCase.code);
    }
  });

  it("an object larger than the session bound is refused and never read whole", async () => {
    const fake = makeFakeStore();
    const objects = new Map<string, Uint8Array>();
    const deps = makeDeps({ fake, objects }) as UploadDeps;
    const { uploadId, objectRef } = await begin(deps);
    objects.set(objectRef, new Uint8Array(4000));
    const response = await handleCompleteUpload(completeRequest(uploadId, { sha256: "0".repeat(64) }), {
      ...deps,
      limits: { maxBytes: 1000 },
    });
    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("size_exceeded");
    expect(fake.versions).toHaveLength(0);
    expect(fake.sessions.get(uploadId)?.state).toBe("failed");
  });

  it("a declared hash that does not match the stored bytes is refused", async () => {
    const bytes = await buildSyntheticPdf({});
    const fake = makeFakeStore();
    const objects = new Map<string, Uint8Array>();
    const deps = makeDeps({ fake, objects }) as UploadDeps;
    const { uploadId, objectRef } = await begin(deps);
    objects.set(objectRef, bytes);
    const response = await handleCompleteUpload(completeRequest(uploadId, { sha256: "f".repeat(64) }), deps);
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("hash_mismatch");
    expect(fake.versions).toHaveLength(0);
  });

  it("a completion before the object has landed is a retryable conflict, not a capture", async () => {
    const bytes = await buildSyntheticPdf({ pages: [{ lines: ["Synthetic late arrival."] }] });
    const fake = makeFakeStore();
    const objects = new Map<string, Uint8Array>();
    const deps = makeDeps({ fake, objects }) as UploadDeps;
    const { uploadId, objectRef } = await begin(deps);
    const early = await handleCompleteUpload(completeRequest(uploadId, { sha256: await sha256Hex(bytes) }), deps);
    expect(early.status).toBe(409);
    expect(await errorCode(early)).toBe("object_missing");
    expect(fake.sessions.get(uploadId)?.state).toBe("awaiting_upload");
    objects.set(objectRef, bytes);
    const later = await finish(deps, uploadId, bytes);
    expect(later.status).toBe(200);
    expect(fake.versions).toHaveLength(1);
  });

  it("an expired session is closed for good", async () => {
    const bytes = await buildSyntheticPdf({});
    const fake = makeFakeStore();
    const objects = new Map<string, Uint8Array>();
    const deps = makeDeps({ fake, objects }) as UploadDeps;
    const { uploadId, objectRef } = await begin(deps);
    objects.set(objectRef, bytes);
    const session = fake.sessions.get(uploadId) as UploadSession;
    session.expiresAt = new Date(Date.now() - 1000).toISOString();
    const response = await finish(deps, uploadId, bytes);
    expect(response.status).toBe(410);
    expect(await errorCode(response)).toBe("session_expired");
    expect(fake.versions).toHaveLength(0);
  });

  it("the failure response never echoes document content", async () => {
    const bytes = await buildSyntheticPdf({ pages: [{ lines: ["CLIENT-SPECIFIC-SENTINEL-TEXT"] }], missingEof: true });
    const { response, body } = await capture(bytes);
    expect(response.status).toBe(422);
    expect(JSON.stringify(body)).not.toContain("CLIENT-SPECIFIC-SENTINEL-TEXT");
  });

  it("an unknown upload id is a generic not-found for any tenant", async () => {
    const fake = makeFakeStore();
    const deps = makeDeps({ fake, objects: new Map() }) as UploadDeps;
    const response = await handleCompleteUpload(completeRequest(crypto.randomUUID(), { sha256: "0".repeat(64) }), deps);
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("session_not_found");
  });

  it("a completion body must carry a lowercase sha-256 and nothing else", async () => {
    const fake = makeFakeStore();
    const objects = new Map<string, Uint8Array>();
    const deps = makeDeps({ fake, objects }) as UploadDeps;
    const { uploadId, objectRef } = await begin(deps);
    const bytes = await buildSyntheticPdf({});
    objects.set(objectRef, bytes);
    const forged = await handleCompleteUpload(
      completeRequest(uploadId, { sha256: await sha256Hex(bytes), uploadedBy: OWNER2, organisationId: COMPANY2 }),
      deps,
    );
    expect(forged.status).toBe(400);
    expect(await errorCode(forged)).toBe("invalid_request");
    const badHash = await handleCompleteUpload(completeRequest(uploadId, { sha256: "ZZ" }), deps);
    expect(badHash.status).toBe(400);
    expect(fake.versions).toHaveLength(0);
  });

  it("refuses a completion that tries to name the object key or the destination collection", async () => {
    const bytes = await buildSyntheticPdf({ pages: [{ lines: ["Synthetic redirect attempt."] }] });
    const fake = makeFakeStore();
    const objects = new Map<string, Uint8Array>();
    const deps = makeDeps({ fake, objects }) as UploadDeps;
    const { uploadId, objectRef } = await begin(deps);
    objects.set(objectRef, bytes);
    const response = await handleCompleteUpload(
      completeRequest(uploadId, {
        sha256: await sha256Hex(bytes),
        objectRef: `knowledge/${COMPANY2}/uploads/stolen/object`,
        collectionId: PROJECT_C1,
      }),
      deps,
    );
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_request");
    // Nothing was read from the key the body named, and nothing was captured.
    expect(fake.reads).toEqual([]);
    expect(fake.versions).toHaveLength(0);
  });

  it("a session created by one member is not completable by another member of the same tenant", async () => {
    const bytes = await buildSyntheticPdf({});
    const fake = makeFakeStore();
    const objects = new Map<string, Uint8Array>();
    const deps = makeDeps({ fake, objects }) as UploadDeps;
    const { uploadId, objectRef } = await begin(deps);
    objects.set(objectRef, bytes);
    const asFieldUser = makeDeps({
      fake,
      objects,
      ctx: { ok: true, context: context(COMPANY1, FIELD2, "company1.terraoi.app") },
    }) as UploadDeps;
    const response = await handleCompleteUpload(completeRequest(uploadId, { sha256: await sha256Hex(bytes) }), asFieldUser);
    expect(response.status).toBe(404);
    expect(fake.versions).toHaveLength(0);
  });

  it("a register refusal from the write path (SQL guard) maps to a safe code with no rows", async () => {
    const bytes = await buildSyntheticPdf({ pages: [{ lines: ["Synthetic accepted object."] }] });
    const fake = makeFakeStore();
    const objects = new Map<string, Uint8Array>();
    const deps = {
      ...makeDeps({ fake, objects }),
      // Stands in for register_source_version_v1 rejecting the hash shape after the app check.
      store: { ...fake.store, registerVersion: async (): Promise<RegisterResult> => ({ status: "refused", reason: "invalid_hash" }) },
    } as UploadDeps;
    const { uploadId, objectRef } = await begin(deps);
    objects.set(objectRef, bytes);
    const response = await finish(deps, uploadId, bytes);
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("invalid_hash");
    expect(fake.versions).toHaveLength(0);
    expect(fake.outbox).toHaveLength(0);
  });
});
