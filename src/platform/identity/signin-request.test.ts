import { describe, expect, it } from "vitest";

import { issueCsrfToken } from "./csrf";
import { handleEntraSignInRequest, type EntraStartPorts } from "./entra-linking";
import { handleMagicLinkRequest, type MagicLinkRequestPorts } from "./request-magic-link";
import { limitMaterial } from "./signin-request";

/**
 * #181 B2: address-less Entra starts must not share HMAC(host|"invalid-address") with malformed
 * magic-link / password / reset posts. Per-method material (N4) keeps those budgets separate too.
 */

const SECRET = "synthetic-test-secret-not-a-real-key-0000000000";
const NOW = 1_800_000_000;
const HOST = "company1.terraoi.app";
const C1 = "11111111-1111-4111-8111-111111111111";
const BASE = "https://synthetic-project.supabase.co";
const CLIENT_IP = "203.0.113.77";

describe("limitMaterial", () => {
  it("scopes address-bearing methods by method|email and Entra by entra-start|ip", () => {
    const req = new Request(`https://${HOST}/auth/entra`, {
      headers: { "cf-connecting-ip": CLIENT_IP },
    });
    expect(limitMaterial("magic-link", "owner1@company1.test", req)).toBe("magic-link|owner1@company1.test");
    expect(limitMaterial("magic-link", null, req)).toBe("magic-link|invalid-address");
    expect(limitMaterial("password", null, req)).toBe("password|invalid-address");
    expect(limitMaterial("password-reset", null, req)).toBe("password-reset|invalid-address");
    expect(limitMaterial("entra-start", null, req)).toBe(`entra-start|${CLIENT_IP}`);
    expect(limitMaterial("entra-start", "ignored@example.test", req)).toBe(`entra-start|${CLIENT_IP}`);
  });

  it("uses a missing-ip sentinel when CF-Connecting-IP is absent, not invalid-address", () => {
    const req = new Request(`https://${HOST}/auth/entra`);
    expect(limitMaterial("entra-start", null, req)).toBe("entra-start|missing-ip");
  });
});

describe("malformed magic-link posts do not spend the Entra budget (B2)", () => {
  it("records distinct limiter material for a flood of bad addresses vs an Entra start", async () => {
    const limiterKeys: Array<{ host: string; material: string }> = [];
    const spent = new Set<string>();

    const shared = {
      now: () => NOW,
      signingSecret: () => SECRET,
      findHost: async (host: string) =>
        host === HOST ? { organisationId: C1, organisationStatus: "active" } : null,
      rateLimitKey: async (input: { host: string; material: string }) => {
        limiterKeys.push(input);
        return `${input.host}|${input.material}`;
      },
      allowRequest: async (key: string) => {
        // One allowance per distinct key: a shared bucket would make the Entra start fail after the
        // malformed flood; separate material keeps Entra's key unused until it runs.
        if (spent.has(key)) return false;
        spent.add(key);
        return true;
      },
    };

    const magicPorts: MagicLinkRequestPorts = {
      ...shared,
      sendMagicLink: async () => {
        throw new Error("must not dial for a malformed address");
      },
    };

    for (let i = 0; i < 5; i += 1) {
      const csrf = await issueCsrfToken({ host: HOST, secret: SECRET, now: NOW });
      const response = await handleMagicLinkRequest({
        request: new Request(`https://${HOST}/auth/magic-link`, {
          method: "POST",
          headers: {
            origin: `https://${HOST}`,
            "content-type": "application/x-www-form-urlencoded",
            "cf-connecting-ip": CLIENT_IP,
          },
          body: new URLSearchParams({ csrf_token: csrf, email: "not-an-address" }).toString(),
        }),
        ports: magicPorts,
      });
      // First malformed post spends magic-link|invalid-address; later ones are rate-limited on that
      // bucket alone — Entra's key is still free.
      if (i === 0) {
        expect(response.status).toBe(303);
        expect(new URL(response.headers.get("location") as string).searchParams.get("outcome")).toBe("link_sent");
      } else {
        expect(new URL(response.headers.get("location") as string).searchParams.get("outcome")).toBe("rate_limited");
      }
    }

    expect(limiterKeys.every((entry) => entry.material === "magic-link|invalid-address")).toBe(true);
    expect(limiterKeys.some((entry) => entry.material.startsWith("entra-start|"))).toBe(false);

    const entraPorts: EntraStartPorts = {
      ...shared,
      supabaseBaseUrl: () => BASE,
      allowedEntraIssuers: async () => ["6f1e0000-0000-4000-8000-0000000000aa"],
    };
    const csrf = await issueCsrfToken({ host: HOST, secret: SECRET, now: NOW });
    const entra = await handleEntraSignInRequest({
      request: new Request(`https://${HOST}/auth/entra`, {
        method: "POST",
        headers: {
          origin: `https://${HOST}`,
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": CLIENT_IP,
        },
        body: new URLSearchParams({ csrf_token: csrf }).toString(),
      }),
      ports: entraPorts,
    });

    expect(entra.status).toBe(302);
    expect(entra.headers.get("location")).toContain("/auth/v1/authorize");
    expect(limiterKeys.some((entry) => entry.material === `entra-start|${CLIENT_IP}`)).toBe(true);
  });
});
