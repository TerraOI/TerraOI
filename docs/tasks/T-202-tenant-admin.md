# T-202 Tenant admin: invites, roles, projects and collections

Lane: 1 · Week: 2 · Protected: yes (`src/platform/tenancy/`) · Depends on: T-003, T-101, T-102, T-111 · Status: ready
Plan refs: §4.2, §5.2 (permission areas), §6.1–§6.2, §15.0 (Thin: tenant admin pages); F02, F05, F08

## Supervisor rulings to apply (2026-11-09)
These supersede anything below that disagrees.
- **Collection writes** ([#41](https://github.com/TerraOI/TerraOI/issues/41)): the collection page calls [T-111b](./T-111b-collection-admin-rpc.md)'s `create_collection_v1`/`update_collection_v1`; a class raise calls T-213's `review_reclass_v1` ([#21](https://github.com/TerraOI/TerraOI/issues/21)). This packet writes no knowledge table.
- **Seed** ([#39](https://github.com/TerraOI/TerraOI/issues/39)): one `contributor` role with `knowledge.write`, its permission row and one membership grant, plus the matching fixture in `040_knowledge_uploads.test.sql`.
- **Brand fallback banner** ([#62](https://github.com/TerraOI/TerraOI/issues/62)): admins see a banner when the tenant brand fell back (`brand.fallback` log event).
- **`policy_revision` writer** ([#98](https://github.com/TerraOI/TerraOI/issues/98)): ship `public.bump_policy_revision()` (after-statement trigger, `security definer`, pinned `search_path`, EXECUTE revoked from request roles) and attach it to `organisation_memberships`, `roles`, `role_permissions`, group membership and `organisations` status changes; replace the table comment at `tenancy_core.sql:34` ("a monotonic stamp … recorded for audit and used as a cache key; access is always re-derived"); pgTAP in `013` asserts each write moves it and a no-op does not.
- **Tenant scope** ([#163](https://github.com/TerraOI/TerraOI/issues/163), FAQ-0011): every scoped RPC this packet calls goes through `withTenantRpc` (T-101c), which injects `p_organisation_id` from `TenantContext`. No page or component passes an organisation id.

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
`is_project_member(uuid)` from the merged tenancy migration
`supabase/migrations/20261105060000_tenancy_core.sql` (lands with T-003).
[`DataClass`](../../src/contracts/data-class.ts) carries the M1 rule that `client_confidential`
collections are project-scoped (§6.2 of
[the plan](../../docs/plan/TerraOI-plan-v1.3.md)). Collection and source **rows** belong to
[T-111](./T-111-knowledge-schema.md): the owning lane provides the scoped RPC
(`create_collection_v1`) and this page only calls it — never writes a knowledge table (#13(1),
[FAQ-0004](../../docs/FAQ.md)).

## Acceptance tests (write first)
- [ ] positive: `supabase/tests/database/013_tenant_admin.test.sql` — an admin invites an address, the
      membership appears as `invited`, and it becomes `active` only once the invite is claimed
- [ ] negative: same file — a company1 admin cannot read, invite into or modify company2 rows, and a
      `project_id` from company2 is refused by the composite FK (`23503`), never silently ignored
- [ ] negative: same file — a member without the matching `*.admin` level is refused by the RPC, a
      suspended membership's admin call fails, and demotion or removal bites on the next request
- [ ] negative: `src/platform/tenancy/collection-admin.test.ts` — `create_collection_v1` (T-111's RPC)
      refuses a `client_confidential` collection with no project; a class may be raised by an authorized
      reviewer and is **never** lowered here, and relabeling never widens an existing source's audience
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
