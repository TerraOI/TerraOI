import { describe, expect, it, vi } from "vitest";

import {
  EMAIL_LIMITS,
  sendEmail,
  tenantEmailLink,
  type EmailMessage,
  type EmailTransport,
  type SendEmailResult,
} from "./email";
import { fakeEmailTransport } from "./email-fixtures";

/**
 * T-105: the outbound email port, tested against the packet's own contract
 * (`docs/tasks/T-105-email-transport.md`), before anything is implemented.
 *
 * What this file is protecting:
 *   * the From address is configuration, never caller or tenant input (#64: one verified TerraOI
 *     sending domain; plan §5.1: the tenant's display name is the sender *name*);
 *   * links live on the resolved tenant host and nowhere else (plan §4.1 step 6) — a magic-link email
 *     that points at another tenant, the apex or a `workers.dev` alias is a cross-tenant credential
 *     hand-off, and it must be refused **before** anything is sent;
 *   * header injection is refused at the port, not at the provider;
 *   * an unconfigured transport answers the typed `unavailable` and performs no network call — the
 *     packet's "no fake success" rule.
 *
 * Synthetic fixtures only (AGENTS.md §4.7): `example.test` addresses and a `mail.terraoi.app` sender
 * that is not a real mailbox.
 */

const FROM = "no-reply@mail.terraoi.app";
const DOMAIN = "mail.terraoi.app";
const HOST = "company1.terraoi.app";

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: "owner1@company1.test",
    subject: "Sign in to Company1",
    text: `Use this link: https://${HOST}/auth/callback?code=abc123`,
    html: `<a href="https://${HOST}/auth/callback?code=abc123">Sign in</a>`,
    senderDisplayName: "Company1",
    ...overrides,
  };
}

function transportFor(
  options: {
    credential?: () => string | undefined;
    fromAddress?: string;
    sendingDomain?: string;
    tenantHost?: string;
  } = {},
): { transport: EmailTransport & ReturnType<typeof fakeEmailTransport> } {
  const fake = fakeEmailTransport();
  return {
    transport: {
      ...fake,
      fromAddress: options.fromAddress ?? FROM,
      sendingDomain: options.sendingDomain ?? DOMAIN,
      tenantHost: options.tenantHost ?? HOST,
      credential: options.credential ?? (() => "synthetic-provider-token"),
    },
  };
}

describe("sendEmail — the happy path reaches the transport with the configured sender (plan §5.1)", () => {
  it("passes the configured From address composed with the tenant display name", async () => {
    const { transport } = transportFor();
    const result = await sendEmail(message(), transport);

    expect(result).toEqual({ status: "sent", providerMessageId: "synthetic-message-id" });
    expect(transport.sent).toHaveLength(1);
    const request = transport.sent[0] as NonNullable<(typeof transport.sent)[number]>;
    // The address is configuration; only the display name is the tenant's (§64: no per-tenant senders).
    expect(request.from).toBe(`Company1 <${FROM}>`);
    expect(request.to).toBe("owner1@company1.test");
    expect(request.subject).toBe("Sign in to Company1");
    expect(request.text).toContain(`https://${HOST}/auth/callback`);
  });

  it("carries replyTo only when the caller supplied one, and omits html when there is none", async () => {
    const withReply = transportFor();
    expect((await sendEmail(message({ replyTo: "support@terraoi.app" }), withReply.transport)).status).toBe("sent");
    expect(withReply.transport.sent[0]?.replyTo).toBe("support@terraoi.app");

    const withoutHtml = transportFor();
    await sendEmail(message({ html: undefined }), withoutHtml.transport);
    expect(withoutHtml.transport.sent[0]?.html).toBeUndefined();
    expect(withoutHtml.transport.sent[0]?.replyTo).toBeUndefined();
  });

  it("canonicalizes the recipient, so the provider sees the one address form the product uses", async () => {
    const { transport } = transportFor();
    const result = await sendEmail(message({ to: " Owner1@Company1.TEST " }), transport);
    expect(result.status).toBe("sent");
    expect(transport.sent[0]?.to).toBe("owner1@company1.test");
  });

  it("a transport failure is the typed unavailable, never a thrown provider detail", async () => {
    const fake = fakeEmailTransport({ outcome: "unavailable" });
    const transport = {
      ...fake,
      fromAddress: FROM,
      sendingDomain: DOMAIN,
      tenantHost: HOST,
      credential: () => "synthetic-provider-token",
    };
    expect(await sendEmail(message(), transport)).toEqual({ status: "unavailable" });
  });

  it("a transport rejection is a closed reason code, and nothing else travels", async () => {
    const fake = fakeEmailTransport({ outcome: "rejected", reason: "invalid_message" });
    const transport = {
      ...fake,
      fromAddress: FROM,
      sendingDomain: DOMAIN,
      tenantHost: HOST,
      credential: () => "synthetic-provider-token",
    };
    expect(await sendEmail(message(), transport)).toEqual({ status: "rejected", reason: "invalid_message" });
  });
});

describe("sendEmail — the sender is configuration, never input (#64)", () => {
  it("refuses a caller-supplied From address instead of letting it through", async () => {
    for (const key of ["from", "fromAddress", "from_email", "sender"]) {
      const { transport } = transportFor();
      const poisoned = { ...message(), [key]: "attacker@other.example" } as unknown as EmailMessage;
      const result = await sendEmail(poisoned, transport);
      expect(result, key).toEqual({ status: "rejected", reason: "sender" });
      expect(transport.sent).toHaveLength(0);
    }
  });

  it("refuses an unknown field outright, so a new sender-ish key cannot slip past the named list", async () => {
    const { transport } = transportFor();
    const poisoned = { ...message(), bcc: "someone@other.example" } as unknown as EmailMessage;
    expect(await sendEmail(poisoned, transport)).toEqual({ status: "rejected", reason: "malformed" });
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses a transport configured with a From outside the verified sending domain", async () => {
    const { transport } = transportFor({ fromAddress: "no-reply@other.example", sendingDomain: DOMAIN });
    expect(await sendEmail(message(), transport)).toEqual({ status: "rejected", reason: "sender" });
    expect(transport.sent).toHaveLength(0);
  });

  it("refuses a display name that could re-open the address: angle brackets, quotes, backslash, @ or :", async () => {
    for (const name of [
      `Company1 <attacker@other.example>`,
      'Company1 "quoted"',
      "Company1\\name",
      "Company1@other.example",
      "Company1:suffix",
      "",
      "   ",
      `Company1\r\nX-Priority: 1`,
    ]) {
      const { transport } = transportFor();
      const result = await sendEmail(message({ senderDisplayName: name }), transport);
      expect(result, name).toEqual({ status: "rejected", reason: "sender" });
      expect(transport.sent).toHaveLength(0);
    }
  });
});

describe("sendEmail — links must live on the resolved tenant host (plan §4.1 step 6)", () => {
  // A magic-link email to a host that is not the tenant's is not a formatting bug: it hands a
  // credential to another origin, or to another tenant. Checked before the transport is reached.
  const foreign = [
    `https://company2.terraoi.app/auth/callback?code=abc123`,
    `https://my-app.workers.dev/auth/callback?code=abc123`,
    `https://terraoi.app/auth/callback?code=abc123`,
    `https://www.terraoi.app/auth/callback?code=abc123`,
    `https://company1.terraoi.app.evil.test/auth/callback?code=abc123`,
    `https://Company1.terraoi.app/auth/callback?code=abc123`,
    `http://${HOST}/auth/callback?code=abc123`,
    `//${"company2.terraoi.app"}/auth/callback?code=abc123`,
    `https://${HOST}:8443/auth/callback?code=abc123`,
    `https://${HOST}.evil.test/auth/callback`,
    // The scheme's case is not a defence: an email client linkifies these exactly like the lowercase
    // form, so the scan has to be case-insensitive.
    `HTTPS://company2.terraoi.app/auth/callback?code=abc123`,
    `HtTpS://company2.terraoi.app/auth/callback?code=abc123`,
  ];

  for (const [index, link] of foreign.entries()) {
    it(`refuses link ${index + 1}: ${link.slice(0, 48)}…`, async () => {
      const { transport } = transportFor();
      const result = await sendEmail(message({ text: `link ${link}`, html: `<a href="${link}">x</a>` }), transport);
      expect(result).toEqual({ status: "rejected", reason: "link_host" });
      expect(transport.sent).toHaveLength(0);
    });
  }

  it("accepts a relative link and a mailto, and a bare domain in prose that is not a URL", async () => {
    const { transport } = transportFor();
    const result = await sendEmail(
      message({ text: `open /login or mailto:support@terraoi.app — we are at terraoi.app`, html: `<a href="/login">x</a>` }),
      transport,
    );
    expect(result.status).toBe("sent");
  });

  it("fails closed on a scheme it cannot read even when the host is the tenant's", async () => {
    // Deliberate: `HTTPS://company1.terraoi.app/x` points at the right place, and normalizing the
    // scheme would mean this port vouches for a form it did not parse. Templates (T-204) write
    // lowercase `https://`, so refusing is the cheap direction to be wrong in.
    for (const text of [`HTTPS://${HOST}/auth/callback`, `HtTpS://${HOST}/auth/callback`]) {
      const { transport } = transportFor();
      expect(await sendEmail(message({ text }), transport)).toEqual({ status: "rejected", reason: "link_host" });
      expect(transport.sent).toHaveLength(0);
    }
  });

  it("a transport whose tenantHost is not a resolved tenant host sends nothing", async () => {
    for (const host of ["", "terraoi.app", "my-app.workers.dev", "company1.terraoi.app:8443", "Company1.terraoi.app", "127.0.0.1"]) {
      const { transport } = transportFor({ tenantHost: host });
      expect(await sendEmail(message(), transport)).toEqual({ status: "rejected", reason: "link_host" });
      expect(transport.sent).toHaveLength(0);
    }
  });
});

describe("sendEmail — header injection is refused at the port", () => {
  const injections: Array<[string, Partial<EmailMessage>, "subject" | "sender" | "recipient"]> = [
    ["subject CRLF", { subject: "Sign in\r\nX-Priority: 1" }, "subject"],
    ["subject CR only", { subject: "Sign in\rX-Priority: 1" }, "subject"],
    ["subject LF only", { subject: "Sign in\nX-Priority: 1" }, "subject"],
    ["display name CRLF", { senderDisplayName: "Company1\r\nBcc: someone@other.example" }, "sender"],
    ["recipient CRLF", { to: "owner1@company1.test\r\nX-Foo: bar" }, "recipient"],
    ["recipient embedded CR", { to: "owner1\r@company1.test" }, "recipient"],
    ["reply-to CRLF", { replyTo: "support@terraoi.app\r\nBcc: someone@other.example" }, "recipient"],
  ];

  for (const [label, patch, reason] of injections) {
    it(`refuses ${label}`, async () => {
      const { transport } = transportFor();
      expect(await sendEmail(message(patch), transport)).toEqual({ status: "rejected", reason });
      expect(transport.sent).toHaveLength(0);
    });
  }

  it("refuses control characters in the subject even without CR or LF", async () => {
    const { transport } = transportFor();
    expect(await sendEmail(message({ subject: `Sign in\u0000to Company1` }), transport)).toEqual({
      status: "rejected",
      reason: "subject",
    });
    expect(transport.sent).toHaveLength(0);
  });
});

describe("sendEmail — a refusal is never a way to ask whether an address is ours", () => {
  // plan §4.2 keeps "does this address belong to a member" in the identity layer; this port has no
  // account lookup in front of it, and `notifications-boundary.test.ts` is what keeps that true. What
  // this file pins is the other half of the same rule: the answer never names an address, and the
  // vocabulary never says anything about a person. The caller (T-102, T-201) owns the user-facing words.
  const addresses = ["owner1@company1.test", "nobody@company2.test", "does-not-exist@terraoi.app"];

  it("the same syntax refusal for every address, so the code cannot be probed for existence", async () => {
    for (const to of addresses) {
      const { transport } = transportFor();
      expect(await sendEmail(message({ to: `${to}\r\nX-Foo: bar` }), transport)).toEqual({
        status: "rejected",
        reason: "recipient",
      });
      expect(transport.sent).toHaveLength(0);
    }
  });

  it("refuses a recipient list, so this port cannot be aimed at a crowd", async () => {
    for (const to of [
      "owner1@company1.test, owner2@company1.test",
      "owner1@company1.test;owner2@company1.test",
      "owner1@company1.test owner2@company1.test",
      "Company1 Owner <owner1@company1.test>",
    ]) {
      const { transport } = transportFor();
      expect(await sendEmail(message({ to }), transport)).toEqual({ status: "rejected", reason: "recipient" });
      expect(transport.sent).toHaveLength(0);
    }
  });

  it("neither a result nor a log line names the recipient or the reply-to address", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const outcomes: SendEmailResult[] = [];
      outcomes.push(await sendEmail(message({ to: "owner1@company1.test\r\nX-Foo: bar" }), transportFor().transport));
      outcomes.push(await sendEmail(message({ replyTo: "support@terraoi.app\r\nBcc: someone@other.example" }), transportFor().transport));
      outcomes.push(await sendEmail(message({ to: "nope" }), transportFor().transport));
      const rejected = fakeEmailTransport({
        outcome: "rejected",
        reason: "invalid_recipient",
        credential: "synthetic-provider-token",
      });
      outcomes.push(
        await sendEmail(message(), { ...rejected, fromAddress: FROM, sendingDomain: DOMAIN, tenantHost: HOST }),
      );

      for (const result of outcomes) {
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("owner1@company1.test");
        expect(serialized).not.toContain("owner1");
        expect(serialized).not.toContain("support@terraoi.app");
        expect(serialized).not.toContain("mail.terraoi.app");
      }
      const logged = errors.mock.calls.map((call) => call.map((arg) => String(arg)).join(" ")).join("\n");
      expect(logged).not.toContain("@company1.test");
      expect(logged).not.toContain("@terraoi.app");
      expect(logged).toContain("email");
    } finally {
      errors.mockRestore();
    }
  });
});

describe("sendEmail — an unconfigured transport is typed unavailable with no network call", () => {
  it("missing credential means the transport is never reached", async () => {
    for (const credential of [() => undefined, () => "", () => null]) {
      const { transport } = transportFor({ credential: credential as () => string | undefined });
      expect(await sendEmail(message(), transport)).toEqual({ status: "unavailable" });
      expect(transport.sent).toHaveLength(0);
    }
  });

  it("a malformed message is refused before the credential is even read", async () => {
    let credentialReads = 0;
    const { transport } = transportFor({
      credential: () => {
        credentialReads += 1;
        return "synthetic-provider-token";
      },
    });
    expect(await sendEmail(message({ to: "not-an-address" }), transport)).toEqual({ status: "rejected", reason: "recipient" });
    expect(credentialReads).toBe(0);
    expect(transport.sent).toHaveLength(0);
  });

  it("a message with no text body is refused rather than sent empty", async () => {
    const { transport } = transportFor();
    expect(await sendEmail(message({ text: "" }), transport)).toEqual({ status: "rejected", reason: "body" });
    expect(transport.sent).toHaveLength(0);
  });

  it("an over-long subject, display name or body is refused (provider limits are not a surprise)", async () => {
    const { transport } = transportFor();
    expect(await sendEmail(message({ subject: "s".repeat(EMAIL_LIMITS.subject + 1) }), transport)).toEqual({
      status: "rejected",
      reason: "subject",
    });
    expect(await sendEmail(message({ senderDisplayName: "n".repeat(EMAIL_LIMITS.displayName + 1) }), transport)).toEqual({
      status: "rejected",
      reason: "sender",
    });
    expect(await sendEmail(message({ text: "t".repeat(EMAIL_LIMITS.text + 1) }), transport)).toEqual({
      status: "rejected",
      reason: "body",
    });
    expect(transport.sent).toHaveLength(0);
  });

  it("a transport that throws is unavailable, and its message never escapes", async () => {
    const boom: EmailTransport = {
      fromAddress: FROM,
      sendingDomain: DOMAIN,
      tenantHost: HOST,
      credential: () => "synthetic-provider-token",
      send: async () => {
        throw new Error("socket hung up with token synthetic-provider-token");
      },
    };
    const result = await sendEmail(message(), boom);
    expect(result).toEqual({ status: "unavailable" });
    expect(JSON.stringify(result)).not.toContain("synthetic-provider-token");
    expect(JSON.stringify(result)).not.toContain("socket hung up");
  });

  it("the credential and the provider's words appear in no log line either", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const throwing: EmailTransport = {
        fromAddress: FROM,
        sendingDomain: DOMAIN,
        tenantHost: HOST,
        credential: () => "synthetic-provider-token",
        send: async () => {
          throw new Error("provider said: token synthetic-provider-token rejected");
        },
      };
      await sendEmail(message(), throwing);
      await sendEmail(message(), { ...throwing, credential: () => undefined });
      const logged = errors.mock.calls.map((call) => call.map((arg) => String(arg)).join(" ")).join("\n");
      expect(logged).not.toContain("synthetic-provider-token");
      expect(logged).not.toContain("provider said");
      // And the log is not empty: the failure is recorded somewhere, or an operator cannot see it.
      expect(logged).toContain("email");
    } finally {
      errors.mockRestore();
    }
  });
});

describe("tenantEmailLink — the link builder is the host resolver, not a global site URL (#64)", () => {
  it("builds an absolute https link for a resolved tenant host", () => {
    expect(tenantEmailLink(HOST, "/auth/callback?code=abc123")).toBe(`https://${HOST}/auth/callback?code=abc123`);
    expect(tenantEmailLink("company1-staging.terraoi.app", "/login")).toBe("https://company1-staging.terraoi.app/login");
  });

  it("refuses hosts that are not a tenant origin, so a global URL cannot be the fallback", () => {
    for (const host of ["", "terraoi.app", "www.terraoi.app", "my-app.workers.dev", "127.0.0.1", "Company1.terraoi.app", `${HOST}:8443`]) {
      expect(tenantEmailLink(host, "/login"), host).toBeNull();
    }
  });

  it("refuses a path that is not a path, so the host cannot be smuggled in through the second argument", () => {
    for (const path of [
      "",
      "login",
      "//evil.test/login",
      "https://evil.test/login",
      `/${HOST}/login`,
      "/login?next=https://evil.test",
      "/login%0d%0a",
      "/\r\n/login",
    ]) {
      expect(tenantEmailLink(HOST, path), path).toBeNull();
    }
  });
});
