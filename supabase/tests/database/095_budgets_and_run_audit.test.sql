-- T-313 PR-1: F19 budget_ledger reserve/reconcile (plan §12.3). Slot 095.
-- Audit/F22 tables are a later slice (needs agent_runs from T-104 / #178).
-- SET ROLE only inside helpers: pgtap functions are not granted to toi_budget_ledger (same idiom as 105).
begin;
create extension if not exists pgtap with schema extensions;

select plan(30);

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

-- ================================================================ 19-30 the limits this PR adds
-- (supervisor round 1 on #255, B1-B3). Every scenario runs on company1's account, which holds no open
-- reservation after test 14, and releases what it opened so the next one starts clean. Ceilings are
-- moved as the test owner: they are tenant policy, not something the ledger role may change.
create or replace function pg_temp.res(p_run text, p_attempt text, p_user uuid, p_units bigint)
returns text language sql as $$
  select pg_temp.reserve_id('11111111-1111-4111-8111-111111111111', p_run::uuid, p_attempt, p_user, 'compose', 'local_box', p_units, 0)
$$;
create or replace function pg_temp.rec(p_attempt text, p_outcome text, p_used bigint)
returns text language plpgsql as $$
declare
  v_id uuid;
begin
  select id into v_id from public.budget_reservations
   where organisation_id = '11111111-1111-4111-8111-111111111111' and attempt_id = p_attempt;
  return pg_temp.as_ledger(format(
    'select budget_ledger.reconcile_v1(%L::uuid, %L, %L::uuid, %L, %s)',
    '11111111-1111-4111-8111-111111111111', p_attempt, v_id, p_outcome, coalesce(p_used::text, 'null')));
end;
$$;
create or replace function pg_temp.acct() returns public.budget_accounts
language sql as $$ select * from public.budget_accounts where organisation_id = '11111111-1111-4111-8111-111111111111' $$;

-- Monthly ceiling: 250 + 100 fits the daily 1000 but not a monthly 300.
update public.budget_accounts set monthly_ceiling_units = 300 where organisation_id = '11111111-1111-4111-8111-111111111111';
select pg_temp.res('00000000-0000-4000-8000-00000000d001', 'm-1', null, 250);
select is(pg_temp.res('00000000-0000-4000-8000-00000000d002', 'm-2', null, 100), 'P0001',
  '19 a reserve within the daily ceiling but past the monthly ceiling is refused');
select pg_temp.rec('m-1', 'released', null);
update public.budget_accounts set monthly_ceiling_units = 10000 where organisation_id = '11111111-1111-4111-8111-111111111111';

-- Settled units count against the next reserve: 150 settled + 200 > a daily 300.
update public.budget_accounts set daily_ceiling_units = 300 where organisation_id = '11111111-1111-4111-8111-111111111111';
select pg_temp.res('00000000-0000-4000-8000-00000000d003', 's-1', null, 200);
select pg_temp.rec('s-1', 'settled', 150);
select is(((pg_temp.acct()).day_reserved_units, (pg_temp.acct()).day_settled_units)::text, '(0,150)',
  '20 settling moves the reservation''s max out of reserved and the used units into settled');
select is(pg_temp.res('00000000-0000-4000-8000-00000000d004', 's-2', null, 200), 'P0001',
  '21 used units count against the next reserve''s ceiling');
update public.budget_accounts set daily_ceiling_units = 1000 where organisation_id = '11111111-1111-4111-8111-111111111111';

-- Ambiguous with no reported usage keeps the full max billed (packet negative 2).
select pg_temp.res('00000000-0000-4000-8000-00000000d005', 'a-1', null, 200);
select pg_temp.rec('a-1', 'ambiguous', null);
select is((select (state, used_units)::text from public.budget_reservations
            where organisation_id = '11111111-1111-4111-8111-111111111111' and attempt_id = 'a-1'), '(ambiguous,200)',
  '22 an ambiguous attempt with no used units stays billed at its full max_units');
select is((pg_temp.acct()).day_settled_units, 350::bigint,
  '23 …and the account carries it as settled spend (150 + 200)');

-- concurrent_run_cap = 2: a third run is refused, a new attempt of an open run is admitted.
select pg_temp.res('00000000-0000-4000-8000-00000000c001', 'c-1', null, 2);
select pg_temp.res('00000000-0000-4000-8000-00000000c002', 'c-2', null, 2);
select is(pg_temp.res('00000000-0000-4000-8000-00000000c003', 'c-3', null, 2), 'P0001',
  '24 a third concurrent run is refused at concurrent_run_cap 2');
select ok(pg_temp.res('00000000-0000-4000-8000-00000000c001', 'c-1b', null, 2) ~ '^[0-9a-f-]{36}$',
  '25 a new attempt of an already-open run is admitted at the cap');
select pg_temp.rec('c-1', 'released', null);
select pg_temp.rec('c-1b', 'released', null);
select pg_temp.rec('c-2', 'released', null);

-- burst_per_user = 2: …a2's third open reservation is refused; another user is not affected.
update public.budget_accounts set concurrent_run_cap = 10 where organisation_id = '11111111-1111-4111-8111-111111111111';
select pg_temp.res('00000000-0000-4000-8000-00000000b001', 'b-1', '00000000-0000-4000-8000-0000000000a2', 2);
select pg_temp.res('00000000-0000-4000-8000-00000000b002', 'b-2', '00000000-0000-4000-8000-0000000000a2', 2);
select is(pg_temp.res('00000000-0000-4000-8000-00000000b003', 'b-3', '00000000-0000-4000-8000-0000000000a2', 2),
  'P0001', '26 a user''s third open reservation is refused at burst_per_user 2');
select ok(pg_temp.res('00000000-0000-4000-8000-00000000b004', 'b-4', '00000000-0000-4000-8000-0000000000a1', 2)
          ~ '^[0-9a-f-]{36}$',
  '27 …while another user of the same tenant can still reserve');
select pg_temp.rec('b-1', 'released', null);
select pg_temp.rec('b-2', 'released', null);
select pg_temp.rec('b-4', 'released', null);

-- Cross-period reconcile (B1). x-1 is booked "yesterday" (account and reservation day_key backdated),
-- y-1 is booked today after the rollover, then x-1 settles. Today's counters must be exactly y-1's
-- reservation: x-1 neither releases today's liability nor lands its spend in today.
select pg_temp.res('00000000-0000-4000-8000-00000000e001', 'x-1', null, 100);
update public.budget_accounts set day_key = day_key - 1 where organisation_id = '11111111-1111-4111-8111-111111111111';
update public.budget_reservations set day_key = day_key - 1
 where organisation_id = '11111111-1111-4111-8111-111111111111' and attempt_id = 'x-1';
select pg_temp.res('00000000-0000-4000-8000-00000000e002', 'y-1', null, 100);
select pg_temp.rec('x-1', 'settled', 80);
select is((pg_temp.acct()).day_reserved_units, 100::bigint,
  '28 settling yesterday''s reservation leaves today''s reserved units (y-1) untouched');
select is((pg_temp.acct()).day_settled_units, 0::bigint,
  '29 …and books none of its spend into today''s settled units');
select is((select (state, used_units)::text from public.budget_reservations
            where organisation_id = '11111111-1111-4111-8111-111111111111' and attempt_id = 'x-1'), '(settled,80)',
  '30 the reservation itself is settled with its reported usage');

select * from finish();
rollback;
