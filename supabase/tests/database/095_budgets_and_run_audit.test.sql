-- T-313 PR-1: F19 budget_ledger reserve/reconcile (plan §12.3). Slot 095.
-- Audit/F22 tables are a later slice (needs agent_runs from T-104 / #178).
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

create or replace function pg_temp.try_sql(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

-- Synthetic ceilings for company1; company2 gets a tiny daily ceiling for isolation proof.
set local role toi_budget_ledger;
select lives_ok(
  $$ select budget_ledger.ensure_account_v1(
       '11111111-1111-4111-8111-111111111111',
       1000, 10000, 2, 2
     ) $$,
  '9 ensure company1 budget account'
);
select lives_ok(
  $$ select budget_ledger.ensure_account_v1(
       '22222222-2222-4222-8222-222222222222',
       50, 10000, 2, 2
     ) $$,
  '10 ensure company2 budget account with a low daily ceiling'
);
reset role;

set local role toi_budget_ledger;
create temporary table t_res on commit drop as
  select budget_ledger.reserve_v1(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'attempt-1',
    '00000000-0000-4000-8000-0000000000a1',
    'compose',
    'local_box',
    100,
    100
  ) as reservation_id;

select ok((select reservation_id from t_res) is not null, '11 reserve_v1 returns a reservation id');

select is(
  (select state from public.budget_reservations where id = (select reservation_id from t_res)),
  'reserved',
  '12 reservation row is reserved before reconcile'
);

select is(
  budget_ledger.reserve_v1(
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

select lives_ok(
  format(
    $$ select budget_ledger.reconcile_v1(
         '11111111-1111-4111-8111-111111111111',
         'attempt-1',
         %L::uuid,
         'released',
         null
       ) $$,
    (select reservation_id from t_res)
  ),
  '14 unused reservation releases liability'
);

select is(
  (select state from public.budget_reservations where id = (select reservation_id from t_res)),
  'released',
  '15 released reservation is not still reserved'
);

-- Daily ceiling: company2 has 50 units; 40+40 would exceed.
select is(
  pg_temp.try_sql($$
    select budget_ledger.reserve_v1(
      '22222222-2222-4222-8222-222222222222',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      'c2-a1',
      '00000000-0000-4000-8000-0000000000b1',
      'compose',
      'workers_ai',
      30,
      20
    )
  $$),
  'ok',
  '16 company2 can reserve within its daily ceiling'
);

select is(
  pg_temp.try_sql($$
    select budget_ledger.reserve_v1(
      '22222222-2222-4222-8222-222222222222',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      'c2-a2',
      '00000000-0000-4000-8000-0000000000b1',
      'compose',
      'workers_ai',
      30,
      20
    )
  $$),
  'P0001',
  '17 company2 second reserve that would exceed the daily ceiling is refused'
);

-- Cross-tenant: company1 reservation authority never books company2's account by org id mismatch
-- (reserve keys on p_organisation_id). Exhaustion on company2 left company1 untouched:
select ok(
  (select day_reserved_units + day_settled_units
     from public.budget_accounts
    where organisation_id = '11111111-1111-4111-8111-111111111111') < 1000,
  '18 company1 account is not charged by company2 reservations'
);

reset role;

select * from finish();
rollback;
