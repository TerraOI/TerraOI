import postgres from "postgres";
import { requestHost } from "@/platform/tenancy/host";
import type { InquiryDeps } from "./handle-pilot-inquiry";
import { isPlatformHost } from "./platform-host";

// Real implementations of InquiryDeps on Cloudflare Workers (ADR-0002). Every binding is optional
// in the type because staging may not have it yet: a missing secret or binding fails closed
// (Turnstile → false, everything else throws → the handler's generic 503).

export type InquiryEnv = {
  TURNSTILE_SECRET: string;
  INQUIRY_IP_HMAC_KEY: string;
  INQUIRY_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
  INQUIRY_DB: { connectionString: string };
};

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildInquiryDeps(env: Partial<InquiryEnv>): InquiryDeps {
  return {
    // T-101's host rules (T-130 Task 11): the routed URL only, explicit ports refused, and only
    // the hosts parseHost classifies as "platform".
    isPlatformHost,
    requestHost: (req) => requestHost({ url: req.url }),

    async verifyTurnstile(token, ip) {
      if (!env.TURNSTILE_SECRET) return false;
      const form = new FormData();
      form.set("secret", env.TURNSTILE_SECRET);
      form.set("response", token);
      if (ip) form.set("remoteip", ip);
      const res = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
      if (!res.ok) return false;
      const outcome = (await res.json()) as { success?: unknown };
      return outcome.success === true;
    },

    async allowRequest(key) {
      if (!env.INQUIRY_RATE_LIMITER) throw new Error("INQUIRY_RATE_LIMITER binding missing");
      const { success } = await env.INQUIRY_RATE_LIMITER.limit({ key });
      return success;
    },

    async hashIp(ip) {
      if (!env.INQUIRY_IP_HMAC_KEY) throw new Error("INQUIRY_IP_HMAC_KEY missing");
      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(env.INQUIRY_IP_HMAC_KEY),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(ip ?? "unknown")));
    },

    async submit(inquiry, ipHash) {
      if (!env.INQUIRY_DB) throw new Error("INQUIRY_DB binding missing");
      // Hyperdrive pools connections, so one short-lived client per request with no prepared
      // statements is the documented pattern.
      const sql = postgres(env.INQUIRY_DB.connectionString, { prepare: false, max: 1 });
      try {
        await sql`select intake.submit_pilot_inquiry_v1(
          ${inquiry.name}, ${inquiry.email}, ${inquiry.company}, ${inquiry.role},
          ${inquiry.services}::text[], ${inquiry.message}, ${ipHash})`;
      } finally {
        await sql.end({ timeout: 5 });
      }
    },
  };
}
