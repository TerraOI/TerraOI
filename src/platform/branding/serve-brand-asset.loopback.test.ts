import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BRAND_ASSET_CACHE_CONTROL,
  BRAND_ASSET_SVG_CSP,
  serveBrandAsset,
  type BrandAssetDeps,
} from "./serve-brand-asset";

/**
 * COORDINATION §6a harness for the brand-asset route: the claims here are about **bytes on a
 * socket** — the header set a browser actually receives, and the fact that every refusal is the same
 * bytes back — so a unit test that calls the handler with a `Request` object it built itself proves
 * less than it appears to.
 *
 * Plain Node `http` on `127.0.0.1` with `listen(0)`, closed in `afterAll`. No Docker, no fixed port,
 * no external network.
 *
 * What this leg can and cannot show, stated rather than glossed: the handler reads the tenant from
 * `request.url` (ADR-0006 rule 3), and inside this process the URL is composed from the authority on
 * the request line. Node's `http.request` — unlike `fetch` — lets the client put an explicit `Host`
 * on the wire, so the harness drives that authority directly and the assertions are about what the
 * handler decided from it and what came back over the socket. **Whether Cloudflare's edge lets a
 * mismatched `Host`/SNI reach the Worker at all is a staging question**, and it is the half of
 * ADR-0006's spike that is still owed; nothing in this file claims it.
 */

const SVG_BYTES = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><title>Company1</title></svg>');
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One host, one version, one name: the same key the SQL read uses. */
const store = new Map<string, { contentType: string; bytes: Uint8Array }>([
  ["company1.terraoi.app|1|logo.svg", { contentType: "image/svg+xml", bytes: SVG_BYTES }],
  ["company1.terraoi.app|1|logo.png", { contentType: "image/png", bytes: PNG_BYTES }],
  ["company2.terraoi.app|1|logo.svg", { contentType: "image/svg+xml", bytes: new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>") }],
]);

const consulted: string[] = [];

const deps: BrandAssetDeps = {
  async readAsset(input) {
    consulted.push(`${input.host}|${input.configVersion}|${input.name}`);
    return store.get(`${input.host}|${input.configVersion}|${input.name}`);
  },
};

function paramsFrom(url: string): { configVersion: unknown; name: unknown } {
  const segments = url.split("/").filter((segment) => segment.length > 0);
  // The route's two path parameters, taken from the request line as the framework would.
  return { configVersion: segments[1], name: segments[2] };
}

let server: Server | undefined;
let port = 0;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const authority = req.headers.host ?? "127.0.0.1";
      const response = await serveBrandAsset(
        new Request(`https://${authority}${req.url ?? "/"}`),
        paramsFrom(req.url ?? "/"),
        deps,
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => { server?.close(() => resolve()); });
});

interface Wire {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: Buffer;
}

function wire(path: string, hostHeader: string): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const client = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: { host: hostHeader } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
      },
    );
    client.on("error", reject);
    client.end();
  });
}

describe("the brand asset route over a real socket (FAQ-0008)", () => {
  it("serves the stored SVG bytes with the immutable header set", async () => {
    const response = await wire("/brand-assets/1/logo.svg", "company1.terraoi.app");
    expect(response.status).toBe(200);
    expect(response.body.equals(Buffer.from(SVG_BYTES))).toBe(true);
    expect(response.headers["content-type"]).toBe("image/svg+xml");
    expect(response.headers["cache-control"]).toBe(BRAND_ASSET_CACHE_CONTROL);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toBe(BRAND_ASSET_SVG_CSP);
  });

  it("serves the png under the same host without the SVG sandbox header", async () => {
    const response = await wire("/brand-assets/1/logo.png", "company1.terraoi.app");
    expect(response.status).toBe(200);
    expect(response.body.equals(Buffer.from(PNG_BYTES))).toBe(true);
    expect(response.headers["content-security-policy"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe(BRAND_ASSET_CACHE_CONTROL);
  });

  it("serves each authority its own asset, and refuses a name that host does not hold", async () => {
    const response = await wire("/brand-assets/1/logo.svg", "company2.terraoi.app");
    // company2 owns a logo.svg of its own; asking for company1's version segment on company2's host
    // is the cross-host case FAQ-0008 rules out, and the answer carries nothing.
    expect(response.status).toBe(200);
    expect(response.body.length).toBeGreaterThan(0);
    const foreign = await wire("/brand-assets/1/logo.png", "company2.terraoi.app");
    expect(foreign.status).toBe(404);
    expect(foreign.body.length).toBe(0);
    expect(foreign.headers["cache-control"]).toBeUndefined();
  });

  it("answers an unknown version, an unknown name and an unregistered host identically", async () => {
    const unknownVersion = await wire("/brand-assets/99/logo.svg", "company1.terraoi.app");
    const unknownName = await wire("/brand-assets/1/nope.svg", "company1.terraoi.app");
    const unknownHost = await wire("/brand-assets/1/logo.svg", "company9.terraoi.app");
    for (const response of [unknownVersion, unknownName, unknownHost]) {
      expect(response.status).toBe(404);
      expect(response.body.length).toBe(0);
      expect(response.headers["cache-control"]).toBeUndefined();
      expect(response.headers["content-type"]).toBeUndefined();
    }
    expect(unknownVersion.headers).toEqual(unknownName.headers);
  });

  it("refuses a loopback authority that is not a tenant host, before the store is consulted", async () => {
    consulted.length = 0;
    const response = await wire("/brand-assets/1/logo.svg", `127.0.0.1:${port}`);
    expect(response.status).toBe(404);
    expect(consulted).toEqual([]);
  });
});
