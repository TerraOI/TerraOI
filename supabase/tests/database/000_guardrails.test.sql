-- Platform guardrails that every migration must keep true (plan §6.2, §20.4).
-- Run with: pnpm db:test   (CI runs it on every PR)
begin;
create extension if not exists pgtap with schema extensions;
select plan(2);

-- 1. Every table in the public schema has row-level security enabled.
select is_empty(
  $$ select c.relname::text
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and not c.relrowsecurity $$,
  'every public table has RLS enabled'
);

-- 2. Privileged functions cannot be hijacked through search_path (plan §4.3):
--    every SECURITY DEFINER function in public sets an explicit search_path.
select is_empty(
  $$ select p.proname::text
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                         where cfg like 'search_path=%') $$,
  'every public SECURITY DEFINER function pins search_path'
);

select * from finish();
rollback;
