import { z } from "zod";

import type { HostRecord, MembershipRecord } from "@/platform/tenancy/resolve-tenant-context";
import { TENANT_ARGUMENT } from "@/platform/tenancy/tenant-rpc";

/**
 * Tenancy reads for the sign-in path (#37(b)): anon for host resolution, the **user's own access
 * token** for membership and policy revision. Every one of them is an RPC call — no direct table
 * endpoint anywhere — because AGENTS.md §4.2 and plan §4.3 put tenant access behind scoped RPCs, and
 * a PostgREST table select is not one (#171 review B2).
 *
 * Why these two reads are not `withTenantRpc` calls: that helper takes a `TenantContext`, and the
 * context is the *output* of this path — it needs `membershipId`, `membershipStatus: "active"` and
 * `policyRevision` before one can be built (`src/contracts/tenant-context.ts:13-31`). So the
 * bootstrap calls the same two functions the merged SQL now names, as the same role, and
 * `withTenantRpc` takes over downstream of the context (T-101c, FAQ-0011). The scope rule itself is
 * enforced where it belongs: inside `current_policy_revision_v1`, which opens with
 * `set_tenant_scope`. The membership read sets no scope by design, and that carve-out is recorded in
 * ADR-0003 §3b — `set_tenant_scope` raises 28000 for anyone who is not an active member, and the
 * invited claim in F05 has to see its own `invited` row before it can become one.
 *
 * Neither read carries a user id. The database takes it from `auth.uid()`, so this module cannot be
 * asked for someone else's membership — the direct table read it replaces did take a `user_id`
 * filter from the caller.
 *
 * No privileged key appears here: the anon/publishable key is the same one `identity/adapters.ts`
 * uses against Auth REST, and it is only ever a header, never the bearer.
 */

export type TenancyFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export type TenancyDataApiOptions = {
  supabaseUrl: string;
  anonKey: string;
  fetchImpl?: TenancyFetch;
};

export type TenancyDataApi = {
  findHost(host: string): Promise<HostRecord | null>;
  /** The caller's own membership in `organisationId`, or null when they hold none there. */
  findMembership(organisationId: string, accessToken: string): Promise<MembershipRecord | null>;
  policyRevision(organisationId: string, accessToken: string): Promise<number>;
};

export type TenancyReadFailureKind = "tenancy" | "backend_failure" | "not_configured";

/**
 * Employee-safe copy, in the shape of `SAFE_TENANT_RPC_MESSAGE` and `SAFE_FAILURE_MESSAGE`: no
 * table, schema, SQLSTATE, host or provider. A missing binding is deliberately the same sentence as
 * an outage, and the kinds stay separate for whoever reads the log.
 */
const SAFE_MESSAGE: Record<TenancyReadFailureKind, string> = {
  tenancy: "You do not have access to this workspace.",
  backend_failure: "The service is temporarily unavailable. Please try again.",
  not_configured: "The service is temporarily unavailable. Please try again.",
};

export class TenancyReadError extends Error {
  readonly kind: TenancyReadFailureKind;
  constructor(kind: TenancyReadFailureKind) {
    super(SAFE_MESSAGE[kind]);
    this.name = "TenancyReadError";
    this.kind = kind;
  }
}

export function isTenancyReadError(error: unknown): error is TenancyReadError {
  return error instanceof TenancyReadError;
}

/** "not allowed" and "no rows" stay different answers (tenant-rpc.ts:40-41, FAQ-0011). */
const TENANCY_SQLSTATES: readonly string[] = ["28000", "42501"];

const HostRow = z.object({
  organisation_id: z.uuid(),
  organisation_status: z.enum(["provisioning", "active", "suspended", "archived", "deleting"]),
});

const MembershipRow = z.object({
  membership_id: z.uuid(),
  organisation_id: z.uuid(),
  status: z.enum(["invited", "active", "suspended", "removed"]),
});

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function refusalSqlstate(text: string): string | undefined {
  const code = (parseJson(text) as { code?: unknown } | undefined)?.code;
  if (typeof code !== "string") return undefined;
  for (const state of TENANCY_SQLSTATES) if (code === state) return state;
  return undefined;
}

function firstRow(payload: unknown): unknown | undefined {
  return Array.isArray(payload) && payload.length > 0 ? payload[0] : undefined;
}

export function createTenancyDataApi(options: TenancyDataApiOptions): TenancyDataApi {
  const base = options.supabaseUrl.replace(/\/+$/, "");
  const fetchImpl: TenancyFetch = options.fetchImpl ?? ((fetch as unknown) as TenancyFetch);

  /** One POST to one named RPC. The tenant argument is assembled here and nowhere else. */
  async function dialRpc(
    name: string,
    args: Record<string, unknown>,
    bearer: string,
  ): Promise<string> {
    if (base.length === 0) throw new TenancyReadError("not_configured");
    if (bearer.trim().length === 0) throw new TenancyReadError("not_configured");

    let response: Awaited<ReturnType<TenancyFetch>>;
    let text: string;
    try {
      response = await fetchImpl(`${base}/rpc/${name}`, {
        method: "POST",
        headers: {
          apikey: options.anonKey,
          authorization: `Bearer ${bearer}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        // The body is exactly what the call site assembled; every identity call site builds it with
        // TENANT_ARGUMENT, the SQL function's own parameter name (FAQ-0011 rule 1).
        body: JSON.stringify(args),
      });
      text = await response.text();
    } catch {
      // A transport fact, never a fact about the database, and never its text.
      throw new TenancyReadError("backend_failure");
    }

    if (!response.ok) {
      throw new TenancyReadError(refusalSqlstate(text) !== undefined ? "tenancy" : "backend_failure");
    }
    return text;
  }

  return {
    async findHost(host: string): Promise<HostRecord | null> {
      const text = await dialRpc("resolve_tenant_host", { p_host: host }, options.anonKey);
      if (text.trim().length === 0) return null;
      const payload = parseJson(text);
      if (payload === undefined) throw new TenancyReadError("backend_failure");
      const parsed = HostRow.safeParse(firstRow(payload));
      // An unknown, reserved or inactive host answers with no row: the caller renders a generic
      // failure with no tenant detail (plan §4.1 step 3).
      if (!parsed.success) return null;
      return {
        organisationId: parsed.data.organisation_id,
        organisationStatus: parsed.data.organisation_status,
      };
    },

    async findMembership(organisationId: string, accessToken: string): Promise<MembershipRecord | null> {
      const text = await dialRpc("current_membership_v1", { [TENANT_ARGUMENT]: organisationId }, accessToken);
      if (text.trim().length === 0) return null;
      const payload = parseJson(text);
      if (payload === undefined) throw new TenancyReadError("backend_failure");

      const row = firstRow(payload);
      if (row === undefined) return null;
      const parsed = MembershipRow.safeParse(row);
      // A row this module cannot read is not a missing membership: guessing here would sign someone
      // in, or turn them away, on a shape assumption.
      if (!parsed.success) throw new TenancyReadError("backend_failure");

      return {
        membershipId: parsed.data.membership_id,
        status: parsed.data.status,
        // Fail-closed and deliberate: the role and project reads belong to T-101c's scoped-RPC path
        // and T-202, not to the sign-in bootstrap. Empty means "no roles granted yet", never
        // "everything".
        roles: [],
        permittedServiceKeys: [],
        permittedProjectIds: [],
      };
    },

    async policyRevision(organisationId: string, accessToken: string): Promise<number> {
      const text = await dialRpc("current_policy_revision_v1", { [TENANT_ARGUMENT]: organisationId }, accessToken);
      const value = parseJson(text.trim().length === 0 ? "null" : text);
      const parsed = z.number().int().positive().safeParse(value);
      // A scalar RPC answers with the bare value. Anything else — including an empty body — is
      // refused: `0` would be a plausible-looking revision, and a stale revision silently authorizes.
      if (!parsed.success) throw new TenancyReadError("backend_failure");
      return parsed.data;
    },
  };
}
