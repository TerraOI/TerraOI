import type { EmailRejectionReason, EmailRequest, EmailTransport, TransportOutcome } from "./email";

/**
 * The in-memory transport the packet lists as part of this PR ("an in-memory fake for tests"), the
 * same role `gateway-fixtures.ts` plays for the model boundary. T-102 and T-201 wire real transports
 * in their own PRs; their tests should assert on this one instead of inventing a per-packet fake, so
 * there is exactly one place that knows what a recorded email looks like.
 *
 * It is a fake, not a stand-in for a decision: it cannot tell you whether a provider accepted an
 * address, and nothing in production code may reach it.
 */
export interface FakeEmailTransport {
  /** Every request that reached the transport. A refusal at the port leaves this empty, which is how the tests assert "before sending". */
  readonly sent: EmailRequest[];
  readonly outcomes: TransportOutcome[];
  send(request: EmailRequest): Promise<TransportOutcome>;
  credential(): string | undefined;
  readonly credentialReads: number;
}

export interface FakeEmailOptions {
  /** What the fake answers. `sent` is the default, so a happy-path test does not configure anything. */
  outcome?: "sent" | "unavailable" | "rejected";
  /** The reason to answer with when `outcome` is `rejected`. */
  reason?: EmailRejectionReason;
  providerMessageId?: string;
  /** A null credential models a deployment whose secret binding is missing. */
  credential?: string | null;
}

export function fakeEmailTransport(options: FakeEmailOptions = {}): FakeEmailTransport {
  const sent: EmailRequest[] = [];
  const outcomes: TransportOutcome[] = [];
  let credentialReads = 0;

  const outcome: TransportOutcome =
    options.outcome === "unavailable"
      ? { ok: false, kind: "unavailable" }
      : options.outcome === "rejected"
        ? { ok: false, kind: "rejected", reason: options.reason ?? "invalid_message" }
        : { ok: true, providerMessageId: options.providerMessageId ?? "synthetic-message-id" };

  return {
    sent,
    outcomes,
    get credentialReads() {
      return credentialReads;
    },
    credential(): string | undefined {
      credentialReads += 1;
      return options.credential === null || options.credential === undefined ? undefined : options.credential;
    },
    async send(request: EmailRequest): Promise<TransportOutcome> {
      sent.push({ ...request });
      outcomes.push(outcome);
      return outcome;
    },
  };
}

/**
 * A fake wired the way a deployment's transport would be: sender configuration and tenant host from
 * the caller's server-side context. Tests override one field at a time to model a misconfiguration.
 */
export function fakeEmailTransportWith(options: {
  fromAddress: string;
  sendingDomain: string;
  tenantHost: string;
} & FakeEmailOptions): EmailTransport & FakeEmailTransport {
  const { fromAddress, sendingDomain, tenantHost, ...fakeOptions } = options;
  return {
    ...fakeEmailTransport(fakeOptions),
    fromAddress,
    sendingDomain,
    tenantHost,
  };
}
