-- T-304 — the lifecycle switch settings, their flip history, the tenant suspend/resume RPCs and
-- `provision_tenant_v1` (F05). pgTAP slot `100`. Packet:
-- docs/tasks/T-304-kill-switch-provisioning.md.
--
-- Rulings applied: **#74** / **#199 §4** (M1 stores expert and provider only; tenant is
-- organisations.status), **#98** (policy_revision writer is T-202 / #179 — merge-order coupling:
-- test 40 turns red when that writer merges), **#45** answered (T-116 owns the provider registry;
-- #143 carries the FK; no FK here), **#62**, **#67**. FAQ-0010: every function revoked by full
-- signature; objects live in non-exposed `toi_control` (#75 toi_identity pattern).
--
-- FAQ-0011 does **not** apply. The gate is EXECUTE to `toi_control_plane` plus an in-body login
-- check. `provider_switch_state_v1` is the #199 server-path read for the gateway; it is not granted
-- to request roles and not to `toi_control_plane`.
--
-- A missing switch row means "not switched off". Role flow: writes as postgres (IN ROLE
-- toi_control_plane); one write under `set local role toi_control_plane`; tenant-scope reads as
-- authenticated. Table assertions run as the owner — the only role with table privilege.
--
-- Fixtures: seed.sql company1 / company2. Transaction-local; ends with `rollback;`.
begin;
create extension if not exists pgtap with schema extensions;

select plan(91);

-- ---------------------------------------------------------------- helpers (pg_temp, security invoker)
create function pg_temp.try_switch(p_scope_kind text, p_organisation_id uuid, p_scope_key text,
                                   p_state text, p_reason text, p_requested_by text)
returns text language plpgsql security invoker as $fn$
begin
  begin
    perform toi_control.set_lifecycle_switch_v1(p_scope_kind, p_organisation_id, p_scope_key,
                                           p_state, p_reason, p_requested_by);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_provision(p_slug text, p_host text, p_display_name text,
                                      p_locale text, p_timezone text)
returns text language plpgsql security invoker as $fn$
begin
  begin
    perform toi_control.provision_tenant_v1(p_slug, p_host, p_display_name, p_locale, p_timezone,
                                       'pilot onboarding', 'ops@terraoi.test');
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_suspend(p_organisation_id uuid)
returns text language plpgsql security invoker as $fn$
begin
  begin
    perform toi_control.suspend_tenant_v1(p_organisation_id, 'incident: suspected data exposure', 'ops@terraoi.test');
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_resume(p_organisation_id uuid)
returns text language plpgsql security invoker as $fn$
begin
  begin
    perform toi_control.resume_tenant_v1(p_organisation_id, 'all clear, signed off in the incident note', 'ops@terraoi.test');
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_scope(p_organisation_id uuid)
returns text language plpgsql security invoker as $fn$
begin
  begin
    perform public.set_tenant_scope(p_organisation_id);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_host(p_host text)
returns text language plpgsql security invoker as $fn$
begin
  begin
    perform public.resolve_tenant_host(p_host);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_table(p_table text)
returns text language plpgsql security invoker as $fn$
declare v integer;
begin
  begin
    execute format('select count(*) from toi_control.%I', p_table) into v;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_provider_read(p_key text)
returns text language plpgsql security invoker as $fn$
begin
  begin
    perform toi_control.provider_switch_state_v1(p_key);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Capture tables, each created by the role that fills it (016/020 pattern), asserted by the owner.
set local role authenticated;
create temp table t_user (case_name text primary key, result text not null);
insert into t_user values
  ('switch_as_authenticated', pg_temp.try_switch('provider', null, 'deepseek', 'off', 'x', 'ops@terraoi.test')),
  ('provision_as_authenticated', pg_temp.try_provision('somebody', 'somebody.terraoi.app', 'Nope', 'en', 'UTC')),
  ('provider_read_as_authenticated', pg_temp.try_provider_read('deepseek'));
reset role;

grant toi_control_plane to postgres;
set local role toi_control_plane;
create temp table t_ctl (case_name text primary key, result text not null);
insert into t_ctl values
  ('switch_as_control_plane', pg_temp.try_switch('provider', null, 'deepseek', 'off',
                                                 'outage: all 5xx for twenty minutes', 'ops@terraoi.test'));
-- B2: provision read-back under the control-plane role (no table SELECT).
create temp table t_prov_read as
  select * from toi_control.provision_tenant_v1(
    'ctl-readback', 'ctl-readback.terraoi.app', 'Control Readback', 'en', 'UTC',
    'read-back under toi_control_plane', 'ops@terraoi.test');
reset role;

-- ---------------------------------------------------------------- 1-6 shape and grants
select ok(
  exists (select 1 from pg_tables where schemaname = 'toi_control' and tablename = 'lifecycle_switches'),
  '1 toi_control.lifecycle_switches exists');
select ok(
  exists (select 1 from pg_tables where schemaname = 'toi_control' and tablename = 'lifecycle_switch_flips'),
  '2 toi_control.lifecycle_switch_flips exists');
select ok(
  (select rolcanlogin = false from pg_roles where rolname = 'toi_control_plane'),
  '3 toi_control_plane exists and is NOLOGIN (the #75 group-role pattern)');
select ok(
  (select relrowsecurity from pg_class where oid = 'toi_control.lifecycle_switches'::regclass),
  '4 lifecycle_switches has row level security enabled');
select is_empty(
  $$ select r.rolname || ' -> ' || c.relname || ' ' || a.privilege_type
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
       join pg_roles r on r.oid = a.grantee
      where n.nspname = 'toi_control'
        and c.relname in ('lifecycle_switches', 'lifecycle_switch_flips')
        and r.rolname in ('anon', 'authenticated', 'service_role') $$,
  '5 no request role and no service_role holds any privilege on either switch table');
select is_empty(
  $$ select c.relname || ' ' || a.privilege_type
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'toi_control'
        and c.relname in ('lifecycle_switches', 'lifecycle_switch_flips')
        and a.grantee = 'toi_control_plane'::regrole $$,
  '6 toi_control_plane holds no table privilege, so it cannot write a switch behind the RPC');

-- ---------------------------------------------------------------- 7-19 the switch write path
select is((select result from t_ctl where case_name = 'switch_as_control_plane'), 'ok',
  '7 a login in toi_control_plane can flip a switch at runtime');
select is((select result from t_user where case_name = 'switch_as_authenticated'), '42501',
  '8 a signed-in user is refused at runtime, by the grant, before any body runs');
select is((select result from t_user where case_name = 'provision_as_authenticated'), '42501',
  '9 and so is an attempt to provision through the request path');
select is(state, 'off', '10 the provider the control plane stopped reads off')
  from toi_control.lifecycle_switches where scope_kind = 'provider' and scope_key = 'deepseek';
select is(actor_role, 'postgres',
  '11 the recorded actor is the session login the database saw — here the pg_prove login, and in '
  || 'production the control-plane login — not a value someone passed in')
  from toi_control.lifecycle_switches where scope_kind = 'provider' and scope_key = 'deepseek';
select is(requested_by, 'ops@terraoi.test',
  '12 the named human is stored as named, and no further than that')
  from toi_control.lifecycle_switches where scope_kind = 'provider' and scope_key = 'deepseek';
select is(pg_temp.try_switch('provider', null, 'deepseek', 'off', '', 'ops@terraoi.test'),
  '22023', '13 an empty reason is refused before anything is written');
select is((select count(*) from toi_control.lifecycle_switches
            where scope_kind = 'provider' and scope_key = 'deepseek' and state = 'off')::text, '1',
  '14 and that refusal left the current state where it was');
select is(pg_temp.try_switch('tenant', '11111111-1111-4111-8111-111111111111', null, 'off',
                             'tenant stopped pending contract review', 'ops@terraoi.test'),
  '22023', '15 stopping a tenant is suspend_tenant_v1, not a switch row');
select is(pg_temp.try_switch('platform', null, null, 'off', 'x', 'ops@terraoi.test'),
  '22023', '16 platform is not a storable M1 kind (#74 / #199 §4); unknown kinds are refused the same way');
select is(pg_temp.try_switch('service', null, 'geotech_screening', 'off', 'x', 'ops@terraoi.test'),
  '22023', '17 service is not a storable M1 kind either');
select is(pg_temp.try_switch('provider', null, 'Bad Provider', 'off', 'outage', 'ops@terraoi.test'),
  '22023', '18 a provider key must match ProviderKey as src/contracts/keys.ts:13 defines it');
select is(pg_temp.try_switch('provider', null, 'workers_ai', 'maybe', 'x', 'ops@terraoi.test'),
  '22023', '19 state is on or off; there is no third value');

-- ---------------------------------------------------------------- 20-33 reads, #74 / #199
select is(pg_temp.try_switch('provider', '11111111-1111-4111-8111-111111111111', 'deepseek', 'off',
                             'per-tenant provider stop', 'ops@terraoi.test'),
  '22023', '20 a provider switch cannot also name a tenant');
select is(toi_control.lifecycle_switch_state_v1('expert', null, 'geotech_screening'), 'on',
  '21 a switch nobody has ever flipped reads on, not off and not null');
select is(toi_control.lifecycle_switch_state_v1('provider', null, 'openrouter'), 'on',
  '22 and a provider with no row reads on');
select is(toi_control.lifecycle_switch_state_v1('provider', null, 'deepseek'), 'off',
  '23 the provider the operator did stop reads off');
select is((select count(*)
             from toi_control.lifecycle_switch_history_v1('provider', null, 'deepseek'))::text, '1',
  '24 the flip history is queryable for the provider that was flipped');
select is((select reason from toi_control.lifecycle_switch_history_v1('provider', null, 'deepseek') limit 1),
  'outage: all 5xx for twenty minutes',
  '25 the most recent flip carries the operator reason');
select is(has_function_privilege('anon',
  'toi_control.lifecycle_switch_state_v1(text, uuid, text)', 'execute'), false,
  '26 anon may not read switch state');
select is(pg_temp.try_switch('expert', null, 'geotech_screening', 'off',
                             'T-311 expert suspended pending eval', 'ops@terraoi.test'),
  'ok', '27 #74 half one: a switched-off expert is recordable by key');
select is(state, 'off', '28 and it reads back off')
  from toi_control.lifecycle_switches where scope_kind = 'expert' and scope_key = 'geotech_screening';
select is(pg_temp.try_switch('expert', null, 'geotech_screening', 'off',
                             'retry same state', 'ops@terraoi.test'),
  'ok', '29 N3: a same-state set is accepted as a no-op');
select is((select count(*) from toi_control.lifecycle_switch_flips
            where scope_kind = 'expert' and scope_key = 'geotech_screening')::text, '1',
  '30 and the same-state retry recorded no second flip');
select is(toi_control.provider_switch_state_v1('openrouter'), 'on',
  '31 #199: missing provider row reads on through provider_switch_state_v1');
select is(toi_control.provider_switch_state_v1('deepseek'), 'off',
  '32 #199: a stopped provider reads off through the gateway read');
select is(has_function_privilege('anon',
  'toi_control.provider_switch_state_v1(text)', 'execute'), false,
  '33 anon cannot execute provider_switch_state_v1');
select is((select result from t_user where case_name = 'provider_read_as_authenticated'), '42501',
  '34 authenticated cannot execute provider_switch_state_v1 either');

-- ---------------------------------------------------------------- 35-47 suspend and resume
select is(pg_temp.try_suspend('11111111-1111-4111-8111-111111111111'), 'ok',
  '35 suspend_tenant_v1 accepts a seeded tenant with a reason');
select is(status, 'suspended',
  '36 and it moves organisations.status, the one status resolve_tenant_host and is_active_member read')
  from public.organisations where id = '11111111-1111-4111-8111-111111111111';
select is(policy_revision::text, '1',
  '37 #98 / N8: this migration does not bump policy_revision; the assertion turns red when #179 merges')
  from public.organisations where id = '11111111-1111-4111-8111-111111111111';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_user values ('scope_after_suspend', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
reset role;
select is((select result from t_user where case_name = 'scope_after_suspend'), '28000',
  '38 (as that tenant admin) the merged scope helper refuses at once');
select is(pg_temp.try_suspend('11111111-1111-4111-8111-111111111111'), 'ok',
  '39 suspending an already-suspended tenant is a no-op rather than an error');
select is((select count(*) from toi_control.lifecycle_switch_flips
            where scope_kind = 'tenant' and organisation_id = '11111111-1111-4111-8111-111111111111')::text, '1',
  '40 and the no-op recorded no second flip');
select is(pg_temp.try_suspend('00000000-0000-4000-8000-00000000000f'), '23503',
  '41 suspending an unknown organisation is refused, not answered with silence');
select is((select status from public.organisations
            where id = '00000000-0000-4000-8000-00000000000f'::uuid) is null, true,
  '42 and that refusal touched nothing');
select is(pg_temp.try_resume('11111111-1111-4111-8111-111111111111'), 'ok',
  '43 resume_tenant_v1 brings the tenant back');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_user values ('scope_after_resume', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
reset role;
select is((select result from t_user where case_name = 'scope_after_resume'), 'ok',
  '44 (as the same tenant admin) the tenant serves again');
select is(toi_control.lifecycle_switch_state_v1('tenant', '11111111-1111-4111-8111-111111111111', null), 'on',
  '45 and the read derives a resumed tenant as on from organisations.status, not from a switch row');
select is(pg_temp.try_suspend('22222222-2222-4222-8222-222222222222'), 'ok',
  '46 a different tenant can be suspended independently');
select is((select count(*) from public.organisations
            where id = '11111111-1111-4111-8111-111111111111' and status = 'active')::text, '1',
  '47 and that changed nothing about company1, which is back to active');

-- ---------------------------------------------------------------- 48-53 the grant wall and the signatures
select is(has_function_privilege('authenticated',
  'toi_control.provision_tenant_v1(text, text, text, text, text, text, text)', 'execute'), false,
  '48 no signed-in user may provision a tenant (catalog)');
select is(has_function_privilege('service_role',
  'toi_control.set_lifecycle_switch_v1(text, uuid, text, text, text, text)', 'execute'), false,
  '49 not even service_role may flip a switch');
select is_empty(
  $$ select n.nspname || '.' || p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname in ('public', 'toi_identity', 'intake', 'toi_control')
        and a.grantee = 'toi_control_plane'::regrole
        and a.privilege_type = 'EXECUTE'
        and p.proname not in ('set_lifecycle_switch_v1', 'lifecycle_switch_state_v1',
                              'lifecycle_switch_history_v1', 'suspend_tenant_v1',
                              'resume_tenant_v1', 'provision_tenant_v1') $$,
  '50 toi_control_plane is granted execute on the six lifecycle functions and nothing else (016 idiom)');
select ok(
  (select count(*) = 0
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'toi_control'
      and p.proname in ('set_lifecycle_switch_v1', 'suspend_tenant_v1', 'resume_tenant_v1',
                        'provision_tenant_v1')
      and pg_get_function_arguments(p.oid) ~* '(^|, )p_(actor|user_id|member_id|on_behalf_of)( |,)'),
  '51 there is no actor, user or membership parameter to forge in any lifecycle signature');
select ok(
  (select count(*) = 6
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'toi_control'
      and p.proname in ('set_lifecycle_switch_v1', 'lifecycle_switch_state_v1',
                        'lifecycle_switch_history_v1', 'suspend_tenant_v1',
                        'resume_tenant_v1', 'provision_tenant_v1')),
  '52 exactly six control-plane lifecycle functions exist in toi_control');
select ok(
  has_schema_privilege('toi_control_plane', 'toi_control', 'USAGE'),
  '53 toi_control_plane has USAGE on toi_control');
select is_empty(
  $$ select a.privilege_type
       from pg_namespace n
       cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      where n.nspname = 'public'
        and a.grantee = 'toi_control_plane'::regrole $$,
  '53b toi_control_plane holds no direct privilege on schema public (B1: no grant usage on public)');

-- ---------------------------------------------------------------- 54-67 provisioning (F05) + B2 read-back
select is((select status from t_prov_read), 'provisioning',
  '54 B2: provision_tenant_v1 returns status under set local role toi_control_plane');
select is((select host from t_prov_read), 'ctl-readback.terraoi.app',
  '55 B2: and returns the requested host without a table SELECT');
select is((select roles::text from t_prov_read), '2',
  '56 B2: roles count in the read-back');
select is((select permissions::text from t_prov_read), '6',
  '57 B2: permissions count in the read-back');
select is((select members::text from t_prov_read), '0',
  '58 B2: members count is zero (F05)');
select is(pg_temp.try_provision('acme-surveys', 'acme-surveys.terraoi.app', 'Acme Surveys', 'en', 'UTC'),
  'ok', '59 provisioning a new slug is accepted');
select is((select count(*) from public.organisations where slug = 'acme-surveys')::text, '1',
  '60 one organisation row');
select is(status, 'provisioning',
  '61 and it starts in provisioning')
  from public.organisations where slug = 'acme-surveys';
select is((select count(*) from public.tenant_domains d
             join public.organisations o on o.id = d.organisation_id
            where o.slug = 'acme-surveys' and d.host = 'acme-surveys.terraoi.app'
              and d.kind = 'tenant' and d.status = 'active')::text, '1',
  '62 the exact host is registered');
select is((select count(*) from public.organisation_roles r
             join public.organisations o on o.id = r.organisation_id
            where o.slug = 'acme-surveys')::text, '2',
  '63 the default roles are member and admin');
select is((select count(*) from public.role_permissions rp
             join public.organisation_roles r on r.id = rp.role_id
             join public.organisations o on o.id = r.organisation_id
            where o.slug = 'acme-surveys')::text, '6',
  '64 and their permission areas are the seed vocabulary');
select is((select count(*) from public.organisation_memberships m
             join public.organisations o on o.id = m.organisation_id
            where o.slug = 'acme-surveys')::text, '0',
  '65 F05: provisioning creates no membership row');
select is(pg_temp.try_provision('admin', 'admin.terraoi.app', 'Not A Tenant', 'en', 'UTC'),
  '22023', '66 a reserved slug is refused: admin');
select is(pg_temp.try_provision('www', 'www.terraoi.app', 'Not A Tenant', 'en', 'UTC'),
  '22023', '67 www is refused too');

-- ---------------------------------------------------------------- 68-76 more provisioning refusals / resume
select is(pg_temp.try_provision('terraoi', 'terraoi.app', 'Not A Tenant', 'en', 'UTC'),
  '22023', '68 the zone label itself is refused as a slug');
select is(pg_temp.try_provision('Acme Surveys', 'acme-surveys.terraoi.app', 'Bad Slug', 'en', 'UTC'),
  '22023', '69 a slug the merged CHECK rejects is refused');
select is(pg_temp.try_provision('acme-surveys', 'acme.surveys.terraoi.app', 'Acme Surveys', 'en', 'UTC'),
  '22023', '70 a host with two subdomain levels is refused');
select is(pg_temp.try_provision('acme-surveys', 'acme-surveys.terraoi.app', 'Acme Surveys', 'en-GB', 'UTC'),
  '22023', '71 #67: en-GB cannot be provisioned today');
select is((select count(*) from public.organisations where slug = 'acme-surveys')::text, '1',
  '72 refusals left the tenant provisioned at 59 as the only acme row');
select is(pg_temp.try_provision('acme-surveys', 'acme-surveys.terraoi.app', 'Acme Surveys Renamed', 'en', 'UTC'),
  'ok', '73 the same call again is accepted — resumable');
select is((select count(*) from public.organisations where slug = 'acme-surveys')::text, '1',
  '74 and it created no second organisation');
select is(display_name, 'Acme Surveys',
  '75 provisioning never rewrites an existing tenant identity field')
  from public.organisations where slug = 'acme-surveys';
select is((select count(*) from public.tenant_domains d
             join public.organisations o on o.id = d.organisation_id
            where o.slug = 'acme-surveys')::text, '1',
  '76 no duplicate domain row from a re-run');

-- ---------------------------------------------------------------- 77-88 entry points + grant wall
select is(pg_temp.try_provision('company2', 'acme-surveys.terraoi.app', 'Host Steal', 'en', 'UTC'),
  '23505', '77 a host another tenant already owns is refused');
select is((select count(*) from public.organisations where slug = 'company2')::text, '1',
  '78 and that refusal created nothing for company2 beyond the seeded row');
select is((select count(*) from pg_tables where schemaname = 'public' and tablename ilike '%entitlement%')::text, '0',
  '79 F05 names entitlements: no entitlement table exists, so provisioning seeds none');

select is(pg_temp.try_resume('22222222-2222-4222-8222-222222222222'), 'ok',
  '80 company2 is resumed first (test 46 suspended it)');

set local role anon;
create temp table t_anon_hosts (case_name text primary key, row_count integer not null);
insert into t_anon_hosts values
  ('company2_before', (select count(*) from public.resolve_tenant_host('company2.terraoi.app')));
reset role;

select is(pg_temp.try_suspend('11111111-1111-4111-8111-111111111111'), 'ok',
  '81 the suspend a drill would run');

set local role anon;
insert into t_anon_hosts values
  ('company1_tenant', (select count(*) from public.resolve_tenant_host('company1.terraoi.app'))),
  ('company1_staging', (select count(*) from public.resolve_tenant_host('company1-staging.terraoi.app'))),
  ('company2_after', (select count(*) from public.resolve_tenant_host('company2.terraoi.app')));
reset role;

select is((select row_count::text from t_anon_hosts where case_name = 'company2_before'), '1',
  '82 baseline: company2 resolves before the suspend under test');
select is((select row_count::text from t_anon_hosts where case_name = 'company1_tenant'), '0',
  '83 the suspended tenant resolves to nothing (resolve_tenant_host)');
select is((select row_count::text from t_anon_hosts where case_name = 'company1_staging'), '0',
  '84 and its staging origin stops with it');
select is((select row_count::text from t_anon_hosts where case_name = 'company2_after'), '1',
  '85 the tenant nobody switched off still resolves');

select is(pg_temp.try_host('company1.terraoi.app'), 'ok',
  '86 the refusal is a missing row and not a raised exception');

select is(pg_temp.try_resume('11111111-1111-4111-8111-111111111111'), 'ok',
  '87 the same call that stopped it starts it again');

set local role anon;
insert into t_anon_hosts values
  ('company1_resumed', (select count(*) from public.resolve_tenant_host('company1.terraoi.app')));
reset role;
select is((select row_count::text from t_anon_hosts where case_name = 'company1_resumed'), '1',
  '88 the host resolves again after resume');

set local role authenticated;
insert into t_user values
  ('table_switches_as_user', pg_temp.try_table('lifecycle_switches')),
  ('table_flips_as_user', pg_temp.try_table('lifecycle_switch_flips'));
reset role;
select is((select result from t_user where case_name = 'table_switches_as_user'), '42501',
  '89 a signed-in user cannot select toi_control.lifecycle_switches');
select is((select result from t_user where case_name = 'table_flips_as_user'), '42501',
  '90 nor toi_control.lifecycle_switch_flips');

select * from finish();
rollback;
