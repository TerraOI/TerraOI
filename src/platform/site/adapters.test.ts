import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInquiryDeps } from "./adapters";
import { handlePilotInquiry } from "./handle-pilot-inquiry";

afterEach(() => vi.restoreAllMocks());

const inquiry = {
  name: "Dana",
  email: "dana@company1.com",
  company: "Company1",
  role: null,
  services: ["uav" as const],
  message: null,
};

describe("buildInquiryDeps", () => {
  it("returns 503 when the DB binding is absent", async () => {
    const deps = buildInquiryDeps({});
    await expect(deps.submit(inquiry, "a".repeat(64))).rejects.toThrow();

    const res = await handlePilotInquiry(
      new Request("https://terraoi.app/api/pilot-inquiry", {
        method: "POST",
        headers: { origin: "https://terraoi.app", "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify({ ...inquiry, role: undefined, message: undefined, privacyAcknowledged: true, turnstileToken: "t" }),
      }),
      { ...deps, verifyTurnstile: async () => true, allowRequest: async () => true, hashIp: async () => "a".repeat(64) },
    );
    expect(res.status).toBe(503);
  });

  it("hashIp is a keyed HMAC", async () => {
    const a = await buildInquiryDeps({ INQUIRY_IP_HMAC_KEY: "key-one" }).hashIp("203.0.113.7");
    const b = await buildInquiryDeps({ INQUIRY_IP_HMAC_KEY: "key-two" }).hashIp("203.0.113.7");
    const again = await buildInquiryDeps({ INQUIRY_IP_HMAC_KEY: "key-one" }).hashIp("203.0.113.7");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(again).toBe(a);
    expect(a).not.toContain("203");
  });

  it("hashIp fails closed without a key", async () => {
    await expect(buildInquiryDeps({}).hashIp("203.0.113.7")).rejects.toThrow();
  });

  it("verifyTurnstile posts secret, response and remoteip", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(Response.json({ success: false }));
    const deps = buildInquiryDeps({ TURNSTILE_SECRET: "sekret" });
    expect(await deps.verifyTurnstile("tok", "203.0.113.7")).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init?.method).toBe("POST");
    const form = init?.body as FormData;
    expect(form.get("secret")).toBe("sekret");
    expect(form.get("response")).toBe("tok");
    expect(form.get("remoteip")).toBe("203.0.113.7");
    expect(await deps.verifyTurnstile("tok", null)).toBe(false);
  });

  it("missing secrets fail closed", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await buildInquiryDeps({}).verifyTurnstile("tok", "203.0.113.7")).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("allowRequest uses the rate-limit binding and fails closed without it", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    expect(await buildInquiryDeps({ INQUIRY_RATE_LIMITER: { limit } }).allowRequest("h")).toBe(false);
    expect(limit).toHaveBeenCalledWith({ key: "h" });
    await expect(buildInquiryDeps({}).allowRequest("h")).rejects.toThrow();
  });

  it("only terraoi.app and www.terraoi.app are platform hosts until T-101's resolver lands", () => {
    const deps = buildInquiryDeps({});
    expect(deps.isPlatformHost("terraoi.app")).toBe(true);
    expect(deps.isPlatformHost("www.terraoi.app")).toBe(true);
    for (const h of ["company1.terraoi.app", "admin.terraoi.app", "terraoi.app.evil.example", null]) {
      expect(deps.isPlatformHost(h)).toBe(false);
    }
  });

  it("requestHost comes from the request URL, never X-Forwarded-Host", () => {
    const req = new Request("https://terraoi.app/api/pilot-inquiry", { headers: { "x-forwarded-host": "evil.example" } });
    expect(buildInquiryDeps({}).requestHost(req)).toBe("terraoi.app");
  });
});
