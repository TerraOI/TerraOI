-- T-313 PR-1: F19 budget_ledger reserve/reconcile (plan §12.3). Slot 095.
-- Audit/F22 tables are a later slice (needs agent_runs from T-104 / #178).
-- SET ROLE only inside helpers: pgtap functions are not granted to toi_budget_ledger (same idiom as 105).
begin;
create extension if not exists pgtap with schema extensions;

select plan(25);

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

-- company1 was ensure'd with concurrent_run_cap=2 and burst_per_user=2 (§12.3).
select ok(
  pg_temp.reserve_id(
    '11111111-1111-4111-8111-111111111111',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
    'conc-a',
    '00000000-0000-4000-8000-0000000000a1',
    'compose',
    'local_box',
    10,
    10
  ) ~ '^[0-9a-f-]{36}$'
  and pg_temp.reserve_id(
    '11111111-1111-4111-8111-111111111111',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
    'conc-b',
    '00000000-0000-4000-8000-0000000000a1',
    'compose',
    'local_box',
    10,
    10
  ) ~ '^[0-9a-f-]{36}$',
  '19 company1 admits exactly concurrent_run_cap open runs'
);

select is(
  pg_temp.reserve_id(
    '11111111-1111-4111-8111-111111111111',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
    'conc-c',
    '00000000-0000-4000-8000-0000000000a1',
    'compose',
    'local_box',
    10,
    10
  ),
  'P0001',
  '20 a third concurrent run at the cap is refused (§14)'
);

-- burst_per_user=2 and both open runs already belong to a1, so another attempt for a1 (same or
-- new run) must hit the per-user burst before anything else. Use a fresh attempt on an existing
-- open run: concurrent allows the same run_id, burst counts reserved rows for the user.
select is(
  pg_temp.reserve_id(
    '11111111-1111-4111-8111-111111111111',
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
    'burst-extra',
    '00000000-0000-4000-8000-0000000000a1',
    'compose',
    'local_box',
    10,
    10
  ),
  'P0001',
  '21 per-user burst limit refuses a third reserved attempt for the same user'
);

-- Free the two open concurrent reservations so ambiguous/retry can run under the same account.
-- Resolve reservation ids as postgres (toi_budget_ledger has no table SELECT).
create temporary table t_conc on commit drop as
  select
    (select id::text from public.budget_reservations
      where organisation_id = '11111111-1111-4111-8111-111111111111'
        and attempt_id = 'conc-a') as conc_a,
    (select id::text from public.budget_reservations
      where organisation_id = '11111111-1111-4111-8111-111111111111'
        and attempt_id = 'conc-b') as conc_b;

select is(
  pg_temp.as_ledger(format(
    $$ select budget_ledger.reconcile_v1(
         '11111111-1111-4111-8111-111111111111',
         'conc-a',
         %L::uuid,
         'released',
         null
       ) $$,
    (select conc_a from t_conc)
  )),
  'ok',
  '22 release concurrent fixture conc-a before ambiguous retry'
);
select is(
  pg_temp.as_ledger(format(
    $$ select budget_ledger.reconcile_v1(
         '11111111-1111-4111-8111-111111111111',
         'conc-b',
         %L::uuid,
         'released',
         null
       ) $$,
    (select conc_b from t_conc)
  )),
  'ok',
  '23 release concurrent fixture conc-b before ambiguous retry'
);

create temporary table t_ambig on commit drop as
  select pg_temp.reserve_id(
    '11111111-1111-4111-8111-111111111111',
    'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
    'compose:timeout:1',
    null,
    'compose',
    'workers_ai',
    40,
    60
  ) as reservation_id;

select is(
  pg_temp.as_ledger(format(
    $$ select budget_ledger.reconcile_v1(
         '11111111-1111-4111-8111-111111111111',
         'compose:timeout:1',
         %L::uuid,
         'ambiguous',
         null
       ) $$,
    (select reservation_id from t_ambig)
  )),
  'ok',
  '24 ambiguous timeout keeps the first attempt billed'
);

select ok(
  (select state from public.budget_reservations
    where id = (select reservation_id from t_ambig)::uuid) = 'ambiguous'
  and (select used_units from public.budget_reservations
    where id = (select reservation_id from t_ambig)::uuid) = 100
  and pg_temp.reserve_id(
    '11111111-1111-4111-8111-111111111111',
    'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
    'compose:timeout:2',
    null,
    'compose',
    'claude',
    40,
    60
  ) ~ '^[0-9a-f-]{36}$'
  and pg_temp.as_ledger(format(
    $$ select budget_ledger.reconcile_v1(
         '11111111-1111-4111-8111-111111111111',
         'compose:timeout:1',
         %L::uuid,
         'ambiguous',
         null
       ) $$,
    (select reservation_id from t_ambig)
  )) = 'ok'
  and (select used_units from public.budget_reservations
    where id = (select reservation_id from t_ambig)::uuid) = 100,
  '25 retry books a new attempt; duplicate ambiguous reconcile does not double-book'
);

select * from finish();
rollback;
