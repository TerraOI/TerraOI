# T-111b Collection admin RPC (`create_collection_v1`, `update_collection_v1`)

Lane: 2 · Week: 2 · Protected: yes (`supabase/migrations/`) · Depends on: T-111 · Status: ready
Plan refs: §6.1, §6.2; FAQ-0004; decided in [#41](https://github.com/TerraOI/TerraOI/issues/41)

## Goal
Tenant admins create collections and rename them through one scoped write path, so T-202's collection
page never writes a knowledge table (FAQ-0004). The RPC enforces the tenant, project and data-class
rules in one place. It never changes a collection's class: raising a class is T-213's
`review_reclass_v1` ([#21](https://github.com/TerraOI/TerraOI/issues/21)), the one place that cascades.

## Owns (may edit)
- one migration `supabase/migrations/YYYYMMDDHHMMSS_collection_admin.sql`
- `supabase/tests/database/025_collection_admin.test.sql` (slot claimed in [COORDINATION.md §6b](../COORDINATION.md))
- the regenerated `src/contracts/database.types.ts` (CI artifact, FAQ-0009)

## Must not edit
Merged migrations; `src/app/` and `src/components/` (the page is [T-202](./T-202-tenant-admin.md));
`src/contracts/` beyond the generated types.

## Contract
- `create_collection_v1(p_key, p_name, p_service, p_project_id, p_data_class)` and
  `update_collection_v1(p_collection_id, p_name, p_description)`: security invoker, `set_tenant_scope`,
  caller holds `knowledge.admin` at `admin`.
- `update_collection_v1` changes **name and description only**; it cannot touch `data_class`,
  `project_id` or `organisation_id`.
- One safe error code per refusal.

## Acceptance tests (write first)
- [ ] positive: an admin creates a collection; the key is unique per tenant
- [ ] negative: a member and a `contributor` ([#39](https://github.com/TerraOI/TerraOI/issues/39)) are refused
- [ ] negative: another tenant's project is refused (composite FK)
- [ ] negative: a tenant-wide `client_confidential` collection is refused (merged CHECK,
      `20261105070000_knowledge_core.sql:104-106`); `restricted` is refused (`isIngestibleInM1`)
- [ ] negative: `update_collection_v1` cannot change the class, the project or the tenant
- [ ] privileges ([#60](https://github.com/TerraOI/TerraOI/issues/60)): `EXECUTE` revoked from `public`,
      `anon` and `authenticated` by name, then granted to `authenticated` only, with
      `has_function_privilege` assertions

## Done evidence
`pnpm verify`; the CI `database` job green with `025_collection_admin.test.sql` passing.

## Out of scope
Class changes (T-213); the admin page (T-202); collection deletion.
