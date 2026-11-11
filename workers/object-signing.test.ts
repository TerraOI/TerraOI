import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createSignedUrl,
  createStorageUrlSigner,
  objectRefIsServerIssued,
  SIGNED_URL_TTL_SECONDS,
} from "./object-signing";

/**
 * The one Storage call ADR-0011 allows, tested against a real socket (COORDINATION §6a): a plain
 * Node `http` listener on `127.0.0.1` with `listen(0)`, closed in `afterAll`, no external network.
 * What the unit tests cannot show is what actually crossed the wire, and the two claims that matter
 * here are wire claims: the request carries the deployment's key and a 60-second TTL, and the
 * response's URL never finds its way into a log.
 *
 * The fixture's "key" and "token" are synthetic low-entropy strings, and the fake's signed path
 * deliberately contains the object key so the leak assertions have something to find.
 */

const SYNTHETIC_KEY_NAME = "knowledge/syn-tenant-0001/syn-source-0001/v1";
const SYNTHETIC_SERVICE_KEY = "synthetic-service-key-not-a-secret";
const SYNTHETIC_URL_TOKEN = "synthetic-signed-token-0001";

type Seen = { method?: string; path?: string; auth?: string; body: string };

let server: Server;
let baseUrl = "";
const seen: Seen[] = [];
const signedPath = `object/sign/hidden-bucket/${SYNTHETIC_KEY_NAME}?token=${SYNTHETIC_URL_TOKEN}`;
let respondWith: { status: number; body: string } = { status: 200, body: "" };

function reset(): void {
  seen.length = 0;
  respondWith = {
    status: 200,
    body: JSON.stringify({ signedURL: signedPath, path: SYNTHETIC_KEY_NAME }),
  };
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method,
        path: req.url,
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(respondWith.status, { "content-type": "application/json" });
      res.end(respondWith.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  reset();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe("workers/object-signing.ts (ADR-0011 Decision 1, 3)", () => {
  it("signs for the 60 seconds #146 ruled, and the constant is the only TTL", () => {
    expect(SIGNED_URL_TTL_SECONDS).toBe(60);
    // #146: a URL must not outlive the shortest lease this API issues (60 s floor,
    // job_api.max_lease_seconds() ceiling).
    expect(SIGNED_URL_TTL_SECONDS).toBeGreaterThanOrEqual(60);
    expect(SIGNED_URL_TTL_SECONDS).toBeLessThanOrEqual(1800);
  });

  it("is one POST to the Storage sign endpoint, authenticated by the deployment's key", async () => {
    reset();
    const outcome = await createSignedUrl({
      baseUrl,
      bucket: "hidden-bucket",
      objectRef: SYNTHETIC_KEY_NAME,
      serviceRoleKey: SYNTHETIC_SERVICE_KEY,
    });

    expect(outcome.status).toBe("ok");
    expect(seen).toHaveLength(1);
    const request = seen[0]!;
    expect(request.method).toBe("POST");
    // The key is percent-encoded per segment, so a path in the object ref cannot add a segment.
    expect(request.path).toBe(`/storage/v1/object/sign/hidden-bucket/${SYNTHETIC_KEY_NAME}`);
    expect(request.auth).toBe(`Bearer ${SYNTHETIC_SERVICE_KEY}`);
    const body = JSON.parse(request.body) as { expiresIn?: number };
    expect(body.expiresIn).toBe(SIGNED_URL_TTL_SECONDS);
  });

  it("returns the URL to the caller and writes nothing down", async () => {
    reset();
    const logs = vi.spyOn(console, "log");
    const warns = vi.spyOn(console, "warn");
    const errors = vi.spyOn(console, "error");

    const outcome = await createSignedUrl({
      baseUrl,
      bucket: "hidden-bucket",
      objectRef: SYNTHETIC_KEY_NAME,
      serviceRoleKey: SYNTHETIC_SERVICE_KEY,
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.url).toBe(`${baseUrl}/storage/v1/${signedPath}`);
    expect(logs).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    // Nothing about the response is a URL: the log sinks were not called at all, and the request
    // that crossed the socket named the key, not the signed URL.
    expect(seen[0]!.path).not.toContain(SYNTHETIC_URL_TOKEN);
  });

  it("names the failure, never the response body, when Storage refuses", async () => {
    for (const [status, expected] of [
      [401, "denied"],
      [403, "denied"],
      [404, "not_found"],
      [500, "server_error"],
    ] as const) {
      seen.length = 0;
      respondWith = { status, body: JSON.stringify({ error: "a body naming a host and a key" }) };
      const outcome = await createSignedUrl({
        baseUrl,
        bucket: "hidden-bucket",
        objectRef: SYNTHETIC_KEY_NAME,
        serviceRoleKey: SYNTHETIC_SERVICE_KEY,
      });
      expect(outcome, `HTTP ${status}`).toEqual({ status: "unavailable", reason: expected });
      if (outcome.status === "unavailable") {
        expect(JSON.stringify(outcome)).not.toContain("naming a host");
      }
    }
  });

  it("refuses a response that points somewhere other than the configured origin", async () => {
    seen.length = 0;
    respondWith = {
      status: 200,
      body: JSON.stringify({ signedURL: "https://elsewhere.example/object/sign/x?token=t" }),
    };
    const outcome = await createSignedUrl({
      baseUrl,
      bucket: "hidden-bucket",
      objectRef: SYNTHETIC_KEY_NAME,
      serviceRoleKey: SYNTHETIC_SERVICE_KEY,
    });
    expect(outcome).toEqual({ status: "unavailable", reason: "bad_response" });
  });

  it("accepts the other spelling of the sign response without accepting a foreign origin", async () => {
    seen.length = 0;
    respondWith = { status: 200, body: JSON.stringify({ signedUrl: `/storage/v1/${signedPath}` }) };
    const outcome = await createSignedUrl({
      baseUrl,
      bucket: "hidden-bucket",
      objectRef: SYNTHETIC_KEY_NAME,
      serviceRoleKey: SYNTHETIC_SERVICE_KEY,
    });
    expect(outcome).toEqual({ status: "ok", url: `${baseUrl}/storage/v1/${signedPath}` });
  });

  it("takes the key only in the shape SQL issues it in, and refuses everything else", () => {
    // The CHECK that merged in 20261105070000_knowledge_core.sql:176-180, restated as a client guard:
    // the value this function accepts is the one `object_ref_for_lease_v1` returned, and a
    // request-derived or path-styled value fails here rather than at Storage.
    expect(objectRefIsServerIssued(SYNTHETIC_KEY_NAME)).toBe(true);
    for (const bad of [
      "",
      "knowledge/",
      "secrets/knowledge/x",
      "knowledge/../other/x",
      "knowledge//x",
      "knowledge/a/../b",
      "https://host/storage/v1/object/sign/b/k",
      "knowledge/a?token=b",
      "knowledge/a#b",
      "knowledge/a b",
      "KNOWLEDGE/a",
      "knowledge/" + "x".repeat(600),
    ]) {
      expect(objectRefIsServerIssued(bad), `must refuse ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it("refuses to sign at all when the deployment is not configured (typed unavailable, no throw)", async () => {
    reset();
    const signer = createStorageUrlSigner({});
    const outcome = await signer(SYNTHETIC_KEY_NAME);
    expect(outcome).toEqual({ status: "unavailable", reason: "not_configured" });
    expect(seen).toHaveLength(0);

    const halfConfigured = createStorageUrlSigner({
      TOI_SUPABASE_URL: baseUrl,
      TOI_STORAGE_BUCKET: "hidden-bucket",
    });
    expect(await halfConfigured(SYNTHETIC_KEY_NAME)).toEqual({
      status: "unavailable",
      reason: "not_configured",
    });
    expect(seen).toHaveLength(0);
  });

  it("reads the secret when the call is made, so a rotation is seen by the next mint", async () => {
    reset();
    const env: { TOI_SUPABASE_URL?: string; TOI_STORAGE_SERVICE_ROLE_KEY?: string; TOI_STORAGE_BUCKET?: string } = {
      TOI_SUPABASE_URL: baseUrl,
      TOI_STORAGE_BUCKET: "hidden-bucket",
    };
    const signer = createStorageUrlSigner(env);
    expect(await signer(SYNTHETIC_KEY_NAME)).toEqual({ status: "unavailable", reason: "not_configured" });
    expect(seen).toHaveLength(0);

    env.TOI_STORAGE_SERVICE_ROLE_KEY = SYNTHETIC_SERVICE_KEY;
    expect((await signer(SYNTHETIC_KEY_NAME)).status).toBe("ok");
    expect(seen).toHaveLength(1);
  });

  it("refuses a key that does not belong to the knowledge prefix before the socket", async () => {
    reset();
    const signer = createStorageUrlSigner({
      TOI_SUPABASE_URL: baseUrl,
      TOI_STORAGE_SERVICE_ROLE_KEY: SYNTHETIC_SERVICE_KEY,
      TOI_STORAGE_BUCKET: "hidden-bucket",
    });
    expect(await signer("knowledge/../escape")).toEqual({ status: "unavailable", reason: "key_not_allowed" });
    expect(await signer("")).toEqual({ status: "unavailable", reason: "key_not_allowed" });
    expect(seen).toHaveLength(0);
  });
});
