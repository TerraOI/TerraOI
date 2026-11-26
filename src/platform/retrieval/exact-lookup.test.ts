import { describe, expect, it } from "vitest";

import { createTenantContext } from "@/contracts/tenant-context";
import type { FetchImpl } from "@/platform/tenancy/tenant-rpc";

import {
  createExactLookupClient,
  type ExactLookupCall,
  type ExactLookupResult,
} from "./exact-lookup";

// Supervisor round 1 on #258: the typed caller had no tests of its own. Synthetic ids and a fake
// transport that counts calls, so "refused locally" is observable (same pattern as search-corpus.test.ts).

const ORG = "0f9fd6dd-0f0a-4b02-9b45-2fda5e6d1e01";
const ID = (n: number) => `6a6a1a5d-4a5d-4e33-9b0e-7c2f1a5d8e0${n}`;
const POSTGREST_BASE = "https://synthetic.supabase.co/rest/v1";

function call(overrides: Partial<ExactLookupCall> = {}): ExactLookupCall {
  return {
    context: createTenantContext({
      organisationId: ORG,
      host: "company1.terraoi.app",
      userId: "6f0a1e6a-8f4a-4b57-9e30-1d6b9a0e4a11",
      membershipId: "b1d1e0a6-1a5c-4d7e-9c47-2c1e6a5b0f22",
      membershipStatus: "active",
      roles: ["member"],
      permittedServiceKeys: ["uav"],
      permittedProjectIds: [],
      policyRevision: 1,
      resolvedAt: "2026-11-10T09:00:00.000Z",
    }),
    accessToken: "synth.jwt.token",
    identifier: "SYNTH-4.2.1",
    serviceKeys: ["uav"],
    ...overrides,
  };
}

function transport(
  status: number,
  body: unknown,
): { fetchImpl: FetchImpl; bodies: string[] } {
  const bodies: string[] = [];
  const fetchImpl: FetchImpl = async (_input, init) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, bodies };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    o_organisation_id: ORG,
    o_collection_id: ID(1),
    o_project_id: null,
    o_source_id: ID(2),
    o_source_version_id: ID(3),
    o_chunk_id: ID(4),
    o_chunk_index: 0,
    o_body_text: "Provision SYNTH-4.2.1: keep the rotor clear.",
    o_locator: { page: 3 },
    o_data_class: "internal",
    o_content_hash: null,
    o_published_at: null,
    o_service_key: "uav",
    o_match_kind: "provision",
    o_rank: 1,
    ...overrides,
  };
}

function reasonOf(result: ExactLookupResult): string | undefined {
  return result.ok ? undefined : result.refusal.reason;
}

describe("exact_lookup_v1 client (T-216 PR-2)", () => {
  it("is unwired without a PostgREST base", async () => {
    expect(reasonOf(await createExactLookupClient({}).lookup(call()))).toBe(
      "unwired",
    );
  });

  it("refuses bad arguments before the socket opens", async () => {
    const { fetchImpl, bodies } = transport(200, []);
    const client = createExactLookupClient({
      postgrestBaseUrl: POSTGREST_BASE,
      fetchImpl,
    });
    const cases: [Partial<ExactLookupCall>, string][] = [
      [{ identifier: "   " }, "identifier_blank"],
      [{ identifier: "x".repeat(201) }, "identifier_too_long"],
      [{ limit: 0 }, "limit_out_of_range"],
      [{ limit: 26 }, "limit_out_of_range"],
      [{ serviceKeys: ["UAV!"] }, "argument_shape"],
      [{ collectionIds: ["not-a-uuid"] }, "argument_shape"],
      [{ projectId: "not-a-uuid" }, "argument_shape"],
    ];
    for (const [overrides, reason] of cases) {
      expect(reasonOf(await client.lookup(call(overrides)))).toBe(reason);
    }
    expect(bodies).toHaveLength(0);
  });

  it("sends the RPC arguments and maps rows, with the highest data class", async () => {
    const { fetchImpl, bodies } = transport(200, [
      row(),
      row({ o_chunk_id: ID(5), o_data_class: "client_confidential" }),
    ]);
    const result = await createExactLookupClient({
      postgrestBaseUrl: POSTGREST_BASE,
      fetchImpl,
    }).lookup(call());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.hits).toHaveLength(2);
    expect(result.hits[0]).toMatchObject({
      sourceVersionId: ID(3),
      matchKind: "provision",
      projectId: null,
    });
    expect(result.dataClass).toBe("client_confidential");
    const sent = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
    expect(sent).toMatchObject({
      p_organisation_id: ORG,
      p_identifier: "SYNTH-4.2.1",
      p_service_keys: ["uav"],
      p_collection_ids: null,
      p_project_id: null,
      p_limit: 12,
    });
  });

  it("returns an empty hit list with no data class for zero rows", async () => {
    const { fetchImpl } = transport(200, []);
    expect(
      await createExactLookupClient({
        postgrestBaseUrl: POSTGREST_BASE,
        fetchImpl,
      }).lookup(call()),
    ).toEqual({
      ok: true,
      hits: [],
      dataClass: null,
    });
  });

  it("refuses a row with an unknown class or match kind instead of passing it on", async () => {
    for (const bad of [
      { o_data_class: "secret" },
      { o_match_kind: "fuzzy" },
      { o_chunk_id: "x" },
    ]) {
      const { fetchImpl } = transport(200, [row(bad)]);
      const result = await createExactLookupClient({
        postgrestBaseUrl: POSTGREST_BASE,
        fetchImpl,
      }).lookup(call());
      expect(reasonOf(result)).toBe("response_shape");
    }
  });

  it("splits tenancy refusals by SQLSTATE", async () => {
    for (const [code, reason] of [
      ["28000", "tenancy"],
      ["42501", "scope_claim"],
    ] as const) {
      const { fetchImpl } = transport(400, {
        code,
        message: "synthetic",
        details: null,
        hint: null,
      });
      const result = await createExactLookupClient({
        postgrestBaseUrl: POSTGREST_BASE,
        fetchImpl,
      }).lookup(call());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.refusal).toMatchObject({
        reason,
        sqlState: code,
        origin: "database",
      });
    }
  });
});
