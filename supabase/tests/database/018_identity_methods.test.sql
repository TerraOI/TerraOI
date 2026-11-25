-- T-201 PR-2 (20261125130000_identity_methods.sql): invite claim, host-keyed Entra issuer read,
-- organisation-wide reset revocation. Rulings: #179 (invite model), #182, #183, #184, #185.
-- Slot 018 (the packet names 012; a new slot keeps PR-1's 012 untouched — see the agent backlog Q-13).
-- Synthetic fixtures only (AGENTS.md §4.7).
begin;
create extension if not exists pgtap with schema extensions;

select plan(27);

create or replace function pg_temp.as_user(p_sub uuid) returns void
language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub::text, ''), true);
end;
$$;

create or replace function pg_temp.try_sql(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlstate;
end;
$$;

create temporary table t_out (k text primary key, v text) on commit drop;
grant all on t_out to authenticated;

-- ---------------------------------------------------------------- 1-4 privileges
select ok(has_function_privilege('authenticated', 'public.redeem_invitation_v1(text)', 'execute')
          and not has_function_privilege('anon', 'public.redeem_invitation_v1(text)', 'execute')
          and not has_function_privilege('service_role', 'public.redeem_invitation_v1(text)', 'execute'),
  '1 redeem_invitation_v1 is for authenticated only');
select ok(has_function_privilege('authenticated', 'public.entra_allowed_issuers_v1(text)', 'execute')
          and not has_function_privilege('anon', 'public.entra_allowed_issuers_v1(text)', 'execute'),
  '2 entra_allowed_issuers_v1 is for authenticated only');
select ok(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                       where n.nspname = 'public' and p.proname = 'entra_allowed_issuers_v1'
                         and pg_get_function_identity_arguments(p.oid) <> 'p_host text'),
  '3 the organisation-keyed issuer read does not exist beside the host-keyed one (#185)');
select ok(has_function_privilege('toi_session_worker', 'toi_identity.revoke_user_sessions_v1(uuid,text,timestamptz)', 'execute')
          and not has_function_privilege('authenticated', 'toi_identity.revoke_user_sessions_v1(uuid,text,timestamptz)', 'execute')
          and not has_function_privilege('service_role', 'toi_identity.revoke_user_sessions_v1(uuid,text,timestamptz)', 'execute'),
  '4 the revocation is reachable from the session carrier only (#184)');

-- ---------------------------------------------------------------- fixtures
-- n1: a brand-new verified user with no profile; n2: verified, invited to company1 but under another
-- address; n3: unverified. Invitations: n1 to company1 (member role), a3 (suspended member) to company1.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at) values
  ('00000000-0000-4000-8000-0000000018a1', '00000000-0000-4000-8000-000000000000', 'authenticated', 'authenticated',
   'New.Hire@Company1.test', now(), now(), now()),
  ('00000000-0000-4000-8000-0000000018a2', '00000000-0000-4000-8000-000000000000', 'authenticated', 'authenticated',
   'someone-else@company1.test', now(), now(), now()),
  ('00000000-0000-4000-8000-0000000018a3', '00000000-0000-4000-8000-000000000000', 'authenticated', 'authenticated',
   'unverified@company1.test', null, now(), now());
insert into public.tenant_invitations (id, organisation_id, email, role_id, status, invited_by, expires_at) values
  ('18100000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'new.hire@company1.test',
   '31000000-0000-4000-8000-000000000001', 'pending', '00000000-0000-4000-8000-0000000000a1', now() + interval '7 days'),
  ('18100000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'left@company1.test',
   '31000000-0000-4000-8000-000000000001', 'pending', '00000000-0000-4000-8000-0000000000a1', now() + interval '7 days'),
  ('18100000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'unverified@company1.test',
   '31000000-0000-4000-8000-000000000001', 'pending', '00000000-0000-4000-8000-0000000000a1', now() + interval '7 days');

-- ---------------------------------------------------------------- 5-14 invite claim
select pg_temp.as_user('00000000-0000-4000-8000-0000000018a1');
insert into t_out values ('wrong_host', public.redeem_invitation_v1('company2.terraoi.app'));
insert into t_out values ('unknown_host', public.redeem_invitation_v1('nosuch.terraoi.app'));
reset role;
select is((select v from t_out where k = 'wrong_host'), 'not_found',
  '5 an invite for company1 claimed on company2''s host creates nothing');
select is((select v from t_out where k = 'unknown_host'), 'not_found', '6 an unknown host claims nothing');
select is((select count(*)::int from public.organisation_memberships where user_id = '00000000-0000-4000-8000-0000000018a1'), 0,
  '7 …and no membership row exists anywhere');

select pg_temp.as_user('00000000-0000-4000-8000-0000000018a2');
insert into t_out values ('other_address', public.redeem_invitation_v1('company1.terraoi.app'));
reset role;
select is((select v from t_out where k = 'other_address'), 'not_found',
  '8 an invite bound to one address cannot be claimed by another verified address');

select pg_temp.as_user('00000000-0000-4000-8000-0000000018a3');
insert into t_out values ('unverified', public.redeem_invitation_v1('company1.terraoi.app'));
reset role;
select is((select v from t_out where k = 'unverified'), 'email_mismatch',
  '9 an unverified address never claims, even when an invitation names it');

select pg_temp.as_user('00000000-0000-4000-8000-0000000018a1');
insert into t_out values ('claim', public.redeem_invitation_v1('company1.terraoi.app'));
reset role;
select is((select v from t_out where k = 'claim'), 'redeemed',
  '10 the invitee''s verified address (any case) claims their pending invitation');
select is((select m.status || ':' || r.key
             from public.organisation_memberships m
             join public.membership_roles mr on mr.membership_id = m.id
             join public.organisation_roles r on r.id = mr.role_id
            where m.user_id = '00000000-0000-4000-8000-0000000018a1'
              and m.organisation_id = '11111111-1111-4111-8111-111111111111'),
  'active:member', '11 …the membership is active with the invited role');
select is((select status from public.tenant_invitations where id = '18100000-0000-4000-8000-000000000001'), 'accepted',
  '12 …the invitation is accepted');
select is((select email from public.profiles where id = '00000000-0000-4000-8000-0000000018a1'), 'new.hire@company1.test',
  '13 …and a canonical profile exists for a first-ever sign-in');
select pg_temp.as_user('00000000-0000-4000-8000-0000000018a1');
insert into t_out values ('replay', public.redeem_invitation_v1('company1.terraoi.app'));
reset role;
select is((select v from t_out where k = 'replay'), 'not_found', '14 a second claim finds nothing to claim');

-- ---------------------------------------------------------------- 15-16 never resurrect
select pg_temp.as_user('00000000-0000-4000-8000-0000000000a3');
insert into t_out values ('suspended', public.redeem_invitation_v1('company1.terraoi.app'));
reset role;
select is((select v from t_out where k = 'suspended'), 'not_found',
  '15 a suspended member holding a pending invitation is not resurrected by a claim');
select is((select status from public.organisation_memberships
            where user_id = '00000000-0000-4000-8000-0000000000a3'
              and organisation_id = '11111111-1111-4111-8111-111111111111'), 'suspended',
  '16 …the membership stays suspended');

-- ---------------------------------------------------------------- 17-21 Entra issuer read (host-keyed)
insert into public.tenant_entra_issuers (organisation_id, issuer_tenant_id) values
  ('11111111-1111-4111-8111-111111111111', 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa');
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b1');
select is(public.entra_allowed_issuers_v1('company1.terraoi.app'), array['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'],
  '17 the routed host''s list is what a visitor of that host can already learn by starting a sign-in');
select is(public.entra_allowed_issuers_v1('company2.terraoi.app'), '{}'::text[],
  '18 company2''s host never yields company1''s issuers');
select is(public.entra_allowed_issuers_v1('nosuch.terraoi.app'), '{}'::text[],
  '19 an unknown host answers like a tenant that allows nothing');
reset role;
update public.organisations set status = 'suspended' where id = '11111111-1111-4111-8111-111111111111';
select pg_temp.as_user('00000000-0000-4000-8000-0000000000b1');
select is(public.entra_allowed_issuers_v1('company1.terraoi.app'), '{}'::text[],
  '20 a suspended organisation returns nothing');
reset role;
update public.organisations set status = 'active' where id = '11111111-1111-4111-8111-111111111111';
select pg_temp.as_user(null);
select is(pg_temp.try_sql($q$ select public.entra_allowed_issuers_v1('company1.terraoi.app') $q$), '28000',
  '21 a caller with no subject is refused');
reset role;

-- ---------------------------------------------------------------- 22-27 organisation-wide revocation
insert into toi_identity.sessions
  (session_key, user_id, host, created_at, expires_at, key_version, access_token_ciphertext, refresh_token_ciphertext, token_expires_at)
select k, u::uuid, h, now(), now() + interval '8 hours', 'v1',
       'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
       'v1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
       now() + interval '1 hour'
  from (values
    (repeat('A', 43), '00000000-0000-4000-8000-0000000000a4', 'company1.terraoi.app'),
    (repeat('B', 43), '00000000-0000-4000-8000-0000000000a4', 'company1-staging.terraoi.app'),
    (repeat('C', 43), '00000000-0000-4000-8000-0000000000a4', 'company2.terraoi.app')
  ) as s(k, u, h);
select is(toi_identity.revoke_user_sessions_v1('00000000-0000-4000-8000-0000000000a4', 'company1.terraoi.app', now()), true,
  '22 a reset on company1 reports the revocation ran');
select is((select count(*)::int from toi_identity.sessions
            where user_id = '00000000-0000-4000-8000-0000000000a4' and host like 'company1%' and revoked_at is null), 0,
  '23 …sessions on every host of the same organisation are revoked, sibling staging host included (#182)');
select is((select count(*)::int from toi_identity.sessions
            where session_key = repeat('C', 43) and revoked_at is null), 1,
  '24 …the same user''s session under another organisation survives');
select is(toi_identity.revoke_user_sessions_v1('00000000-0000-4000-8000-0000000018a2', 'company1.terraoi.app', now()), true,
  '25 zero live sessions still answers true: the revocation ran (#183)');
select is(pg_temp.try_sql($q$ select toi_identity.revoke_user_sessions_v1('00000000-0000-4000-8000-0000000000a4', 'nosuch.terraoi.app', now()) $q$), '28000',
  '26 an unknown host is refused, never "nothing to revoke"');
select is(pg_temp.try_sql($q$ select toi_identity.revoke_user_sessions_v1('00000000-0000-4000-8000-0000000000a4', 'Company1.terraoi.app', now()) $q$), '22023',
  '27 a non-normalized host is a validation error');

select * from finish();
rollback;
