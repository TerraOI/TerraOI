import { describe, expect, it, vi } from "vitest";

import {
  createTenantContext,
  type TenantContext,
} from "@/contracts/tenant-context";

import type {
  ExactHit,
  ExactLookupClient,
  ExactLookupResult,
} from "./exact-lookup";
import { planCorpusQuery } from "./query-plan";
import type { SearchCorpusClient, SearchCorpusResult } from "./search-corpus";

const ORG = "0f9fd6dd-0f0a-4b02-9b45-2fda5e6d1e01";
const USER = "6f0a1e6a-8f4a-4b57-9e30-1d6b9a0e4a11";
const PROJECT = "3d3f1a5d-4a5d-4e33-9b0e-7c2f1a5d8e02";

function context(overrides: Partial<TenantContext> = {}): TenantContext {
  return createTenantContext({
    organisationId: ORG,
    host: "company1.terraoi.app",
    userId: USER,
    membershipId: "b1d1e0a6-1a5c-4d7e-9c47-2c1e6a5b0f22",
    membershipStatus: "active",
    roles: ["member"],
    permittedServiceKeys: ["uav", "gpr"],
    permittedProjectIds: [PROJECT],
    policyRevision: 4,
    resolvedAt: "2026-11-10T09:00:00.000Z",
    ...overrides,
  });
}

const HIT: ExactHit = {
  organisationId: ORG,
  collectionId: "2c2f1a5d-4a5d-4e33-9b0e-7c2f1a5d8e01",
  projectId: PROJECT,
  sourceId: "4e4f1a5d-4a5d-4e33-9b0e-7c2f1a5d8e03",
  sourceVersionId: "5f5f1a5d-4a5d-4e33-9b0e-7c2f1a5d8e04",
  chunkId: "6a6a1a5d-4a5d-4e33-9b0e-7c2f1a5d8e05",
  chunkIndex: 0,
  bodyText: "Provision 4.2.1: keep the rotor clear of personnel.",
  locator: { page: 12 },
  dataClass: "internal",
  contentHash: "abc",
  publishedAt: "2026-11-01T00:00:00.000Z",
  serviceKey: "uav",
  matchKind: "body_phrase",
  rank: 1,
};

function exactClient(
  impl: (identifier: string) => Promise<ExactLookupResult>,
): ExactLookupClient {
  return {
    lookup: async (call) => impl(call.identifier),
  };
}

function hybridClient(
  search: SearchCorpusClient["search"],
): SearchCorpusClient {
  return { search };
}

const HYBRID_OK: SearchCorpusResult = {
  ok: true,
  status: "ok",
  evidence: [],
  dataClass: "public",
  retrievalMode: "hybrid",
  caveats: [],
  diagnostics: {
    schemaVersion: 1,
    resultStatus: "ok",
    retrievalMode: "hybrid",
    coverage: {
      collectionsVisible: 1,
      sourceVersionsVisible: 1,
      chunksVisible: 1,
      chunksWithVectors: 1,
    },
    filters: {
      collectionsNarrowed: false,
      projectApplied: false,
      authorityFiltersApplied: false,
    },
    limits: { limit: 12, returned: 0, truncated: false },
    signals: {
      coverageUnknown: false,
      historicalGap: false,
      indexUnavailable: false,
      maxDataClass: null,
    },
  },
};

describe("planCorpusQuery (T-216 PR-2: exact before hybrid)", () => {
  it("returns exact hits and never calls hybrid", async () => {
    const hybridSearch = vi.fn(async () => HYBRID_OK);
    const result = await planCorpusQuery(
      {
        context: context(),
        accessToken: "synth-token",
        originalQuery: "4.2.1",
      },
      {
        exact: exactClient(async () => ({
          ok: true,
          hits: [HIT],
          dataClass: "internal",
        })),
        hybrid: hybridClient(hybridSearch),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.lane !== "exact")
      throw new Error("expected exact lane");
    expect(result.hits).toHaveLength(1);
    expect(result.evidence[0]?.exactMatch).toBe(true);
    expect(result.originalQuery).toBe("4.2.1");
    expect(result.searchedQuery).toBe("4.2.1");
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it("falls through to hybrid when exact finds nothing and records both query strings", async () => {
    const seenQueries: string[] = [];
    const hybridSearch = vi.fn(async (call: { queryText: string }) => {
      seenQueries.push(call.queryText);
      return HYBRID_OK;
    });
    const result = await planCorpusQuery(
      {
        context: context(),
        accessToken: "synth-token",
        originalQuery: "and the 120 m one?",
        searchedQuery: "site clearance for the 120 m tower",
      },
      {
        exact: exactClient(async () => ({
          ok: true,
          hits: [],
          dataClass: null,
        })),
        hybrid: hybridClient(hybridSearch),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.lane !== "hybrid")
      throw new Error("expected hybrid lane");
    expect(result.exactSkipped).toBe(false);
    expect(result.originalQuery).toBe("and the 120 m one?");
    expect(result.searchedQuery).toBe("site clearance for the 120 m tower");
    expect(hybridSearch).toHaveBeenCalledOnce();
    expect(seenQueries).toEqual(["site clearance for the 120 m tower"]);
  });

  it("stops on a tenancy refusal instead of masking it as an empty hybrid result", async () => {
    const hybridSearch = vi.fn(async () => HYBRID_OK);
    const result = await planCorpusQuery(
      {
        context: context({
          organisationId: "11111111-1111-4111-8111-111111111111",
        }),
        accessToken: "synth-token",
        originalQuery: "SYNTH-UAV-MAN-A17",
      },
      {
        exact: exactClient(async () => ({
          ok: false,
          status: "backend_failure",
          refusal: {
            origin: "database",
            reason: "tenancy",
            sqlState: "28000",
            detail: "tenant scope refused this caller (28000)",
            reachedDatabase: true,
          },
        })),
        hybrid: hybridClient(hybridSearch),
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected refusal");
    expect(result.exact.ok).toBe(false);
    expect(hybridSearch).not.toHaveBeenCalled();
  });

  it("falls through to hybrid when exact transport fails, recording exactSkipped", async () => {
    const hybridSearch = vi.fn(async () => HYBRID_OK);
    const result = await planCorpusQuery(
      {
        context: context(),
        accessToken: "synth-token",
        originalQuery: "rotor clearance",
      },
      {
        exact: exactClient(async () => ({
          ok: false,
          status: "backend_failure",
          refusal: {
            origin: "transport",
            reason: "transport",
            sqlState: null,
            detail: "the Data API request did not complete",
            reachedDatabase: true,
          },
        })),
        hybrid: hybridClient(hybridSearch),
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.lane !== "hybrid")
      throw new Error("expected hybrid lane");
    expect(result.exactSkipped).toBe(true);
    expect(result.exactSkipReason).toBe("transport");
    expect(hybridSearch).toHaveBeenCalledOnce();
  });

  it("skips exact lookup for a question longer than an identifier and still searches hybrid", async () => {
    const lookup = vi.fn(async () => ({
      ok: true as const,
      hits: [],
      dataClass: null,
    }));
    const hybridSearch = vi.fn(async () => HYBRID_OK);
    const longQuestion = `What does the manual say about ${"rotor clearance and ".repeat(15)}personnel?`;
    expect(longQuestion.length).toBeGreaterThan(200);
    const result = await planCorpusQuery(
      {
        context: context(),
        accessToken: "synth-token",
        originalQuery: longQuestion,
      },
      { exact: { lookup }, hybrid: hybridClient(hybridSearch) },
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(hybridSearch).toHaveBeenCalledOnce();
    if (!result.ok || result.lane !== "hybrid")
      throw new Error("expected hybrid lane");
    expect(result.exactSkipped).toBe(true);
    expect(result.exactSkipReason).toBe("identifier_too_long");
  });
});
