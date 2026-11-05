# T-003 Migration 0001: tenancy core with RLS

Lane: 2 (shared path) · Week: 0 · Protected: yes · Depends on: T-000, T-002 · Status: in progress (wyuinline)
Plan refs: §4.3, §6.1 (tenant lifecycle, identity/access), §6.2; F03

## Goal
Tables `organisations`, `tenant_domains`, `profiles`, `organisation_memberships`, `roles`/`role_permissions`, `projects`, `project_memberships`, with composite tenant FKs, RLS, and the transaction-scoped tenant RPC pattern (F03) that every later table reuses.

## Owns
`supabase/migrations/<timestamp>_tenancy_core.sql`, `supabase/tests/database/010_tenancy*.test.sql`, `supabase/seed.sql` (synthetic company1 + company2), generated `src/contracts/database.types.ts`

## Acceptance tests (write first, pgTAP)
- [x] guardrails (000) still pass: RLS on every table, pinned search_path
- [x] member of company1 reads company1 rows only; company2 rows invisible, even with a forged org id argument
- [x] a member of **two** tenants, scoped to one, reads no domains, roles, permissions or role assignments of the other; with no scope those four tables read empty (#17 B1)
- [x] deactivated membership sees nothing; project rows visible only to project members
- [x] tenant scope set in one RPC call does not leak to the next call (no session-level state)
- [x] `tenant_domains.host` unique and normalized (lowercase, no port)

## Done evidence
`pnpm db:reset && pnpm db:test` output; generated types committed; CI `database` job green.
