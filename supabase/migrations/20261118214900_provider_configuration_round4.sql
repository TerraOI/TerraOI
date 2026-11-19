-- T-116 round-4 follow-up (#143 B7/B8/B9/N6): #143 merged at 10a3499 with CHANGES_REQUESTED
-- still open, so the original migration is on main and must not be edited (AGENTS.md §6).
-- This migration applies the three blocking fixes and drops the unused fail-open read.

begin;

-- ── B7: one-revision guard must allow a multi-row bump and catch ceiling flips ──────────────
-- The BEFORE ROW trigger on clearance_revision saw peer rows still at the old revision and
-- blocked every `update … set clearance_revision = …` of more than one row. Replace it with a
-- deferred AFTER constraint trigger that checks the table as a whole, and a BEFORE UPDATE that
-- refuses max_cleared_class / enabled changes unless clearance_revision increases.
drop trigger if exists model_providers_one_revision on public.model_providers;

create or replace function public.model_providers_one_revision()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if (select count(distinct clearance_revision) from public.model_providers) > 1 then
    raise exception 'model_providers: clearance_revision must be one value across the table; found % distinct',
      (select count(distinct clearance_revision) from public.model_providers)
      using errcode = '23514';
  end if;
  return null;
end;
$fn$;

-- INITIALLY IMMEDIATE: checked at end of each statement (so a bad INSERT is refused inside
-- try_* helpers). Still DEFERRABLE so a test can SET CONSTRAINTS … DEFERRED, leave a mixed
-- state, then SET CONSTRAINTS … IMMEDIATE to prove the half-swap fails (#143 B7).
create constraint trigger model_providers_one_revision
  after insert or update on public.model_providers
  deferrable initially immediate
  for each row execute function public.model_providers_one_revision();

create or replace function public.model_providers_revision_on_matrix_change()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if (new.max_cleared_class is distinct from old.max_cleared_class
      or new.enabled is distinct from old.enabled)
     and new.clearance_revision <= old.clearance_revision then
    raise exception
      'model_providers: changing max_cleared_class or enabled requires clearance_revision to increase'
      using errcode = '23514';
  end if;
  return new;
end;
$fn$;

create trigger model_providers_revision_on_matrix_change
  before update of max_cleared_class, enabled, clearance_revision on public.model_providers
  for each row execute function public.model_providers_revision_on_matrix_change();

revoke all on function public.model_providers_one_revision() from public, anon, authenticated, service_role;
revoke all on function public.model_providers_revision_on_matrix_change() from public, anon, authenticated, service_role;

-- ── B8: tenant_provider_policy is not employee-readable (§9.3) ──────────────────────────────
-- Drop the member SELECT grant and the is_active_member policy. Keep RLS on with no policies
-- (same shape as model_providers / provider_routes / provider_health). Gateway reads over
-- CONFIG_DB (#134); admin read is a later FAQ-0011 RPC (T-202).
drop policy if exists tenant_provider_policy_member_read on public.tenant_provider_policy;
revoke all on table public.tenant_provider_policy from anon, authenticated;

-- ── N6: drop the unused fail-open tenant-policy read ────────────────────────────────────────
-- No grant, no caller, and the zero-argument shape B5 showed fails open when unscoped. PR-2
-- adds the read in the non-exposed schema (#134); T-202 may add a FAQ-0011 RPC later.
drop function if exists public.tenant_provider_policy_v1();

-- ── N8: the column is route_position (source comment on the original migration said position)
comment on column public.provider_routes.route_position is
  'Chain order index F38 walks, per task class (contract DEFAULT_TASK_CHAIN_ORDER).';

commit;
