-- T-304 — the lifecycle switch settings, their flip history, the tenant suspend/resume RPCs and
-- `provision_tenant_v1` (F05). pgTAP slot `100` (claimed on the owner's instruction to start T-304;
-- the claim and the timestamp are recorded in the packet's Status line, and no branch or open PR uses
-- that slot).
--
-- Packet: docs/tasks/T-304-kill-switch-provisioning.md. Plan §972 (kill switches per platform,
-- tenant, service, provider and connector, as explicit settings, **without disabling the
-- deterministic operational record system**), §15.0 ("Tenant provisioning by script (F05), not an
-- admin UI"), §15.2 (M1-PILOT: "kill switches verified"), §11 F01/F03/F05, §4.2 (a tenant is decided
-- by membership plus status), §3.2/§6.1 ("A platform administrator does not automatically receive
-- customer document or chat access"). Rulings applied: **#74** (M1 delivers tenant, expert and
-- provider), **#98** (the tenant switch relies on T-202's `organisations.status` to `policy_revision`
-- writer, which is [#179](https://github.com/TerraOI/TerraOI/pull/179) and still unmerged), **#45**
-- (no provider registry exists, so a provider switch is keyed by `providerKey` alone), **#62** (no
-- `tenant_brands` owner, so provisioning seeds nothing brand-shaped), **#67** (the merged
-- `organisations.locale` CHECK rejects `en-GB`, and the timezone CHECK allows exactly one slash).
-- FAQ-0010: every function here is revoked by full signature in the creating migration.
--
-- FAQ-0011 does **not** apply to these RPCs, and test 46 counts them so a later edit cannot quietly
-- pretend otherwise. A provisioning call names a tenant that does not exist yet, and
-- `set_tenant_scope` raises 28000 unless `auth.uid()` is already an active member of it
-- (`20261105060000_tenancy_core.sql:203-220`) — so membership cannot be the gate for the control
-- plane. The gate is the EXECUTE grant to a dedicated role, plus the in-body check described below.
--
-- Who may dial these. There is no HTTP path to any function in this file: `anon`, `authenticated` and
-- `service_role` hold no EXECUTE (39-41) and no table privilege (5-6), so no request can reach them.
-- The caller is a login that is `IN ROLE toi_control_plane` — the NOLOGIN-group pattern the
-- supervisor accepted for the session Worker in #75
-- (`20261112234000_session_worker_role.sql:12-27`), whose own comment says the login user and its
-- password are §20.8 human steps. The same is true here: **creating that login is not part of this
-- migration and is not claimed by it.**
--
-- What the database can and cannot prove about the actor. `actor_role` is `session_user` read inside a
-- SECURITY DEFINER body — the login that authenticated, which no argument can forge, and there is no
-- actor parameter in any signature (test 45 pins that, because a `p_actor` argument is exactly the
-- value an operator mistypes or spoofs). `requested_by` is the human the operator named: the database
-- records it and cannot verify it, and the column comment says so rather than implying an audit trail
-- stronger than the mechanism supports.
--
-- A missing switch row means "not switched off" — never "off" and never a null the caller has to
-- interpret. Tests 22-23 pin that, and it is the one availability-versus-safety choice in this file a
-- reviewer should push back on if §972 means the opposite.
--
-- The two halves of the #74 ruling are not equally testable here. A switched-off expert is
-- representable and readable (28-30), but "not selectable and its routes are refused at the gateway"
-- needs T-311's `tenant_experts` (absent, pinned by test 31) and a `src/platform/gateway/` change this
-- packet must not make (its Owns list; COORDINATION §2). So test 31 asserts the absence instead of
-- faking the refusal, and that acceptance box stays unticked.
--
-- Fixtures are the rows supabase/seed.sql applies on `supabase db reset`: orgs `company1`
-- 11111111-…-1111 and `company2` 22222222-…-2222; people …a1 (company1 admin), …a2 (company1 member),
-- …a3 (company1 suspended), …b1 (company2 admin). The `toi_control_plane` membership granted below is
-- transaction-local and the file ends with `rollback;`, so nothing here moves another slot's counts.
begin;
create extension if not exists pgtap with schema extensions;

select plan(73);

-- ---------------------------------------------------------------- helpers (pg_temp, security invoker)
-- SQLSTATE instead of an abort, the 010/016/025 idiom, so a red run names what is missing (42883
-- before the migration exists) instead of stopping the file.
create function pg_temp.try_switch(p_scope_kind text, p_organisation_id uuid, p_scope_key text,
                                   p_state text, p_reason text, p_requested_by text)
returns text language plpgsql security invoker as $fn$
begin
  begin
    perform public.set_lifecycle_switch_v1(p_scope_kind, p_organisation_id, p_scope_key,
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
    perform public.provision_tenant_v1(p_slug, p_host, p_display_name, p_locale, p_timezone,
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
    perform public.suspend_tenant_v1(p_organisation_id, 'incident: suspected data exposure', 'ops@terraoi.test');
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
    perform public.resume_tenant_v1(p_organisation_id, 'all clear, signed off in the incident note', 'ops@terraoi.test');
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

-- ---------------------------------------------------------------- 1-6 shape and grants
select ok(
  exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'lifecycle_switches'),
  '1 public.lifecycle_switches exists');
select ok(
  exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'lifecycle_switch_flips'),
  '2 public.lifecycle_switch_flips exists');
select ok(
  (select rolcanlogin = false from pg_roles where rolname = 'toi_control_plane'),
  '3 toi_control_plane exists and is NOLOGIN (the #75 group-role pattern)');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.lifecycle_switches'::regclass),
  '4 lifecycle_switches has row level security enabled');
select is_empty(
  $$ select r.rolname || ' -> ' || c.relname || ' ' || a.privilege_type
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
       join pg_roles r on r.oid = a.grantee
      where n.nspname = 'public'
        and c.relname in ('lifecycle_switches', 'lifecycle_switch_flips')
        and r.rolname in ('anon', 'authenticated', 'service_role') $$,
  '5 no request role and no service_role holds any privilege on either switch table');
select is_empty(
  $$ select c.relname || ' ' || a.privilege_type
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'public'
        and c.relname in ('lifecycle_switches', 'lifecycle_switch_flips')
        and a.grantee = 'toi_control_plane'::regrole $$,
  '6 toi_control_plane holds no table privilege, so it cannot write a switch behind the RPC');

-- ---------------------------------------------------------------- 7-23 the switch write path
grant toi_control_plane to postgres;
set local role toi_control_plane;

select is(pg_temp.try_switch('platform', null, null, 'off',
                             'incident: model chain returning wrong units', 'ops@terraoi.test'),
  'ok', '7 a platform switch off is accepted when it carries a reason');
select is(state, 'off', '8 and the platform switch reads off')
  from public.lifecycle_switches where scope_kind = 'platform';
select is(actor_role, session_user::text,
  '9 the recorded actor is session_user as the database read it, not a value someone passed in')
  from public.lifecycle_switches where scope_kind = 'platform';
select is(requested_by, 'ops@terraoi.test',
  '10 the named human is stored as named, and no further than that')
  from public.lifecycle_switches where scope_kind = 'platform';
select is((select count(*) from public.lifecycle_switch_flips)::text, '1',
  '11 the flip itself is in the history table');
select is(pg_temp.try_switch('platform', null, null, 'on',
                             'all clear, signed off in the incident note', 'ops@terraoi.test'),
  'ok', '12 a switch is reversible, and the flip back is attributed too');
select is((select count(*) from public.lifecycle_switch_flips)::text, '2',
  '13 every flip keeps its own history row (§972 actor and reason per flip)');
select is((select count(*) from public.lifecycle_switches where scope_kind = 'platform')::text, '1',
  '14 the current-state table upserts: two flips, one current row');
select is(pg_temp.try_switch('platform', null, null, 'off', '', 'ops@terraoi.test'),
  '22023', '15 an empty reason is refused before anything is written');
select is(pg_temp.try_switch('tenant', '11111111-1111-4111-8111-111111111111', null, 'off',
                             'tenant stopped pending contract review', 'ops@terraoi.test'),
  '22023', '16 stopping a tenant is suspend_tenant_v1, not a switch row: two mechanisms for one act is how they drift');
select is(pg_temp.try_switch('nonsense', null, null, 'off', 'x', 'ops@terraoi.test'),
  '22023', '17 an unknown scope kind is refused (the CHECK carries §972 five names, no sixth)');
select is(pg_temp.try_switch('provider', null, 'Bad Provider', 'off', 'outage', 'ops@terraoi.test'),
  '22023', '18 a provider key must match ProviderKey as src/contracts/keys.ts:13 defines it');
select is(pg_temp.try_switch('provider', null, 'deepseek', 'off',
                             'outage: all 5xx for twenty minutes', 'ops@terraoi.test'),
  'ok', '19 #45: an unknown providerKey is still settable, because no registry exists to check it against');
select is(pg_temp.try_switch('provider', null, 'workers_ai', 'maybe', 'x', 'ops@terraoi.test'),
  '22023', '20 state is on or off; there is no third value for a caller to be confused by');
select is(pg_temp.try_switch('service', null, 'geotech_screening', 'off',
                             'service stopped for maintenance', 'ops@terraoi.test'),
  'ok', '21 §972 names a service scope, so a service switch is storable even though no packet reads it yet');

-- ---------------------------------------------------------------- 24-33 the read, and the #74 boundary
select is(public.lifecycle_switch_state_v1('expert', null, 'geotech_screening'), 'on',
  '22 a switch nobody has ever flipped reads on, not off and not null');
select is(public.lifecycle_switch_state_v1('provider', null, 'workers_ai'), 'on',
  '23 and a provider with no row reads on, so a typo in a key cannot silently stop a chain');
select is(public.lifecycle_switch_state_v1('provider', null, 'deepseek'), 'off',
  '24 the provider the operator did stop reads off');
select is(public.lifecycle_switch_state_v1('service', null, 'geotech_screening'), 'off',
  '25 a service switch reads back through the same function');
select ok(has_function_privilege('toi_control_plane',
  'public.lifecycle_switch_state_v1(text, uuid, text)', 'execute'),
  '26 the control plane may read switch state');
select is((select count(*) from public.lifecycle_switch_history_v1('platform', null, null))::text, '2',
  '27 the flip history is queryable, which is what makes actor-and-reason-per-flip an actual capability');
select is((select reason from public.lifecycle_switch_history_v1('platform', null, null) limit 1),
  'all clear, signed off in the incident note',
  '28 the most recent flip comes first, so an operator sees the latest attribution without ordering it');
select is(pg_temp.try_switch('expert', null, 'geotech_screening', 'off',
                             'T-311 expert suspended pending eval', 'ops@terraoi.test'),
  'ok', '29 #74 half one: a switched-off expert is recordable by key');
select is(state, 'off', '30 and it reads back off through the same read the pipeline will use')
  from public.lifecycle_switches where scope_kind = 'expert' and scope_key = 'geotech_screening';
select ok(
  not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'tenant_experts'),
  '31 #74 half two is NOT provable here: no tenant_experts exists (T-311 owns it), and the gateway '
  || 'refusal needs a src/platform/gateway/ change this packet must not make (§2). '
  || 'That acceptance box stays unticked rather than being satisfied by a fake');
select is_empty(
  $$ select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in ('lifecycle_switches', 'lifecycle_switch_flips')
        and (has_table_privilege('anon', c.oid, 'SELECT')
          or has_table_privilege('authenticated', c.oid, 'SELECT')
          or has_table_privilege('service_role', c.oid, 'SELECT')
          or has_table_privilege('anon', c.oid, 'UPDATE')
          or has_table_privilege('authenticated', c.oid, 'UPDATE')
          or has_table_privilege('service_role', c.oid, 'UPDATE')) $$,
  '32 no request role and no service_role can read or write either switch table directly');
select is(has_table_privilege('toi_control_plane', 'public.lifecycle_switch_flips', 'update'), false,
  '33 the history table is append-only as far as grants reach: the control plane cannot rewrite a flip');

-- ---------------------------------------------------------------- 34-41 suspend and resume
select is(pg_temp.try_suspend('11111111-1111-4111-8111-111111111111'), 'ok',
  '34 suspend_tenant_v1 accepts a seeded tenant with a reason');
select is(status, 'suspended',
  '35 and it moves organisations.status, the one status resolve_tenant_host and is_active_member read')
  from public.organisations where id = '11111111-1111-4111-8111-111111111111';
select is(policy_revision, 1,
  '36 #98: this migration does not bump policy_revision, and pinning that is what keeps the gap visible '
  || 'until T-202 (the #179 status trigger) merges')
  from public.organisations where id = '11111111-1111-4111-8111-111111111111';
reset role;
-- The kill that works today is the merged membership predicate, not a new one.
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_scope('11111111-1111-4111-8111-111111111111'), '28000',
  '37 (as that tenant admin, after the suspend) the scope helper refuses at once, so new sessions and '
  || 'runs stop without waiting for the revision bump #98 owes');
reset role;
grant toi_control_plane to postgres;
set local role toi_control_plane;
select is(pg_temp.try_suspend('11111111-1111-4111-8111-111111111111'), 'ok',
  '38 suspending an already-suspended tenant is a no-op rather than an error, so a retried script is safe');
select is((select count(*) from public.lifecycle_switch_flips
            where scope_kind = 'tenant')::text, '1',
  '39 and the no-op recorded no second flip');
select is(pg_temp.try_suspend('00000000-0000-4000-8000-00000000000f'), '23503',
  '40 suspending an unknown organisation is refused by the foreign key, not answered with silence');
select is(pg_temp.try_resume('11111111-1111-4111-8111-111111111111'), 'ok',
  '41 resume_tenant_v1 brings the tenant back');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_scope('11111111-1111-4111-8111-111111111111'), 'ok',
  '42 (as the same tenant admin) the tenant serves again, so the kill switch is reversible end to end');
reset role;
grant toi_control_plane to postgres;
set local role toi_control_plane;
select is(pg_temp.try_suspend('22222222-2222-4222-8222-222222222222'), 'ok',
  '43 a different tenant can be suspended, which is the point of a per-tenant switch');
select is((select count(*) from public.organisations
            where id = '11111111-1111-4111-8111-111111111111' and status = 'active')::text, '1',
  '44 and it changed nothing about company1, which is back to active');
select is(pg_temp.try_switch('tenant', '11111111-1111-4111-8111-111111111111', null, 'off', 'x', 'ops@terraoi.test'),
  '22023', '45 a tenant switch row is refused whatever the tenant status is: one mechanism, tested twice');

-- ---------------------------------------------------------------- 46-51 the grant wall and the signatures
select is(has_function_privilege('authenticated',
  'public.provision_tenant_v1(text, text, text, text, text, text, text)', 'execute'), false,
  '46 no signed-in user may provision a tenant');
select is(has_function_privilege('service_role',
  'public.set_lifecycle_switch_v1(text, uuid, text, text, text, text)', 'execute'), false,
  '47 not even service_role may flip a switch: the switch is not reachable through the Data API');
select is(has_function_privilege('anon',
  'public.lifecycle_switch_state_v1(text, uuid, text)', 'execute'), false,
  '48 anon may not read switch state');
select is_empty(
  $$ select p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
      where n.nspname in ('public', 'toi_identity', 'intake')
        and a.grantee = 'toi_control_plane'::regrole
        and a.privilege_type = 'EXECUTE'
        and p.proname not in ('set_lifecycle_switch_v1', 'lifecycle_switch_state_v1',
                              'lifecycle_switch_history_v1', 'suspend_tenant_v1',
                              'resume_tenant_v1', 'provision_tenant_v1') $$,
  '49 toi_control_plane is granted execute on the six lifecycle functions and nothing else (016 idiom)');
select ok(
  (select count(*) = 0
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('set_lifecycle_switch_v1', 'suspend_tenant_v1', 'resume_tenant_v1',
                        'provision_tenant_v1')
      and pg_get_function_arguments(p.oid) ~* '(^|, )p_(actor|user_id|member_id|on_behalf_of)( |,)')
  , '50 there is no actor, user or membership parameter to forge in any lifecycle signature');
select ok(
  (select count(*) = 6
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('set_lifecycle_switch_v1', 'lifecycle_switch_state_v1',
                        'lifecycle_switch_history_v1', 'suspend_tenant_v1',
                        'resume_tenant_v1', 'provision_tenant_v1'))
  , '51 exactly six lifecycle functions exist, so the FAQ-0011 carve-out above stays countable instead '
  || 'of accreting a seventh that someone later assumes is tenant-scoped');
-- A source-level pin, deliberately labelled weaker than a runtime one (the precedent is
-- 001_function_privileges.test.sql tests 34-38): CI connects as one login, so pgTAP cannot present
-- itself as a non-member session_user. What it can pin is that the check exists and reads the right
-- value, and that the functions are definer — which is exactly why `session_user` and not
-- `current_user` is the one that means "who authenticated".
select ok(
  (select count(*) = 4
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('set_lifecycle_switch_v1', 'suspend_tenant_v1', 'resume_tenant_v1',
                        'provision_tenant_v1')
      and p.prosecdef
      and p.prosrc like '%pg_has_role(session_user, ''toi_control_plane'', ''MEMBER'')%'),
  '52 all four write RPCs are SECURITY DEFINER and gate on pg_has_role(session_user, '
  || '''toi_control_plane'', ''MEMBER''): a source-level pin, because CI cannot log in as a '
  || 'non-member session — 46-49 are the enforced half, this is the regression half');

-- ---------------------------------------------------------------- 53-68 provisioning (F05)
select is(pg_temp.try_provision('acme-surveys', 'acme-surveys.terraoi.app', 'Acme Surveys', 'en', 'UTC'),
  'ok', '53 provisioning a new slug is accepted');
select is((select count(*) from public.organisations where slug = 'acme-surveys')::text, '1',
  '54 one organisation row');
select is(status, 'provisioning',
  '55 and it starts in provisioning, so it resolves but serves nothing (tenancy_core:247, §4.1)')
  from public.organisations where slug = 'acme-surveys';
select is((select count(*) from public.tenant_domains d
             join public.organisations o on o.id = d.organisation_id
            where o.slug = 'acme-surveys' and d.host = 'acme-surveys.terraoi.app'
              and d.kind = 'tenant' and d.status = 'active')::text, '1',
  '56 the exact host is registered, kind tenant, status active (F01: no wildcard, no suffix matching)');
select is((select count(*) from public.organisation_roles r
             join public.organisations o on o.id = r.organisation_id
            where o.slug = 'acme-surveys')::text, '2',
  '57 the default roles are the two the merged seed already uses: member and admin');
select is((select count(*) from public.role_permissions rp
             join public.organisation_roles r on r.id = rp.role_id
             join public.organisations o on o.id = r.organisation_id
            where o.slug = 'acme-surveys')::text, '6',
  '58 and their permission areas are the seed vocabulary (chat.ask, knowledge.read, projects.read, '
  || 'knowledge.admin, members.admin, projects.admin) — not a list invented in this migration');
select is((select count(*) from public.organisation_memberships m
             join public.organisations o on o.id = m.organisation_id
            where o.slug = 'acme-surveys')::text, '0',
  '59 F05: provisioning grants the platform admin no operational access, so it creates no membership row');
select is(pg_temp.try_provision('admin', 'admin.terraoi.app', 'Not A Tenant', 'en', 'UTC'),
  '22023', '60 a reserved slug is refused: admin is a control-plane class in tenancy_core:46 and plan §209');
select is(pg_temp.try_provision('www', 'www.terraoi.app', 'Not A Tenant', 'en', 'UTC'),
  '22023', '61 www is refused too (plan §214 reserved hosts, collisions with tenant routing)');
select is(pg_temp.try_provision('terraoi', 'terraoi.app', 'Not A Tenant', 'en', 'UTC'),
  '22023', '62 the zone label itself is refused as a slug');
select is(pg_temp.try_provision('Acme Surveys', 'acme-surveys.terraoi.app', 'Bad Slug', 'en', 'UTC'),
  '22023', '63 a slug the merged CHECK rejects is refused as a named argument error, not as a database error');
select is(pg_temp.try_provision('acme-surveys', 'acme.surveys.terraoi.app', 'Acme Surveys', 'en', 'UTC'),
  '22023', '64 a host the merged tenancy_core:41-44 CHECK rejects (two subdomain levels) is refused, not worked around');
select is(pg_temp.try_provision('acme-surveys', 'acme-surveys.terraoi.app', 'Acme Surveys', 'en-GB', 'UTC'),
  '22023', '65 #67: en-GB cannot be provisioned today because the merged locale CHECK rejects it, and '
  || 'this migration neither edits that CHECK nor fakes a workaround for it');
select ok(
  (select count(*) = 0 from pg_tables where schemaname = 'public' and tablename ilike '%entitlement%'),
  '66 F05 says "defaults and entitlements": no entitlement table exists on main and no packet owns one, '
  || 'so provisioning seeds no entitlement and this assertion says so instead of creating one quietly');
select is(pg_temp.try_provision('acme-surveys', 'acme-surveys.terraoi.app', 'Acme Surveys Renamed', 'en', 'UTC'),
  'ok', '67 the same call again is accepted — resumable, §11 F05');
select is((select count(*) from public.organisations where slug = 'acme-surveys')::text, '1',
  '68 and it created no second organisation');
select is(display_name, 'Acme Surveys',
  '69 provisioning is create-or-ensure: it never rewrites an existing tenant identity field')
  from public.organisations where slug = 'acme-surveys';
select is((select count(*) from public.tenant_domains d
             join public.organisations o on o.id = d.organisation_id
            where o.slug = 'acme-surveys')::text, '1',
  '70 no duplicate domain row from a re-run, which is the half that makes a retried script safe');
select is(pg_temp.try_provision('company2', 'acme-surveys.terraoi.app', 'Host Steal', 'en', 'UTC'),
  '23505', '71 a host another tenant already owns is refused by the unique-host constraint');
select is((select count(*) from public.organisations where slug = 'acme-surveys')::text, '1',
  '72 and that refusal changed nothing');
select is(public.lifecycle_switch_state_v1('tenant',
  (select id from public.organisations where slug = 'acme-surveys'), null), 'on',
  '73 a freshly provisioned tenant has no switch row and reads on (§972 default)');

select * from finish();
rollback;
