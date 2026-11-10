import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { resolveTenantContext, type TenancyStore } from "@/platform/tenancy/resolve-tenant-context";
import { ROUTED_HOST_HEADER, resolvePageTenantContext } from "@/platform/tenancy/page-host";
import { routedHostHeaders } from "./proxy";

// Loopback harness (COORDINATION.md §6a): what the unit tests cannot show is what actually crossed
// a socket. Two real legs over 127.0.0.1 with an ephemeral port: a client sends a forged
// `x-toi-routed-host`, the edge leg runs the proxy step, and the page leg reports the headers it
// received on its own socket and what the tenancy helper made of them. No Docker, no fixed port, no
// external network; the listener is closed in afterAll.
//
// What this does NOT prove: that a real tenant hostname reaches the page. Loopback's routed host is
// `127.0.0.1:<port>`, so the tenant-host claim is staging evidence and is owed (ADR-0006 condition).

const store: TenancyStore = {
  async findHost() {
    return null;
  },
  async findMembership() {
    return null;
  },
  async policyRevision() {
    return 1;
  },
};

function headersFromRequest(req: IncomingMessage): Headers {
  const h = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) h.append(name, v);
    else h.set(name, value);
  }
  return h;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

let server: Server;
let origin = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);

    if (url.pathname === "/page") {
      // The page leg: only what arrived on this socket, read the way a page reads it.
      const received = headersFromRequest(req);
      void resolvePageTenantContext({ headers: received, userId: null, store }).then((outcome) => {
        json(res, 200, {
          routedHostValues: received.get(ROUTED_HOST_HEADER),
          host: received.get("host"),
          forwardedHost: received.get("x-forwarded-host"),
          outcome,
        });
      });
      return;
    }

    if (url.pathname === "/edge") {
      // The edge leg: the proxy step, then a second real request carrying only its output.
      const inbound = headersFromRequest(req);
      const skipProxy = url.searchParams.get("skipProxy") === "1";
      const forwarded = skipProxy ? inbound : routedHostHeaders(inbound, url.toString());
      // Harness-only: hop-by-hop headers describe *this* socket and would be wrong on the next one.
      // Next's own transport does the same thing; the assertion is about `x-toi-routed-host`.
      for (const hop of ["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "content-length"]) {
        forwarded.delete(hop);
      }
      void fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/page`, {
        headers: forwarded,
      })
        .then(async (pageResponse) => {
          const pageSaw = (await pageResponse.json()) as {
            routedHostValues: string | null;
            host: string | null;
            forwardedHost: string | null;
            outcome: unknown;
          };
          json(res, 200, { pageSaw });
        })
        .catch((error: unknown) => json(res, 500, { error: String(error) }));
      return;
    }

    json(res, 404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server?.close();
});

describe("loopback harness: the proxy overwrite is what reaches the page's socket", () => {
  it("replaces forged inbound values with the host the socket was addressed to", async () => {
    const forged = new Headers();
    forged.set("host", "company2.terraoi.app");
    forged.append("x-toi-routed-host", "company2.terraoi.app");
    forged.append("x-toi-routed-host", "evil.example");
    forged.set("x-forwarded-host", "company2.terraoi.app");
    forged.set("cookie", "toi_session=opaque");

    const response = await fetch(`${origin}/edge`, { headers: forged });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      pageSaw: { routedHostValues: string | null; host: string | null; forwardedHost: string | null };
    };

    const socketHost = new URL(`${origin}/edge`).host;
    expect(body.pageSaw.routedHostValues).toBe(socketHost);
    expect(body.pageSaw.routedHostValues).not.toContain("company2.terraoi.app");
    expect(body.pageSaw.routedHostValues).not.toContain("evil.example");
    expect(body.pageSaw.routedHostValues?.split(",").length).toBe(1);
    // `X-Forwarded-Host` crosses untouched, which is exactly why the helper must not read it
    // (ADR-0006 rule 2). Note for the reader: Node's `fetch` fixes `Host` from the socket, so this
    // harness cannot forge `Host` on the wire — the ignore-Host rule is pinned at the helper level
    // in `page-host.test.ts`, and a forged `Host` from a real client is staging evidence (owed).
    expect(body.pageSaw.forwardedHost).toBe("company2.terraoi.app");
    expect(body.pageSaw.host).toBe(socketHost);
  });

  it("a page behind a skipped proxy fails closed on the wire: no header, no tenant, no default", async () => {
    const inbound = new Headers();
    inbound.set("host", "company1.terraoi.app");
    inbound.set("x-forwarded-host", "company1.terraoi.app");

    const response = await fetch(`${origin}/edge?skipProxy=1`, { headers: inbound });
    const body = (await response.json()) as {
      pageSaw: { routedHostValues: string | null; outcome: { ok: boolean; reason?: string } };
    };
    expect(body.pageSaw.routedHostValues).toBeNull();
    expect(body.pageSaw.outcome).toEqual({ ok: false, reason: "missing_host" });
  });

  it("hostile Host and X-Forwarded-Host alone resolve nothing for a page", async () => {
    const inbound = new Headers();
    inbound.set(ROUTED_HOST_HEADER, "127.0.0.1:1"); // an invalid routed host, not a tenant
    const response = await fetch(`${origin}/edge`, { headers: inbound });
    const body = (await response.json()) as {
      pageSaw: { routedHostValues: string | null; outcome: { ok: boolean; reason?: string } };
    };
    // Whatever the client claimed, the page sees the socket's host — and loopback is no tenant.
    expect(body.pageSaw.routedHostValues).toBe(new URL(`${origin}/edge`).host);
    expect(body.pageSaw.outcome.ok).toBe(false);
    if (!body.pageSaw.outcome.ok) {
      // `127.0.0.1:<ephemeral port>` carries a port, and `requestHost` refuses an explicit port
      // before the IP-literal rule can apply (host.ts:114) — the fail-closed path, not a repair.
      expect(body.pageSaw.outcome.reason).toBe("missing_host");
    }
  });
});

// Guard against a future edit that quietly gives the harness a real tenant host and so stops
// proving what it claims to prove.
it("the harness never resolves a tenant context from loopback", async () => {
  const resolution = await resolveTenantContext({
    request: { url: `${origin}/page` },
    userId: null,
    store,
  });
  expect(resolution.ok).toBe(false);
});
