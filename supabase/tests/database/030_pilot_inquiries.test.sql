-- T-130 pilot inquiry intake: no anonymous path, least-privilege writer, retention.
-- Run with: pnpm db:test   (CI runs it on every PR)
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

-- Structure -----------------------------------------------------------------
select has_schema('intake', 'intake schema exists');
select has_table('intake', 'pilot_inquiries', 'intake.pilot_inquiries exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'intake.pilot_inquiries'::regclass),
  'RLS is enabled on intake.pilot_inquiries'
);
select is_empty(
  $$ select policyname::text from pg_policies where schemaname = 'intake' $$,
  'intake.pilot_inquiries has no policies (nobody reads it through RLS)'
);
select ok(
  (select rolcanlogin = false from pg_roles where rolname = 'inquiry_writer'),
  'inquiry_writer exists and is NOLOGIN'
);
select is_empty(
  $$ select p.proname::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'intake' and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                         where cfg = 'search_path=intake, pg_temp') $$,
  'every intake SECURITY DEFINER function pins search_path = intake, pg_temp'
);
select ok(
  not has_function_privilege('inquiry_writer', 'intake.prune_pilot_inquiries()', 'execute'),
  'inquiry_writer cannot execute prune_pilot_inquiries'
);

-- anon and authenticated: everything denied ----------------------------------
set local role anon;
select throws_ok($$ select * from intake.pilot_inquiries $$, '42501', null, 'anon cannot select');
select throws_ok(
  $$ insert into intake.pilot_inquiries (name, email, company, services, ip_hash)
     values ('a', 'a@b.co', 'c', array['uav'], repeat('a', 64)) $$,
  '42501', null, 'anon cannot insert');
select throws_ok(
  $$ select intake.submit_pilot_inquiry_v1('a', 'a@b.co', 'c', null, array['uav'], null, repeat('a', 64)) $$,
  '42501', null, 'anon cannot execute submit_pilot_inquiry_v1');
reset role;

set local role authenticated;
select throws_ok($$ select * from intake.pilot_inquiries $$, '42501', null, 'authenticated cannot select');
select throws_ok(
  $$ insert into intake.pilot_inquiries (name, email, company, services, ip_hash)
     values ('a', 'a@b.co', 'c', array['uav'], repeat('a', 64)) $$,
  '42501', null, 'authenticated cannot insert');
select throws_ok(
  $$ select intake.submit_pilot_inquiry_v1('a', 'a@b.co', 'c', null, array['uav'], null, repeat('a', 64)) $$,
  '42501', null, 'authenticated cannot execute submit_pilot_inquiry_v1');
reset role;

-- inquiry_writer: execute only -------------------------------------------------
-- Test-only grants, rolled back with the transaction. On PG16+ a CREATEROLE non-superuser
-- (Supabase's postgres) gets only ADMIN on roles it creates, not SET; and pgTAP lives in
-- `extensions`, which inquiry_writer has no usage on. Never move these into a migration.
grant inquiry_writer to postgres;
grant usage on schema extensions to inquiry_writer;
set local role inquiry_writer;
select lives_ok(
  $$ select intake.submit_pilot_inquiry_v1('Dana Reyes', 'dana@company1.com', 'Company1', 'Survey lead',
                                           array['uav', 'gpr'], 'Hello', repeat('ab', 32)) $$,
  'inquiry_writer can submit a valid inquiry');
select lives_ok(
  $$ select intake.submit_pilot_inquiry_v1(repeat('🛰', 60) || repeat('a', 60), 'e@company1.com', 'Company1',
                                           null, array['other'], null, repeat('cd', 32)) $$,
  'accepts a 120-character name containing emoji');
select throws_ok($$ select * from intake.pilot_inquiries $$, '42501', null, 'inquiry_writer cannot select');
select throws_ok($$ update intake.pilot_inquiries set status = 'closed' $$, '42501', null, 'inquiry_writer cannot update');
select throws_ok($$ delete from intake.pilot_inquiries $$, '42501', null, 'inquiry_writer cannot delete');
select throws_ok(
  $$ select intake.submit_pilot_inquiry_v1(repeat('a', 121), 'a@b.co', 'c', null, array['uav'], null, repeat('a', 64)) $$,
  '23514', null, 'over-length name is refused');
select throws_ok(
  $$ select intake.submit_pilot_inquiry_v1('a', 'not-an-email', 'c', null, array['uav'], null, repeat('a', 64)) $$,
  '23514', null, 'bad email is refused');
select throws_ok(
  $$ select intake.submit_pilot_inquiry_v1('a', 'a@b.co', 'c', null, array['lidar'], null, repeat('a', 64)) $$,
  '23514', null, 'unknown service is refused');
select throws_ok(
  $$ select intake.submit_pilot_inquiry_v1('a', 'a@b.co', 'c', null, '{}'::text[], null, repeat('a', 64)) $$,
  '23514', null, 'empty services are refused');
select throws_ok(
  $$ select intake.submit_pilot_inquiry_v1('a', 'a@b.co', 'c', null, array['uav'], null, '203.0.113.7') $$,
  '23514', null, 'a raw IP in place of the hash is refused');
reset role;

select is(
  (select count(*)::int from intake.pilot_inquiries where email = 'dana@company1.com' and status = 'new'),
  1, 'the submitted row is stored with status new');

-- Retention --------------------------------------------------------------------
delete from intake.pilot_inquiries;
insert into intake.pilot_inquiries (created_at, name, email, company, services, ip_hash) values
  (now() - interval '13 months', 'Old', 'old@b.co', 'c', array['uav'], repeat('a', 64)),
  (now() - interval '11 months', 'Recent', 'recent@b.co', 'c', array['uav'], repeat('b', 64));
select is(intake.prune_pilot_inquiries(), 1, 'prune deletes exactly the 13-month-old row');
select results_eq(
  $$ select name from intake.pilot_inquiries $$, $$ values ('Recent'::text) $$,
  'prune keeps the 11-month-old row');
select ok(
  exists (select 1 from cron.job
           where jobname = 'prune-pilot-inquiries'
             and command = 'select intake.prune_pilot_inquiries()'),
  'the pg_cron job exists and calls prune_pilot_inquiries');

select * from finish();
rollback;
