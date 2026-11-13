# T-101c `withTenantRpc`: one call, one transaction, the tenant from `TenantContext` (F03)

Lane: 1 · Week: 2 · Protected: yes (`src/platform/tenancy/`) · Depends on: T-101 (merged), T-102 (the user's access token) · Status: in progress (wyuinline) — **code complete; staging evidence owed**: the helper and its loopback harness are open as [PR #167](https://github.com/TerraOI/TerraOI/pull/167), and the staging read below waits on T-102's sign-in, which is the T-004 §20.8 human step
Plan refs: §4.1, §4.3 (lines 245-249), §11 F03; ADR-0003 §7; FAQ-0011; decided in [#163](https://github.com/TerraOI/TerraOI/issues/163)

## Goal
Every tenant-scoped RPC is called through one helper. It takes the organisation from the request's
`TenantContext` and nowhere else, and it calls PostgREST with the **user's own access token**, so
`auth.uid()`, RLS and the membership check inside `set_tenant_scope` behave exactly as the merged SQL
assumes. The scope lives only inside that one call (FAQ-0011).

## Owns (may edit)
- `src/platform/tenancy/tenant-rpc.ts` and `src/platform/tenancy/tenant-rpc.test.ts`, plus a loopback
  test next to it (COORDINATION.md §6a)
- this packet's `Status:` line

## Must not edit
`supabase/` (the RPCs change in their own packets, per FAQ-0011), `src/contracts/`, Lane 2's
callers (`src/platform/knowledge/`, `src/platform/retrieval/`), which switch to this helper in their own PRs

## Contract
- `withTenantRpc(ctx: TenantContext, name, args, token)` sends `POST /rpc/<name>` with
  `p_organisation_id: ctx.organisationId` added. Its type rejects an `args` object that carries
  `p_organisation_id` (a compile error, not a runtime override), so a caller cannot choose the tenant.
- The credential is the signed-in user's access token (ADR-0003 §7). The module never imports or reads
  a service-role or secret key.
- SQLSTATE `28000` or `42501` from the RPC → a typed `tenancy` refusal, never an empty result. Any other
  failure → `backend_failure`. No provider or database text reaches the caller.
- One call is one transaction. The helper never sends `set_tenant_scope` as a separate request and never
  keeps a per-process or per-connection scope.

## Acceptance tests (write first)
- [ ] positive: the request body carries `p_organisation_id` equal to `ctx.organisationId`, and the other
      arguments unchanged
- [ ] negative: an `args` with `p_organisation_id` does not type-check (a `// @ts-expect-error` test)
- [ ] negative (loopback): the `Authorization` header that crosses the socket is the user's token, and
      no service-role-shaped value appears in any header or body
- [ ] negative: `28000` and `42501` map to `tenancy`, never to an empty or `no_accessible_evidence` result
- [ ] concurrency (F03): two contexts for two tenants, interleaved, each request carries its own
      organisation, and nothing is shared between them
- [ ] failure: a network error or 5xx becomes `backend_failure`, with no response text leaked

## Done evidence
`pnpm verify`; the loopback test output. Staging: one scoped read on `company1-staging.terraoi.app`
after T-102's sign-in, showing the organisation in the request body (no tokens in the evidence).

## Out of scope
The SQL side of the rule (each RPC's own packet, FAQ-0011); Lane 2's callers switching to the helper;
tenant-local time zones (#67).
