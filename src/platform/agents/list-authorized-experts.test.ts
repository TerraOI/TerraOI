import { describe, expect, it } from "vitest";

import { createTenantContext } from "@/contracts/tenant-context";

import { SAFE_TENANT_RPC_MESSAGE, type FetchImpl } from "@/platform/tenancy/tenant-rpc";

import {
  listAuthorizedExperts,
  toRouteCandidates,
  type ListedAuthorizedExpert,
} from "./list-authorized-experts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN =
  "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIwMDAwMDAwMC0wMDAwLTQwMDAtODAwMC0wMDAwMDAwMDAwMDEiLCJleHAiOjE4MDAwMDM2MDB9.c2ln";

const CTX = createTenantContext({
  organisationId: ORG,
  host: "company1.terraoi.test",
  userId: "00000000-0000-4000-8000-0000000000a1",
  membershipId: "55555555-5555-4555-8555-555555555555",
  membershipStatus: "active",
  roles: ["member"],
  permittedServiceKeys: ["uav-compliance"],
  permittedProjectIds: [],
  policyRevision: 1,
  resolvedAt: "2026-11-11T00:00:00.000Z",
});

function transport(answer: () => Response) {
  const sent: { url: string; body: string }[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    sent.push({
      url: input,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return answer();
  };
  return { sent, fetchImpl };
}

describe("toRouteCandidates", () => {
  it("maps registered and published rows to route candidates and drops withdrawn", () => {
    const rows: ListedAuthorizedExpert[] = [
      {
        expertKey: "uav-expert",
        expertVersion: "1.0.0",
        serviceKey: "uav-compliance",
        status: "registered",
      },
      {
        expertKey: "gpr-expert",
        expertVersion: "1.0.0",
        serviceKey: "gpr",
        status: "published",
      },
      {
        expertKey: "old-expert",
        expertVersion: "0.9.0",
        serviceKey: "gpr",
        status: "withdrawn",
      },
    ];
    expect(toRouteCandidates(rows)).toEqual([
      { expertKey: "uav-expert", serviceKey: "uav-compliance" },
      { expertKey: "gpr-expert", serviceKey: "gpr" },
    ]);
  });
});

describe("listAuthorizedExperts", () => {
  it("parses PostgREST snake_case rows into routing-safe fields only", async () => {
    const { sent, fetchImpl } = transport(
      () =>
        new Response(
          JSON.stringify([
            {
              expert_key: "uav-expert",
              expert_version: "1.0.0",
              service_key: "uav-compliance",
              status: "registered",
              // Extra columns must never be promoted into the typed result (#143 B8 / #221 N1).
              model_chains: { verify: ["claude"] },
              collection_bindings: ["51000000-0000-4000-8000-000000000001"],
            },
            {
              expert_key: "gpr-expert",
              expert_version: "1.0.0",
              service_key: "gpr",
              status: "published",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const outcome = await listAuthorizedExperts(CTX, TOKEN, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.experts).toEqual([
      {
        expertKey: "uav-expert",
        expertVersion: "1.0.0",
        serviceKey: "uav-compliance",
        status: "registered",
      },
      {
        expertKey: "gpr-expert",
        expertVersion: "1.0.0",
        serviceKey: "gpr",
        status: "published",
      },
    ]);
    for (const row of outcome.experts) {
      expect(Object.keys(row).sort()).toEqual([
        "expertKey",
        "expertVersion",
        "serviceKey",
        "status",
      ]);
      expect(row).not.toHaveProperty("modelChains");
      expect(row).not.toHaveProperty("collectionBindings");
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toMatch(/\/rpc\/list_authorized_experts_v1$/);
  });

  it("returns an empty experts array when the RPC returns []", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await listAuthorizedExperts(CTX, TOKEN, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome).toEqual({ ok: true, experts: [] });
  });

  it("maps tenant rpc failure to a safe employee message", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify({ code: "42501", message: "permission denied" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await listAuthorizedExperts(CTX, TOKEN, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("tenancy");
    expect(outcome.employeeMessage).toBe(SAFE_TENANT_RPC_MESSAGE.tenancy);
  });

  it("forwards only TenantContext organisation id and never forges another tenant", async () => {
    const { sent, fetchImpl } = transport(
      () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    await listAuthorizedExperts(CTX, TOKEN, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]?.body ?? "{}") as Record<string, unknown>;
    expect(body.p_organisation_id).toBe(ORG);
    expect(body.p_organisation_id).not.toBe(OTHER_ORG);
    expect(Object.keys(body)).toEqual(["p_organisation_id"]);
  });

  it("treats a non-array RPC payload as backend_failure", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(JSON.stringify({ expert_key: "uav-expert" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const outcome = await listAuthorizedExperts(CTX, TOKEN, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("backend_failure");
    expect(outcome.employeeMessage).toBe(SAFE_TENANT_RPC_MESSAGE.backend_failure);
  });

  it("fails closed when a row is missing a required routing field", async () => {
    const { fetchImpl } = transport(
      () =>
        new Response(
          JSON.stringify([
            {
              expert_key: "uav-expert",
              expert_version: "1.0.0",
              service_key: "uav-compliance",
              // status missing
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const outcome = await listAuthorizedExperts(CTX, TOKEN, {
      postgrestBaseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("backend_failure");
  });
});
