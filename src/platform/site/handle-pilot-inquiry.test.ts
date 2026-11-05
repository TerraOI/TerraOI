import { describe, expect, it, vi } from "vitest";
import { handlePilotInquiry, type InquiryDeps } from "./handle-pilot-inquiry";

const HASH = "a".repeat(64);
const IP = "203.0.113.7";

const body = {
  name: "Dana Reyes",
  email: "dana@company1.com",
  company: "Company1",
  services: ["uav"],
  privacyAcknowledged: true,
  turnstileToken: "tok",
};

function deps(overrides: Partial<InquiryDeps> = {}) {
  return {
    isPlatformHost: vi.fn((h: string | null) => h === "terraoi.app"),
    requestHost: vi.fn(() => "terraoi.app"),
    verifyTurnstile: vi.fn(async () => true),
    allowRequest: vi.fn(async () => true),
    hashIp: vi.fn(async () => HASH),
    submit: vi.fn(async () => {}),
    ...overrides,
  } satisfies InquiryDeps;
}

function req(init: { body?: BodyInit; origin?: string | null; type?: string | null; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set("origin", init.origin ?? "https://terraoi.app");
  if (init.type !== null) headers.set("content-type", init.type ?? "application/json");
  headers.set("cf-connecting-ip", IP);
  return new Request("https://terraoi.app/api/pilot-inquiry", {
    method: "POST",
    headers,
    body: init.body ?? JSON.stringify(body),
  });
}

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe("handlePilotInquiry request path", () => {
  it("returns 404 on a non-platform host", async () => {
    const d = deps({ requestHost: vi.fn(() => "company1.terraoi.app") });
    expect((await handlePilotInquiry(req(), d)).status).toBe(404);
  });

  it("returns 403 when Origin does not exactly match the host", async () => {
    for (const origin of ["https://evil.example", "http://terraoi.app", "https://terraoi.app.evil.example", null]) {
      expect((await handlePilotInquiry(req({ origin }), deps())).status, String(origin)).toBe(403);
    }
  });

  it("returns 415 for non-JSON content", async () => {
    expect((await handlePilotInquiry(req({ type: "text/plain" }), deps())).status).toBe(415);
    expect((await handlePilotInquiry(req({ type: null }), deps())).status).toBe(415);
  });

  it("accepts application/json with a charset", async () => {
    expect((await handlePilotInquiry(req({ type: "application/json; charset=utf-8" }), deps())).status).toBe(201);
  });

  it("returns 413 for a body of 8,193 bytes", async () => {
    const big = JSON.stringify({ ...body, message: "m".repeat(8193) });
    expect((await handlePilotInquiry(req({ body: big }), deps())).status).toBe(413);
  });

  it("returns 413 for an oversized stream with no Content-Length", async () => {
    const chunk = new TextEncoder().encode("x".repeat(4096));
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 3; i++) c.enqueue(chunk);
        c.close();
      },
    });
    const r = new Request("https://terraoi.app/api/pilot-inquiry", {
      method: "POST",
      headers: { origin: "https://terraoi.app", "content-type": "application/json" },
      body: stream,
      // @ts-expect-error duplex is required for stream bodies in Node but missing from lib.dom
      duplex: "half",
    });
    expect((await handlePilotInquiry(r, deps())).status).toBe(413);
  });

  it("returns 400 with field errors for a schema error, and for invalid JSON", async () => {
    const res = await handlePilotInquiry(req({ body: JSON.stringify({ ...body, services: [] }) }), deps());
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ fieldErrors: { services: "Choose at least one service." } });
    expect((await handlePilotInquiry(req({ body: "{not json" }), deps())).status).toBe(400);
  });

  it("returns 400 when Turnstile fails", async () => {
    const res = await handlePilotInquiry(req(), deps({ verifyTurnstile: vi.fn(async () => false) }));
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: "Verification failed. Try again." });
  });

  it("returns 429 when the rate limiter refuses", async () => {
    const d = deps({ allowRequest: vi.fn(async () => false) });
    const res = await handlePilotInquiry(req(), d);
    expect(res.status).toBe(429);
    expect(await json(res)).toEqual({ error: "Too many requests. Try again later." });
    expect(d.allowRequest).toHaveBeenCalledWith(HASH);
  });

  it("returns a generic 503 when submit throws, without echoing the error", async () => {
    const d = deps({ submit: vi.fn(async () => Promise.reject(new Error("pg: password authentication failed for inquiry_writer"))) });
    const res = await handlePilotInquiry(req(), d);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "The service is temporarily unavailable. Try again later." });
    expect(text).not.toContain("inquiry_writer");
  });

  it("returns 503 when any dependency throws", async () => {
    for (const key of ["verifyTurnstile", "allowRequest", "hashIp"] as const) {
      const d = deps({ [key]: vi.fn(async () => Promise.reject(new Error("boom"))) });
      expect((await handlePilotInquiry(req(), d)).status, key).toBe(503);
    }
  });

  it("returns 201 and submits once with the hash, never the raw IP", async () => {
    const submit = vi.fn<InquiryDeps["submit"]>(async () => {});
    const d = deps({ submit });
    const res = await handlePilotInquiry(req(), d);
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ status: "received" });
    expect(submit).toHaveBeenCalledTimes(1);
    const args = submit.mock.calls[0]!;
    expect(args[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(args)).not.toContain(IP);
    expect(d.verifyTurnstile).toHaveBeenCalledWith("tok", IP);
  });

  it("checks run cheapest first", async () => {
    const d = deps({ requestHost: vi.fn(() => null) });
    expect((await handlePilotInquiry(req(), d)).status).toBe(404);
    expect(d.verifyTurnstile).not.toHaveBeenCalled();
    expect(d.allowRequest).not.toHaveBeenCalled();
    expect(d.submit).not.toHaveBeenCalled();

    const bad = deps();
    await handlePilotInquiry(req({ body: JSON.stringify({ ...body, email: "x" }) }), bad);
    expect(bad.verifyTurnstile).not.toHaveBeenCalled();
  });
});
