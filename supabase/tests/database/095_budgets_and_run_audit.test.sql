-- T-313 PR-1: F19 budget_ledger reserve/reconcile (plan §12.3). Slot 095.
-- Audit/F22 tables are a later slice (needs agent_runs from T-104 / #178).
-- SET ROLE only inside helpers: pgtap functions are not granted to toi_budget_ledger (same idiom as 105).
begin;
create extension if not exists pgtap with schema extensions;

select plan(18);

select has_schema('budget_ledger', '1 budget_ledger schema exists');
select has_role('toi_budget_ledger', '2 toi_budget_ledger NOLOGIN role exists');
select ok(
  (select rolcanlogin from pg_roles where rolname = 'toi_budget_ledger') = false,
  '3 toi_budget_ledger is NOLOGIN');

select ok(
  has_function_privilege(
    'toi_budget_ledger',
    'budget_ledger.reserve_v1(uuid, uuid, text, uuid, text, text, bigint, bigint)',
    'execute'
  ),
  '4 toi_budget_ledger may EXECUTE reserve_v1'
);
select is(
  has_function_privilege(
    'authenticated',
    'budget_ledger.reserve_v1(uuid, uuid, text, uuid, text, text, bigint, bigint)',
    'execute'
  ),
  false,
  '5 authenticated cannot EXECUTE reserve_v1'
);
select is(
  has_function_privilege(
    'anon',
    'budget_ledger.reserve_v1(uuid, uuid, text, uuid, text, text, bigint, bigint)',
    'execute'
  ),
  false,
  '6 anon cannot EXECUTE reserve_v1'
);
select is(
  has_table_privilege('authenticated', 'public.budget_accounts', 'insert'),
  false,
  '7 authenticated cannot insert budget_accounts directly'
);
select is(
  has_table_privilege('toi_budget_ledger', 'public.budget_reservations', 'insert'),
  false,
  '8 toi_budget_ledger has no table INSERT (SECURITY DEFINER only)'
);

grant toi_budget_ledger to postgres;

create or replace function pg_temp.as_ledger(p_sql text) returns text
language plpgsql as $$
begin
  set local role toi_budget_ledger;
  execute p_sql;
  reset role;
  return 'ok';
exception when others then
  reset role;
  return sqlstate;
end;
$$;

create or replace function pg_temp.reserve_id(
  p_org uuid,
  p_run uuid,
  p_attempt text,
  p_user uuid,
  p_task text,
  p_provider text,
  p_in bigint,
  p_out bigint
) returns text
language plpgsql as $$
declare
  v_id uuid;
begin
  set local role toi_budget_ledger;
  select budget_ledger.reserve_v1(p_org, p_run, p_attempt, p_user, p_task, p_provider, p_in, p_out)
    into v_id;
  reset role;
  return v_id::text;
exception when others then
  reset role;
  return sqlstate;
end;
$$;

select is(
  pg_temp.as_ledger($$
    select budget_ledger.ensure_account_v1(
      '11111111-1111-4111-8111-111111111111',
      1000, 10000, 2, 2
    )
  $$),
  'ok',
  '9 ensure company1 budget account'
);
select is(
  pg_temp.as_ledger($$
    select budget_ledger.ensure_account_v1(
      '22222222-2222-4222-8222-222222222222',
      50, 10000, 2, 2
    )
  $$),
  'ok',
  '10 ensure company2 budget account with a low daily ceiling'
);

create temporary table t_res on commit drop as
  select pg_temp.reserve_id(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'attempt-1',
    '00000000-0000-4000-8000-0000000000a1',
    'compose',
    'local_box',
    100,
    100
  ) as reservation_id;

select ok(
  (select reservation_id from t_res) ~ '^[0-9a-f-]{36}$',
  '11 reserve_v1 returns a reservation id'
);

select is(
  (select state from public.budget_reservations where id = (select reservation_id from t_res)::uuid),
  'reserved',
  '12 reservation row is reserved before reconcile'
);

select is(
  pg_temp.reserve_id(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'attempt-1',
    '00000000-0000-4000-8000-0000000000a1',
    'compose',
    'local_box',
    100,
    100
  ),
  (select reservation_id from t_res),
  '13 duplicate attempt_id is idempotent'
);

select is(
  pg_temp.as_ledger(format(
    $$ select budget_ledger.reconcile_v1(
         '11111111-1111-4111-8111-111111111111',
         'attempt-1',
         %L::uuid,
         'released',
         null
       ) $$,
    (select reservation_id from t_res)
  )),
  'ok',
  '14 unused reservation releases liability'
);

select is(
  (select state from public.budget_reservations where id = (select reservation_id from t_res)::uuid),
  'released',
  '15 released reservation is not still reserved'
);

select is(
  pg_temp.reserve_id(
    '22222222-2222-4222-8222-222222222222',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    'c2-a1',
    '00000000-0000-4000-8000-0000000000b1',
    'compose',
    'workers_ai',
    30,
    20
  ) ~ '^[0-9a-f-]{36}$',
  true,
  '16 company2 can reserve within its daily ceiling'
);

select is(
  pg_temp.reserve_id(
    '22222222-2222-4222-8222-222222222222',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    'c2-a2',
    '00000000-0000-4000-8000-0000000000b1',
    'compose',
    'workers_ai',
    30,
    20
  ),
  'P0001',
  '17 company2 second reserve that would exceed the daily ceiling is refused'
);

select ok(
  (select day_reserved_units + day_settled_units
     from public.budget_accounts
    where organisation_id = '11111111-1111-4111-8111-111111111111') < 1000,
  '18 company1 account is not charged by company2 reservations'
);

select * from finish();
rollback;
