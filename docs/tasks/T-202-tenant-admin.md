# T-202 Tenant admin: invites, roles, projects and collections

Lane: 1 · Week: 2 · Protected: yes (`src/platform/tenancy/`) · Depends on: T-003, T-101, T-102, T-111 · Status: ready
Plan refs: §4.2, §5.2 (permission areas), §6.1–§6.2, §15.0 (Thin: tenant admin pages); F02, F05, F08

## Goal
A tenant admin invites people, grants roles, creates projects and creates collections **with a data
class** from thin pages inside the tenant shell. Every write goes through a security-invoker RPC
under RLS, so the admin surface cannot touch another tenant's rows, cannot reference another
tenant's ids, and cannot lower a data class or widen an audience.

## Owns (may edit)
- `src/platform/tenancy/` (membership, role, project and invite admin calls), `src/app/(tenant)/admin/`
- `src/components/admin/`, `src/components/knowledge/` (collection list and create UI only)
- `src/platform/tenancy/*.test.ts`, `supabase/tests/database/013_tenant_admin.test.sql`
- one migration `supabase/migrations/YYYYMMDDHHMMSS_tenant_admin_rpc.sql` holding these scoped RPCs
  — timestamp agreed in the daily sync, migrations are protected, and the merged tenancy migration
  is never edited

## Must not edit
`src/contracts/`, merged migrations, `src/platform/knowledge/` (Lane 2),
`src/platform/identity/` (T-101/T-201 own sign-in), `brand/`

## Contract
Tables `organisations`, `organisation_memberships`, `organisation_roles`, `role_permissions`
(`area` like `knowledge.read`, `level` `none | read | write | admin`), `membership_roles`,
`projects`, `project_memberships`, plus `set_tenant_scope(uuid)`, `is_active_member(uuid)` and
`is_project_member(uuid)` from
[the tenancy migration](../../supabase/migrations/20261105060000_tenancy_core.sql).
[`DataClass`](../../src/contracts/data-class.ts) carries the M1 rule that `client_confidential`
collections are project-scoped (§6.2 of
[the plan](../../docs/plan/TerraOI-plan-v1.3.md)). Collection and source **rows** belong to
[T-111](./T-111-knowledge-schema.md): if a scoped collection-admin RPC does not exist, request it
through [COORDINATION.md §2](../../docs/COORDINATION.md) instead of writing knowledge SQL here.

## Acceptance tests (write first)
- [ ] positive: `supabase/tests/database/013_tenant_admin.test.sql` — an admin invites an address, the
      membership appears as `invited`, and it becomes `active` only once the invite is claimed
- [ ] negative: same file — a company1 admin cannot read, invite into or modify company2 rows, and a
      `project_id` from company2 is refused by the composite FK (`23503`), never silently ignored
- [ ] negative: same file — a member without the matching `*.admin` level is refused by the RPC, a
      suspended membership's admin call fails, and demotion or removal bites on the next request
- [ ] negative: `src/platform/tenancy/collection-admin.test.ts` — a `client_confidential` collection
      without a project is refused; a data class may be raised by an authorized reviewer and is
      **never** lowered here; relabeling never widens an existing source's audience
- [ ] failure: duplicate invite is idempotent (exactly one membership row); a malformed email or role
      key is a validation error with no partial write; a failed role grant leaves permissions unchanged

## Done evidence
`pnpm verify`; `pnpm db:test` for the new RPCs; staging: invite an address on
`company1-staging.terraoi.app`, accept it, see it in the project picker, then show the same admin page
on the company2 host cannot see or edit any company1 row.

## Out of scope
Control-plane UI at `admin.terraoi.app`, provisioning UI, groups, access reviews, connector
credentials (plan §15.0 "Deferred after M1"); invite **sign-in** mechanics are T-201; the review
queue is T-213.
