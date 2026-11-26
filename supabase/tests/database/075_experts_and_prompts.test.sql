-- T-311 (SQL slice, FAQ-0012) — platform service/expert/prompt registry, tenant entitlements,
-- vocabulary/style-only tenant overrides, and control-plane entitlement definer
-- (`toi_control.entitle_tenant_service_v1`). pgTAP slot `075`.
-- Packet: docs/tasks/T-311-expert-definitions.md.
--
-- Rulings applied:
--   * #83 (2026-11-09): expert keys (`uav-expert`, `gpr-expert`) are distinct from service keys
--     (`uav-compliance`, `gpr`), linked by `expert_definitions.service_key`.
--   * #97 / ADR-0009: exactly four `refusal_templates` (`no_evidence`, `insufficient_support`,
--     `out_of_scope`, `unavailable`), `insufficient_support` never says "not found", and
--     `out_of_scope` never names another service.
--   * #9: `verify` chain starts at `claude`; `route` and `condense` omit `claude` (§12.4).
--   * #193 E3 / ADR-0012: T-311 owns `service_definitions`, `expert_definitions`, `tenant_services`,
--     `tenant_experts` and `prompt_templates`, and ships `toi_control.entitle_tenant_service_v1`
--     granted `EXECUTE` only to `toi_control_plane` (non-exposed schema `toi_control`, FAQ-0010).
--   * §9.3 / #143 B8: `prompt_templates` and `expert_definitions` (carrying prompt bodies and
--     provider `model_chains`) grant zero privileges to request roles.
--
-- Written first (TDD); CI `database` job is the runner (no Docker locally, FAQ-0009).
-- Fixtures: seed.sql company1 / company2. Transaction-local; ends with `rollback;`.
begin;
create extension if not exists pgtap with schema extensions;

select plan(84);

-- ---------------------------------------------------------------- helpers (pg_temp, security invoker)
create function pg_temp.try_sql(p_sql text)
returns text language plpgsql security invoker as $fn$
begin
  begin
    execute p_sql;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_entitle(
  p_organisation_id uuid,
  p_service_key text,
  p_expert_key text,
  p_expert_version text,
  p_collection_bindings uuid[],
  p_reason text,
  p_requested_by text
) returns text language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from toi_control.entitle_tenant_service_v1(
      p_organisation_id, p_service_key, p_expert_key, p_expert_version,
      p_collection_bindings, p_reason, p_requested_by
    );
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_select_count(p_qualified_table text)
returns text language plpgsql security invoker as $fn$
declare v integer;
begin
  begin
    execute format('select count(*) from %s', p_qualified_table) into v;
    return v::text;
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- ---------------------------------------------------------------- capture request-role runtime refusals
set local role authenticated;
create temp table t_auth_probes (case_name text primary key, result text not null);
insert into t_auth_probes values
  ('entitle_as_authenticated', pg_temp.try_entitle(
    '11111111-1111-4111-8111-111111111111', 'uav-compliance', 'uav-expert', '1.0.0',
    '{}'::uuid[], 'forged', 'user@company1.test')),
  ('insert_tenant_services', pg_temp.try_sql(
    $$ insert into public.tenant_services (organisation_id, service_key, enabled)
       values ('11111111-1111-4111-8111-111111111111', 'uav-compliance', true) $$)),
  ('insert_tenant_experts', pg_temp.try_sql(
    $$ insert into public.tenant_experts (organisation_id, service_key, expert_key, expert_version)
       values ('11111111-1111-4111-8111-111111111111', 'uav-compliance', 'uav-expert', '1.0.0') $$)),
  ('update_tenant_experts', pg_temp.try_sql(
    $$ update public.tenant_experts set enabled = false where true $$)),
  ('select_prompt_templates', pg_temp.try_select_count('public.prompt_templates')),
  ('select_expert_definitions', pg_temp.try_select_count('public.expert_definitions'));
reset role;

-- ---------------------------------------------------------------- 1-16 tables, RLS, and privileges
select has_table('public', 'service_definitions', '1 public.service_definitions exists (§6.1)');
select has_table('public', 'prompt_templates', '2 public.prompt_templates exists (§6.1)');
select has_table('public', 'expert_definitions', '3 public.expert_definitions exists (§6.1)');
select has_table('public', 'tenant_services', '4 public.tenant_services exists (§6.1)');
select has_table('public', 'tenant_experts', '5 public.tenant_experts exists (§6.1)');
select has_table('toi_control', 'tenant_entitlement_events', '6 toi_control.tenant_entitlement_events exists (ADR-0012 audit)');

select is(
  (select count(*)::integer from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('service_definitions', 'prompt_templates', 'expert_definitions',
                        'tenant_services', 'tenant_experts')
      and c.relrowsecurity = true),
  5,
  '7 all five public tables have row level security enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'toi_control.tenant_entitlement_events'::regclass),
  '8 toi_control.tenant_entitlement_events has row level security enabled'
);

select is_empty(
  $$ select n.nspname || '.' || c.relname || ' ' || a.privilege_type
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where ((n.nspname = 'public' and c.relname in (
                'service_definitions', 'prompt_templates', 'expert_definitions',
                'tenant_services', 'tenant_experts'))
             or (n.nspname = 'toi_control' and c.relname = 'tenant_entitlement_events'))
        and a.grantee = 'anon'::regrole $$,
  '9 anon holds zero table privileges on any service, prompt, expert or entitlement table'
);

select is_empty(
  $$ select c.relname || ' ' || a.privilege_type
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'public'
        and c.relname in ('service_definitions', 'prompt_templates', 'expert_definitions',
                          'tenant_services', 'tenant_experts')
        and a.grantee = 'authenticated'::regrole
        and a.privilege_type <> 'SELECT' $$,
  '10 authenticated holds zero write privileges on all five registry and entitlement tables'
);

select is_empty(
  $$ select c.relname || ' ' || a.privilege_type
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where n.nspname = 'public'
        and c.relname in ('prompt_templates', 'expert_definitions')
        and a.grantee = 'authenticated'::regrole $$,
  '11 authenticated holds zero SELECT on prompt_templates and expert_definitions (§9.3 / #143 B8)'
);

select is(
  (select count(*)::integer
     from (values ('public.service_definitions'), ('public.tenant_services'), ('public.tenant_experts')) as t(name)
    where has_table_privilege('authenticated', t.name, 'SELECT')),
  3,
  '12 authenticated holds SELECT on service_definitions, tenant_services and tenant_experts'
);

select is_empty(
  $$ select n.nspname || '.' || c.relname || ' ' || a.privilege_type
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      where ((n.nspname = 'public' and c.relname in (
                'service_definitions', 'prompt_templates', 'expert_definitions',
                'tenant_services', 'tenant_experts'))
             or (n.nspname = 'toi_control' and c.relname = 'tenant_entitlement_events'))
        and a.grantee = 'toi_control_plane'::regrole $$,
  '13 toi_control_plane holds zero table privileges on all six tables (ADR-0012 RPC-only)'
);

select is(
  has_function_privilege(
    'toi_control_plane',
    'toi_control.entitle_tenant_service_v1(uuid, text, text, text, uuid[], text, text)',
    'execute'
  ),
  true,
  '14 toi_control_plane holds EXECUTE on toi_control.entitle_tenant_service_v1 (#193 E3)'
);

select is(
  (has_function_privilege('anon', 'toi_control.entitle_tenant_service_v1(uuid, text, text, text, uuid[], text, text)', 'execute')
   or has_function_privilege('authenticated', 'toi_control.entitle_tenant_service_v1(uuid, text, text, text, uuid[], text, text)', 'execute')
   or has_function_privilege('service_role', 'toi_control.entitle_tenant_service_v1(uuid, text, text, text, uuid[], text, text)', 'execute')),
  false,
  '15 anon, authenticated and service_role cannot execute entitle_tenant_service_v1 (FAQ-0010)'
);

select is(
  (select result from t_auth_probes where case_name = 'entitle_as_authenticated'),
  '42501',
  '16 authenticated calling entitle_tenant_service_v1 at runtime fails with 42501'
);

-- ---------------------------------------------------------------- 17-34 seeded v1 catalog and chains
select is(
  (select string_agg(service_key, ',' order by service_key)
     from public.service_definitions
    where status = 'active' and service_key in ('uav-compliance', 'gpr')),
  'gpr,uav-compliance',
  '17 seeded service_definitions holds active uav-compliance and gpr (#83)'
);

select is(
  (select count(*)::integer
     from public.prompt_templates
    where (id, version) in (('uav-expert-system', '1.0.0'), ('gpr-expert-system', '1.0.0'))
      and status = 'published'
      and char_length(btrim(owner)) > 0
      and body_hash ~ '^[0-9a-f]{64}$'),
  2,
  '18 both v1 prompt_templates exist with published status, owner and 64-hex sha-256 body_hash'
);

select is(
  (select count(*)::integer
     from public.prompt_templates
    where (id, version) in (('uav-expert-system', '1.0.0'), ('gpr-expert-system', '1.0.0'))
      and body_hash = encode(extensions.digest(convert_to(body, 'utf8'), 'sha256'), 'hex')),
  2,
  '19 both seeded prompt body_hash columns match sha-256 of body'
);

select is(
  (select service_key || ':' || status
     from public.expert_definitions
    where expert_key = 'uav-expert' and version = '1.0.0'),
  'uav-compliance:registered',
  '20 uav-expert 1.0.0 links to service uav-compliance (#83) and starts registered, not published (F36)'
);

select is(
  (select service_key || ':' || status
     from public.expert_definitions
    where expert_key = 'gpr-expert' and version = '1.0.0'),
  'gpr:registered',
  '21 gpr-expert 1.0.0 links to service gpr (#83) and starts registered, not published (F36)'
);

select is(
  (select count(*)::integer
     from public.expert_definitions
    where (expert_key, version) in (('uav-expert', '1.0.0'), ('gpr-expert', '1.0.0'))
      and model_chains -> 'verify' ->> 0 = 'claude'),
  2,
  '22 both v1 definitions start verify chain at claude (#9)'
);

select is(
  (select count(*)::integer
     from public.expert_definitions
    where (expert_key, version) in (('uav-expert', '1.0.0'), ('gpr-expert', '1.0.0'))
      and not ((model_chains -> 'route') ? 'claude')
      and not ((model_chains -> 'condense') ? 'claude')),
  2,
  '23 neither v1 definition lists claude in route or condense chains (§12.4)'
);

select is(
  (select count(*)::integer
     from public.expert_definitions
    where (expert_key, version) in (('uav-expert', '1.0.0'), ('gpr-expert', '1.0.0'))
      and public.expert_model_chains_are_valid(model_chains)),
  2,
  '24 every task chain in both v1 definitions is a subsequence of its own DEFAULT_TASK_CHAIN_ORDER'
);

select is(
  (select count(*)::integer
     from public.expert_definitions
    where (expert_key, version) in (('uav-expert', '1.0.0'), ('gpr-expert', '1.0.0'))
      and (select string_agg(k, ',' order by k) from jsonb_object_keys(refusal_templates) as k)
          = 'insufficient_support,no_evidence,out_of_scope,unavailable'),
  2,
  '25 both v1 definitions declare exactly the four refusalTemplates keys (#97, ADR-0009)'
);

select ok(
  (select (u.refusal_templates ->> 'out_of_scope') !~* '\bgpr\b'
          and (g.refusal_templates ->> 'out_of_scope') !~* '\buav\b'
     from public.expert_definitions u, public.expert_definitions g
    where u.expert_key = 'uav-expert' and u.version = '1.0.0'
      and g.expert_key = 'gpr-expert' and g.version = '1.0.0'),
  '26 out_of_scope refusal copy never names another service (no hidden-service enumeration, #97)'
);

select ok(
  (select count(*) = 0
     from public.expert_definitions
    where (expert_key, version) in (('uav-expert', '1.0.0'), ('gpr-expert', '1.0.0'))
      and (refusal_templates ->> 'insufficient_support') ~* 'not found|could not find'),
  '27 insufficient_support refusal copy never claims "not found" (ADR-0009 copy rule)'
);

select is(
  (select count(*)::integer
     from public.expert_definitions
    where (expert_key, version) in (('uav-expert', '1.0.0'), ('gpr-expert', '1.0.0'))
      and cardinality(tool_keys) = 0
      and cardinality(workflow_keys) = 0),
  2,
  '28 both v1 definitions keep tool_keys and workflow_keys empty in M1'
);

select is(
  (select risk_class || ':' || min_verifier_tier
     from public.expert_definitions
    where expert_key = 'uav-expert' and version = '1.0.0'),
  'operational:large',
  '29 uav-expert 1.0.0 has operational risk_class and large min_verifier_tier'
);

select is(
  (select risk_class || ':' || min_verifier_tier
     from public.expert_definitions
    where expert_key = 'gpr-expert' and version = '1.0.0'),
  'knowledge:medium',
  '30 gpr-expert 1.0.0 has knowledge risk_class and medium min_verifier_tier'
);

select is(
  (select count(*)::integer
     from public.expert_definitions
    where (expert_key, version) in (('uav-expert', '1.0.0'), ('gpr-expert', '1.0.0'))
      and embedding_index_key = 'corpus'),
  2,
  '31 both v1 definitions pin embedding_index_key = corpus'
);

select is(
  (select count(*)::integer
     from public.expert_definitions
    where (expert_key, version) in (('uav-expert', '1.0.0'), ('gpr-expert', '1.0.0'))
      and (limits ->> 'retrievalPasses')::int > 0
      and (limits ->> 'toolCalls')::int = 0
      and (limits ->> 'evidenceChunks')::int > 0
      and (limits ->> 'maxOutputTokens')::int > 0
      and (limits ->> 'stageDeadlineMs')::int > 0),
  2,
  '32 both v1 definitions carry positive bounded ExpertLimits with zero toolCalls'
);

-- Helper to test bad expert_definitions inserts cleanly
create function pg_temp.try_insert_expert(
  p_version text,
  p_risk_class text,
  p_min_verifier_tier text,
  p_prompt_id text,
  p_prompt_version text,
  p_model_chains jsonb,
  p_refusal_templates jsonb
) returns text language plpgsql security invoker as $fn$
begin
  begin
    insert into public.expert_definitions (
      expert_key, version, service_key,
      instruction_template_version, retrieval_profile_version,
      tool_keys, workflow_keys,
      answer_schema_version, evaluation_set_version,
      risk_class, prompt_template_id, prompt_template_version,
      model_chains, embedding_index_key, limits,
      clarification_policy, refusal_templates, min_verifier_tier
    ) values (
      'gpr-expert', p_version, 'gpr',
      '1.0.0', '1.0.0',
      '{}'::text[], '{}'::text[],
      '1.0.0', '1.0.0',
      p_risk_class, p_prompt_id, p_prompt_version,
      p_model_chains, 'corpus',
      '{"retrievalPasses":2,"toolCalls":0,"evidenceChunks":12,"maxOutputTokens":1200,"stageDeadlineMs":20000}'::jsonb,
      'ask_once', p_refusal_templates, p_min_verifier_tier
    );
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

select is(
  pg_temp.try_insert_expert(
    '1.0.1-bad-compose', 'knowledge', 'medium', 'gpr-expert-system', '1.0.0',
    '{"condense":["local_box","workers_ai"],"compose":["claude","local_box"],"verify":["claude","workers_ai"]}'::jsonb,
    '{"no_evidence":"a","insufficient_support":"b","out_of_scope":"c","unavailable":"d"}'::jsonb
  ),
  '23514',
  '33 inserting an expert whose compose chain reorders platform order is refused (23514)'
);

select is(
  pg_temp.try_insert_expert(
    '1.0.1-bad-route', 'knowledge', 'medium', 'gpr-expert-system', '1.0.0',
    '{"route":["claude"],"condense":["local_box"],"compose":["local_box","claude"],"verify":["claude"]}'::jsonb,
    '{"no_evidence":"a","insufficient_support":"b","out_of_scope":"c","unavailable":"d"}'::jsonb
  ),
  '23514',
  '34 inserting an expert listing claude in its route chain is refused (23514)'
);

-- ---------------------------------------------------------------- 35-48 guards & immutability
select is(
  pg_temp.try_insert_expert(
    '1.0.1-dup-chain', 'knowledge', 'medium', 'gpr-expert-system', '1.0.0',
    '{"condense":["local_box","local_box"],"compose":["local_box"],"verify":["claude"]}'::jsonb,
    '{"no_evidence":"a","insufficient_support":"b","out_of_scope":"c","unavailable":"d"}'::jsonb
  ),
  '23514',
  '35 duplicate provider inside a single chain is refused (23514)'
);

select is(
  pg_temp.try_insert_expert(
    '1.0.1-op-small', 'operational', 'small', 'gpr-expert-system', '1.0.0',
    '{"condense":["local_box"],"compose":["local_box"],"verify":["claude"]}'::jsonb,
    '{"no_evidence":"a","insufficient_support":"b","out_of_scope":"c","unavailable":"d"}'::jsonb
  ),
  '23514',
  '36 operational expert with min_verifier_tier = small is refused (23514)'
);

select is(
  pg_temp.try_insert_expert(
    '1.0.1-com-small', 'commercial', 'small', 'gpr-expert-system', '1.0.0',
    '{"condense":["local_box"],"compose":["local_box"],"verify":["claude"]}'::jsonb,
    '{"no_evidence":"a","insufficient_support":"b","out_of_scope":"c","unavailable":"d"}'::jsonb
  ),
  '23514',
  '37 commercial expert with min_verifier_tier = small is refused (23514)'
);

select is(
  pg_temp.try_insert_expert(
    '1.0.1-3-refusals', 'knowledge', 'medium', 'gpr-expert-system', '1.0.0',
    '{"condense":["local_box"],"compose":["local_box"],"verify":["claude"]}'::jsonb,
    '{"no_evidence":"a","out_of_scope":"c","unavailable":"d"}'::jsonb
  ),
  '23514',
  '38 definition omitting insufficient_support from refusal_templates is refused (23514, #97)'
);

select is(
  pg_temp.try_insert_expert(
    '1.0.1-5-refusals', 'knowledge', 'medium', 'gpr-expert-system', '1.0.0',
    '{"condense":["local_box"],"compose":["local_box"],"verify":["claude"]}'::jsonb,
    '{"no_evidence":"a","insufficient_support":"b","out_of_scope":"c","unavailable":"d","extra":"e"}'::jsonb
  ),
  '23514',
  '39 definition adding a fifth key to refusal_templates is refused (23514, #97)'
);

-- Prompt draft + hash mismatch probe
create temp table t_prompt_probes (case_name text primary key, result text not null);
insert into t_prompt_probes values
  ('bad_hash', pg_temp.try_sql($$
    insert into public.prompt_templates (id, version, body, body_hash, owner, status)
    values ('draft-probe', '0.1.0', 'Synthetic draft prompt body.', repeat('0', 64), 'platform:test', 'draft')
  $$)),
  ('good_draft', pg_temp.try_sql($$
    insert into public.prompt_templates (id, version, body, body_hash, owner, status)
    values (
      'draft-probe', '0.1.0', 'Synthetic draft prompt body.',
      encode(extensions.digest(convert_to('Synthetic draft prompt body.', 'utf8'), 'sha256'), 'hex'),
      'platform:test', 'draft'
    )
  $$));

select is(
  (select (select result from t_prompt_probes where case_name = 'bad_hash')
          || '/' ||
          (select result from t_prompt_probes where case_name = 'good_draft')),
  '23514/ok',
  '40 mismatched prompt body_hash is refused (23514); matching draft prompt inserts cleanly'
);

select is(
  pg_temp.try_insert_expert(
    '1.0.1-draft-prompt', 'knowledge', 'medium', 'draft-probe', '0.1.0',
    '{"condense":["local_box"],"compose":["local_box"],"verify":["claude"]}'::jsonb,
    '{"no_evidence":"a","insufficient_support":"b","out_of_scope":"c","unavailable":"d"}'::jsonb
  ),
  '23514',
  '41 inserting an expert whose promptTemplateRef points at a draft prompt is refused (23514)'
);

select is(
  pg_temp.try_sql($$
    update public.prompt_templates
       set body = 'Tampered body',
           body_hash = encode(extensions.digest(convert_to('Tampered body', 'utf8'), 'sha256'), 'hex')
     where id = 'uav-expert-system' and version = '1.0.0'
  $$),
  '23514',
  '42 editing the body of a published prompt template in place is refused (23514)'
);

select is(
  pg_temp.try_sql($$
    update public.prompt_templates
       set owner = 'someone-else'
     where id = 'uav-expert-system' and version = '1.0.0'
  $$),
  '23514',
  '43 editing the owner of a published prompt template in place is refused (23514)'
);

-- Draft edit -> publish -> retire -> refuse revive
insert into t_prompt_probes values
  ('edit_draft', pg_temp.try_sql($$
    update public.prompt_templates
       set body = 'Updated synthetic draft prompt body.',
           body_hash = encode(extensions.digest(convert_to('Updated synthetic draft prompt body.', 'utf8'), 'sha256'), 'hex')
     where id = 'draft-probe' and version = '0.1.0'
  $$)),
  ('publish_draft', pg_temp.try_sql($$
    update public.prompt_templates
       set status = 'published'
     where id = 'draft-probe' and version = '0.1.0'
  $$)),
  ('retire_published', pg_temp.try_sql($$
    update public.prompt_templates
       set status = 'retired'
     where id = 'draft-probe' and version = '0.1.0'
  $$)),
  ('revive_retired', pg_temp.try_sql($$
    update public.prompt_templates
       set status = 'published'
     where id = 'draft-probe' and version = '0.1.0'
  $$));

select is(
  (select (select result from t_prompt_probes where case_name = 'retire_published')
          || '/' ||
          (select result from t_prompt_probes where case_name = 'revive_retired')),
  'ok/23514',
  '44 retiring a published prompt succeeds; reviving a retired prompt is refused (23514)'
);

select is(
  pg_temp.try_sql($$
    update public.expert_definitions
       set model_chains = '{"condense":["local_box"],"compose":["local_box"],"verify":["claude"]}'::jsonb
     where expert_key = 'uav-expert' and version = '1.0.0'
  $$),
  '23514',
  '45 editing spec columns of an expert_definitions release in place is refused (23514)'
);

-- Create a disposable expert v2.0.0 to exercise registered -> published -> withdrawn -> refuse revive
create temp table t_exp_lifecycle (case_name text primary key, result text not null);
insert into t_exp_lifecycle values
  ('insert_v2', pg_temp.try_insert_expert(
    '2.0.0', 'knowledge', 'medium', 'gpr-expert-system', '1.0.0',
    '{"route":["local_box","workers_ai"],"condense":["local_box","workers_ai"],"compose":["local_box","workers_ai","claude"],"verify":["claude","workers_ai"]}'::jsonb,
    '{"no_evidence":"a","insufficient_support":"b","out_of_scope":"c","unavailable":"d"}'::jsonb
  )),
  ('publish_v2', pg_temp.try_sql($$
    update public.expert_definitions set status = 'published'
     where expert_key = 'gpr-expert' and version = '2.0.0'
  $$)),
  ('withdraw_v2', pg_temp.try_sql($$
    update public.expert_definitions set status = 'withdrawn'
     where expert_key = 'gpr-expert' and version = '2.0.0'
  $$)),
  ('revive_v2', pg_temp.try_sql($$
    update public.expert_definitions set status = 'published'
     where expert_key = 'gpr-expert' and version = '2.0.0'
  $$));

select is(
  (select (select result from t_exp_lifecycle where case_name = 'insert_v2')
          || '/' || (select result from t_exp_lifecycle where case_name = 'publish_v2')
          || '/' || (select result from t_exp_lifecycle where case_name = 'withdraw_v2')
          || '/' || (select result from t_exp_lifecycle where case_name = 'revive_v2')),
  'ok/ok/ok/23514',
  '46 expert_definitions lifecycle allows registered -> published -> withdrawn and refuses reviving withdrawn'
);

select is(
  (select (select result from t_prompt_probes where case_name = 'edit_draft')
          || '/' || (select result from t_prompt_probes where case_name = 'publish_draft')
          || '/' || (select (published_at is not null)::text
                       from public.prompt_templates
                      where id = 'draft-probe' and version = '0.1.0')),
  'ok/ok/true',
  '47 a draft prompt may be edited before publication, and publishing stamps published_at'
);

select is(
  pg_temp.try_insert_expert(
    '1.0.1-bad-verify', 'knowledge', 'medium', 'gpr-expert-system', '1.0.0',
    '{"condense":["local_box"],"compose":["local_box"],"verify":["workers_ai","claude"]}'::jsonb,
    '{"no_evidence":"a","insufficient_support":"b","out_of_scope":"c","unavailable":"d"}'::jsonb
  ),
  '23514',
  '48 verify chain reordering workers_ai ahead of claude is refused (23514)'
);

-- ---------------------------------------------------------------- 49-64 control-plane entitlement & overrides
create function pg_temp.rev_of(p_org_id uuid)
returns bigint language sql security invoker as $fn$
  select policy_revision from public.organisations where id = p_org_id;
$fn$;

create temp table t_rev_probes (step text primary key, rev bigint not null);
insert into t_rev_probes values
  ('c1_before_svc', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'));

grant toi_control_plane to postgres;
set local role toi_control_plane;
do $$
begin
  perform 1 from toi_control.entitle_tenant_service_v1(
    '11111111-1111-4111-8111-111111111111',
    'uav-compliance',
    null,
    null,
    '{}'::uuid[],
    'pilot service entitlement for company1',
    'ops@terraoi.test'
  );
end;
$$;
reset role;
insert into t_rev_probes values
  ('c1_after_svc', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'));

set local role toi_control_plane;
do $$
begin
  perform 1 from toi_control.entitle_tenant_service_v1(
    '11111111-1111-4111-8111-111111111111',
    'uav-compliance',
    null,
    null,
    '{}'::uuid[],
    'idempotent service entitlement replay',
    'ops@terraoi.test'
  );
end;
$$;
reset role;
insert into t_rev_probes values
  ('c1_after_svc_replay', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'));

set local role toi_control_plane;
create temp table t_entitle_read as
  select * from toi_control.entitle_tenant_service_v1(
    '11111111-1111-4111-8111-111111111111',
    'uav-compliance',
    'uav-expert',
    '1.0.0',
    array['51000000-0000-4000-8000-000000000001']::uuid[],
    'pilot entitlement for company1',
    'ops@terraoi.test'
  );
reset role;
insert into t_rev_probes values
  ('c1_after_exp', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'));

set local role toi_control_plane;
create temp table t_ctl_probes (case_name text primary key, result text not null);
insert into t_ctl_probes values
  ('retry_same', pg_temp.try_entitle(
    '11111111-1111-4111-8111-111111111111',
    'uav-compliance', 'uav-expert', '1.0.0',
    array['51000000-0000-4000-8000-000000000001']::uuid[],
    'idempotent retry', 'ops@terraoi.test'));
reset role;
insert into t_rev_probes values
  ('c1_after_exp_replay', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'));

set local role toi_control_plane;
insert into t_ctl_probes values
  ('empty_reason', pg_temp.try_entitle(
    '11111111-1111-4111-8111-111111111111',
    'uav-compliance', 'uav-expert', '1.0.0', '{}'::uuid[], '', 'ops@terraoi.test')),
  ('unknown_org', pg_temp.try_entitle(
    '00000000-0000-4000-8000-00000000000f',
    'uav-compliance', 'uav-expert', '1.0.0', '{}'::uuid[], 'unknown org', 'ops@terraoi.test')),
  ('service_expert_mismatch', pg_temp.try_entitle(
    '11111111-1111-4111-8111-111111111111',
    'gpr', 'uav-expert', '1.0.0', '{}'::uuid[], 'wrong service for expert', 'ops@terraoi.test')),
  ('cross_tenant_collection', pg_temp.try_entitle(
    '11111111-1111-4111-8111-111111111111',
    'uav-compliance', 'uav-expert', '1.0.0',
    array['52000000-0000-4000-8000-000000000001']::uuid[],
    'company2 collection into company1', 'ops@terraoi.test')),
  ('withdrawn_expert', pg_temp.try_entitle(
    '22222222-2222-4222-8222-222222222222',
    'gpr', 'gpr-expert', '2.0.0', '{}'::uuid[], 'withdrawn version', 'ops@terraoi.test')),
  ('entitle_company2_gpr', pg_temp.try_entitle(
    '22222222-2222-4222-8222-222222222222',
    'gpr', 'gpr-expert', '1.0.0',
    array['52000000-0000-4000-8000-000000000001']::uuid[],
    'pilot entitlement for company2', 'ops@terraoi.test')),
  ('half_pair_expert', pg_temp.try_entitle(
    '22222222-2222-4222-8222-222222222222',
    'gpr', 'gpr-expert', null, '{}'::uuid[], 'missing version', 'ops@terraoi.test'));
reset role;

-- Create a company1 GPR collection to test wrong-service collection binding refusal (test 56)
insert into public.knowledge_collections (id, organisation_id, key, service_key, project_id, name, data_class)
values ('51000000-0000-4000-8000-000000000099', '11111111-1111-4111-8111-111111111111', 'c1-gpr-ref', 'gpr', null,
        'Company1 GPR ref (test)', 'public');

set local role toi_control_plane;
insert into t_ctl_probes values
  ('wrong_service_collection', pg_temp.try_entitle(
    '11111111-1111-4111-8111-111111111111',
    'uav-compliance', 'uav-expert', '1.0.0',
    array['51000000-0000-4000-8000-000000000099']::uuid[],
    'gpr collection into uav expert', 'ops@terraoi.test'));
reset role;

select is(
  (select service_key || ':' || service_enabled::text || ':' || expert_key || ':' || expert_version || ':' || expert_enabled::text
     from t_entitle_read),
  'uav-compliance:true:uav-expert:1.0.0:true',
  '49 toi_control.entitle_tenant_service_v1 succeeds under toi_control_plane and returns read-back'
);

select is(
  (select result from t_ctl_probes where case_name = 'retry_same')
  || ':' || (select count(*)::text from public.tenant_services
              where organisation_id = '11111111-1111-4111-8111-111111111111' and service_key = 'uav-compliance')
  || ':' || (select count(*)::text from public.tenant_experts
              where organisation_id = '11111111-1111-4111-8111-111111111111' and expert_key = 'uav-expert'),
  'ok:1:1',
  '50 retrying entitle_tenant_service_v1 is idempotent and writes no duplicate rows'
);

select ok(
  exists (
    select 1
      from toi_control.tenant_entitlement_events
     where organisation_id = '11111111-1111-4111-8111-111111111111'
       and service_key = 'uav-compliance'
       and expert_key = 'uav-expert'
       and expert_version = '1.0.0'
       and actor_role = 'postgres'
       and requested_by = 'ops@terraoi.test'
  ),
  '51 tenant_entitlement_events records actor_role = session_user and requested_by (ADR-0012 §5)'
);

select is((select result from t_ctl_probes where case_name = 'empty_reason'), '22023',
  '52 empty reason is refused by entitle_tenant_service_v1 (22023)');
select is((select result from t_ctl_probes where case_name = 'unknown_org'), '23503',
  '53 unknown organisation is refused by entitle_tenant_service_v1 (23503)');
select is((select result from t_ctl_probes where case_name = 'service_expert_mismatch'), '22023',
  '54 mismatched service_key / expert_key is refused by entitle_tenant_service_v1 (22023, #83)');
select is((select result from t_ctl_probes where case_name = 'cross_tenant_collection'), '23514',
  '55 binding another tenant''s collection into tenant_experts is refused (23514)');
select is((select result from t_ctl_probes where case_name = 'wrong_service_collection'), '23514',
  '56 binding a collection of a different service into tenant_experts is refused (23514)');
select is((select result from t_ctl_probes where case_name = 'withdrawn_expert'), '23514',
  '57 entitling a withdrawn expert version is refused (23514)');

-- Test 58: register a v1.1.0 + v1.2.0 uav-expert, bind v1.1.0 to company1, withdraw v1.1.0 -> stays pinned to v1.1.0 (never silently swaps to v1.2.0)
do $$
begin
  insert into public.expert_definitions (
    expert_key, version, service_key,
    instruction_template_version, retrieval_profile_version,
    tool_keys, workflow_keys,
    answer_schema_version, evaluation_set_version,
    risk_class, prompt_template_id, prompt_template_version,
    model_chains, embedding_index_key, limits,
    clarification_policy, refusal_templates, min_verifier_tier
  ) values
    ('uav-expert', '1.1.0', 'uav-compliance', '1.0.0', '1.0.0', '{}', '{}', '1.0.0', '1.0.0',
     'operational', 'uav-expert-system', '1.0.0',
     '{"route":["local_box","workers_ai"],"condense":["local_box","workers_ai"],"compose":["local_box","workers_ai","claude"],"verify":["claude","workers_ai"]}'::jsonb,
     'corpus', '{"retrievalPasses":2,"toolCalls":0,"evidenceChunks":12,"maxOutputTokens":1200,"stageDeadlineMs":20000}'::jsonb,
     'ask_once', '{"no_evidence":"a","insufficient_support":"b","out_of_scope":"c","unavailable":"d"}'::jsonb, 'large'),
    ('uav-expert', '1.2.0', 'uav-compliance', '1.0.0', '1.0.0', '{}', '{}', '1.0.0', '1.0.0',
     'operational', 'uav-expert-system', '1.0.0',
     '{"route":["local_box","workers_ai"],"condense":["local_box","workers_ai"],"compose":["local_box","workers_ai","claude"],"verify":["claude","workers_ai"]}'::jsonb,
     'corpus', '{"retrievalPasses":2,"toolCalls":0,"evidenceChunks":12,"maxOutputTokens":1200,"stageDeadlineMs":20000}'::jsonb,
     'ask_once', '{"no_evidence":"a","insufficient_support":"b","out_of_scope":"c","unavailable":"d"}'::jsonb, 'large');
  perform 1 from toi_control.entitle_tenant_service_v1(
    '11111111-1111-4111-8111-111111111111', 'uav-compliance', 'uav-expert', '1.1.0',
    array['51000000-0000-4000-8000-000000000001']::uuid[], 'pin v1.1.0', 'ops@terraoi.test');
  update public.expert_definitions set status = 'withdrawn'
   where expert_key = 'uav-expert' and version = '1.1.0';
end;
$$;

select is(
  (select expert_version from public.tenant_experts
    where organisation_id = '11111111-1111-4111-8111-111111111111'
      and expert_key = 'uav-expert' and enabled = true),
  '1.1.0',
  '58 withdrawing an expert version never silently repoints tenant_experts to a newer version (1.2.0)'
);

-- Re-pin company1 back to 1.0.0 for the remaining override and RLS tests
do $$
begin
  perform 1 from toi_control.entitle_tenant_service_v1(
    '11111111-1111-4111-8111-111111111111', 'uav-compliance', 'uav-expert', '1.0.0',
    array['51000000-0000-4000-8000-000000000001']::uuid[], 'restore v1.0.0', 'ops@terraoi.test');
end;
$$;

-- Vocabulary/style-only tenant override tests (59-62)
insert into t_rev_probes values
  ('c1_before_override', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'));

select is(
  pg_temp.try_sql($$
    update public.tenant_experts
       set vocabulary_override = '{"terminology":{"sortie":"flight"},"tone":"concise","formatting":"bulleted"}'::jsonb
     where organisation_id = '11111111-1111-4111-8111-111111111111'
       and expert_key = 'uav-expert' and expert_version = '1.0.0'
  $$),
  'ok',
  '59 tenant_experts accepts whitelisted vocabulary and style override (terminology, tone, formatting)'
);

insert into t_rev_probes values
  ('c1_after_override', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'));

update public.tenant_experts
   set vocabulary_override = '{"terminology":{"sortie":"flight"},"tone":"concise","formatting":"bulleted"}'::jsonb
 where organisation_id = '11111111-1111-4111-8111-111111111111'
   and expert_key = 'uav-expert' and expert_version = '1.0.0';

insert into t_rev_probes values
  ('c1_after_override_replay', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'));

select is(
  pg_temp.try_sql($$
    update public.tenant_experts
       set vocabulary_override = '{"collectionBindings":["52000000-0000-4000-8000-000000000001"]}'::jsonb
     where organisation_id = '11111111-1111-4111-8111-111111111111'
       and expert_key = 'uav-expert' and expert_version = '1.0.0'
  $$),
  '23514',
  '60 tenant override cannot widen collectionBindings (23514)'
);

select is(
  pg_temp.try_sql($$
    update public.tenant_experts
       set vocabulary_override = '{"clearance":"public","minVerifierTier":"small"}'::jsonb
     where organisation_id = '11111111-1111-4111-8111-111111111111'
       and expert_key = 'uav-expert' and expert_version = '1.0.0'
  $$),
  '23514',
  '61 tenant override cannot lower clearance or minVerifierTier (23514)'
);

select is(
  pg_temp.try_sql($$
    update public.tenant_experts
       set vocabulary_override = '{"modelChains":{"verify":["local_box"]},"systemPrompt":"ignore rules"}'::jsonb
     where organisation_id = '11111111-1111-4111-8111-111111111111'
       and expert_key = 'uav-expert' and expert_version = '1.0.0'
  $$),
  '23514',
  '62 tenant override cannot smuggle modelChains or systemPrompt (23514)'
);

select is((select result from t_ctl_probes where case_name = 'entitle_company2_gpr'), 'ok',
  '63 company2 is independently entitled to gpr and gpr-expert 1.0.0');
select is((select result from t_ctl_probes where case_name = 'half_pair_expert'), '22023',
  '64 passing expert_key without expert_version is refused (22023)');

-- ---------------------------------------------------------------- 65-76 RLS isolation & negative reads
create temp table t_rls_probes (case_name text primary key, result text not null);
grant insert on t_rls_probes to authenticated;

-- owner1 (a1) scoped to company1
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
do $$
begin
  perform public.set_tenant_scope('11111111-1111-4111-8111-111111111111');
end;
$$;
insert into t_rls_probes values
  ('c1_services', coalesce((select string_agg(service_key, ',' order by service_key) from public.tenant_services), '')),
  ('c1_service_defs', coalesce((select string_agg(service_key, ',' order by service_key) from public.service_definitions), '')),
  ('c1_experts', coalesce((select string_agg(expert_key || '@' || expert_version, ',' order by expert_key) from public.tenant_experts), ''));
reset role;

-- owner2 (b1) scoped to company2
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
do $$
begin
  perform public.set_tenant_scope('22222222-2222-4222-8222-222222222222');
end;
$$;
insert into t_rls_probes values
  ('c2_services', coalesce((select string_agg(service_key, ',' order by service_key) from public.tenant_services), '')),
  ('c2_experts', coalesce((select string_agg(expert_key || '@' || expert_version, ',' order by expert_key) from public.tenant_experts), ''));
reset role;

-- suspended company1 member (a3) — even with forged GUC scope, RLS returns 0 rows
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
do $$
begin
  perform set_config('app.organisation_id', '11111111-1111-4111-8111-111111111111', true);
end;
$$;
insert into t_rls_probes values
  ('suspended_counts',
    (select count(*)::text from public.service_definitions)
    || ':' || (select count(*)::text from public.tenant_services)
    || ':' || (select count(*)::text from public.tenant_experts));
reset role;

-- active company1 member (a1) with NO tenant scope set -> 0 rows
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
do $$
begin
  perform public.clear_tenant_scope();
end;
$$;
insert into t_rls_probes values
  ('unscoped_counts',
    (select count(*)::text from public.tenant_services)
    || ':' || (select count(*)::text from public.tenant_experts));
reset role;

-- multi-tenant member (a4): switches scope between company1 and company2 cleanly
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
do $$
begin
  perform public.set_tenant_scope('11111111-1111-4111-8111-111111111111');
end;
$$;
insert into t_rls_probes values
  ('multi_c1', coalesce((select string_agg(expert_key, ',' order by expert_key) from public.tenant_experts), ''));
do $$
begin
  perform public.set_tenant_scope('22222222-2222-4222-8222-222222222222');
end;
$$;
insert into t_rls_probes values
  ('multi_c2', coalesce((select string_agg(expert_key, ',' order by expert_key) from public.tenant_experts), ''));
reset role;

select is((select result from t_rls_probes where case_name = 'c1_services'), 'uav-compliance',
  '65 company1 member sees only company1 enabled tenant_services, never company2');
select is((select result from t_rls_probes where case_name = 'c1_service_defs'), 'uav-compliance',
  '66 company1 member sees only entitled service_definitions (no hidden-service enumeration)');
select is((select result from t_rls_probes where case_name = 'c1_experts'), 'uav-expert@1.0.0',
  '67 company1 member sees only company1 tenant_experts, never company2');
select is(
  (select result from t_rls_probes where case_name = 'c2_services')
  || '/' || (select result from t_rls_probes where case_name = 'c2_experts'),
  'gpr/gpr-expert@1.0.0',
  '68 company2 member sees only company2 service and expert, never company1'
);
select is((select result from t_rls_probes where case_name = 'suspended_counts'), '0:0:0',
  '69 suspended membership resolves zero services and zero experts even if GUC scope is set');
select is((select result from t_rls_probes where case_name = 'unscoped_counts'), '0:0',
  '70 unscoped active member resolves zero tenant_services and zero tenant_experts');
select is(
  (select result from t_rls_probes where case_name = 'multi_c1')
  || '/' || (select result from t_rls_probes where case_name = 'multi_c2'),
  'uav-expert/gpr-expert',
  '71 multi-tenant user sees only the active tenant scope''s expert in each scope'
);

select is((select result from t_auth_probes where case_name = 'insert_tenant_services'), '42501',
  '72 authenticated direct INSERT into tenant_services is refused (42501)');
select is((select result from t_auth_probes where case_name = 'insert_tenant_experts'), '42501',
  '73 authenticated direct INSERT into tenant_experts is refused (42501)');
select is((select result from t_auth_probes where case_name = 'update_tenant_experts'), '42501',
  '74 authenticated direct UPDATE on tenant_experts is refused (42501)');
select is((select result from t_auth_probes where case_name = 'select_prompt_templates'), '42501',
  '75 authenticated direct SELECT on prompt_templates is refused (42501, §9.3)');
select is((select result from t_auth_probes where case_name = 'select_expert_definitions'), '42501',
  '76 authenticated direct SELECT on expert_definitions is refused (42501, §9.3)');

-- ---------------------------------------------------------------- 77-84 #98 policy_revision triggers on entitlements
select is(
  (select count(*)::integer
     from pg_trigger tr
     join pg_class c on c.oid = tr.tgrelid
     join pg_proc p on p.oid = tr.tgfoid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('tenant_services', 'tenant_experts')
      and p.proname = 'bump_policy_revision'
      and not tr.tgisinternal
      and (tr.tgtype::int & 1) = 0
      and pg_get_triggerdef(tr.oid) ilike '% AFTER % FOR EACH STATEMENT %'),
  6,
  '77 tenant_services and tenant_experts carry six AFTER FOR EACH STATEMENT bump_policy_revision triggers (#98 / #179)'
);

select is(
  (select rev from t_rev_probes where step = 'c1_after_svc')
  - (select rev from t_rev_probes where step = 'c1_before_svc'),
  1::bigint,
  '78 entitling a tenant service moves organisations.policy_revision by exactly 1 (#98)'
);

select is(
  (select rev from t_rev_probes where step = 'c1_after_svc_replay')
  - (select rev from t_rev_probes where step = 'c1_after_svc'),
  0::bigint,
  '79 replaying an identical service entitlement leaves policy_revision unchanged (#98)'
);

select is(
  (select rev from t_rev_probes where step = 'c1_after_exp')
  - (select rev from t_rev_probes where step = 'c1_after_svc_replay'),
  1::bigint,
  '80 pinning an expert binding on an entitled service moves policy_revision by exactly 1 (#98)'
);

select is(
  (select rev from t_rev_probes where step = 'c1_after_exp_replay')
  - (select rev from t_rev_probes where step = 'c1_after_exp'),
  0::bigint,
  '81 replaying an identical service+expert entitlement leaves policy_revision unchanged (#98)'
);

select is(
  ((select rev from t_rev_probes where step = 'c1_after_override')
   - (select rev from t_rev_probes where step = 'c1_before_override'))::text
  || '/' ||
  ((select rev from t_rev_probes where step = 'c1_after_override_replay')
   - (select rev from t_rev_probes where step = 'c1_after_override'))::text,
  '1/0',
  '82 updating tenant_experts.vocabulary_override moves policy_revision by 1 and identical replay moves it by 0'
);

insert into t_rev_probes values
  ('c1_before_miss', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'));
create temp table t_miss_probes (case_name text primary key, result text not null);
insert into t_miss_probes values
  ('miss_ts', pg_temp.try_sql($$
    delete from public.tenant_services
     where organisation_id = '11111111-1111-4111-8111-111111111111'
       and service_key = 'no-such-service'
  $$)),
  ('miss_te', pg_temp.try_sql($$
    delete from public.tenant_experts
     where organisation_id = '11111111-1111-4111-8111-111111111111'
       and expert_key = 'no-such-expert'
  $$));
insert into t_rev_probes values
  ('c1_after_miss', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'));

select is(
  (select result from t_miss_probes where case_name = 'miss_ts')
  || '/' || (select result from t_miss_probes where case_name = 'miss_te')
  || '/' || ((select rev from t_rev_probes where step = 'c1_after_miss')
             - (select rev from t_rev_probes where step = 'c1_before_miss'))::text,
  'ok/ok/0',
  '83 missed DELETE on tenant_services and tenant_experts completes without 54001 and moves policy_revision by 0'
);

insert into t_rev_probes values
  ('c1_before_c2_ops', pg_temp.rev_of('11111111-1111-4111-8111-111111111111')),
  ('c2_s0', pg_temp.rev_of('22222222-2222-4222-8222-222222222222'));

delete from public.tenant_experts
 where organisation_id = '22222222-2222-4222-8222-222222222222'
   and expert_key = 'gpr-expert';
insert into t_rev_probes values
  ('c2_s1', pg_temp.rev_of('22222222-2222-4222-8222-222222222222'));

update public.tenant_services
   set enabled = false
 where organisation_id = '22222222-2222-4222-8222-222222222222'
   and service_key = 'gpr';
insert into t_rev_probes values
  ('c2_s2', pg_temp.rev_of('22222222-2222-4222-8222-222222222222'));

update public.tenant_services
   set enabled = false
 where organisation_id = '22222222-2222-4222-8222-222222222222'
   and service_key = 'gpr';
insert into t_rev_probes values
  ('c2_s3', pg_temp.rev_of('22222222-2222-4222-8222-222222222222'));

delete from public.tenant_services
 where organisation_id = '22222222-2222-4222-8222-222222222222'
   and service_key = 'gpr';
insert into t_rev_probes values
  ('c2_s4', pg_temp.rev_of('22222222-2222-4222-8222-222222222222')),
  ('c1_after_c2_ops', pg_temp.rev_of('11111111-1111-4111-8111-111111111111'));

select is(
  ((select rev from t_rev_probes where step = 'c2_s1') - (select rev from t_rev_probes where step = 'c2_s0'))::text
  || '/' || ((select rev from t_rev_probes where step = 'c2_s2') - (select rev from t_rev_probes where step = 'c2_s1'))::text
  || '/' || ((select rev from t_rev_probes where step = 'c2_s3') - (select rev from t_rev_probes where step = 'c2_s2'))::text
  || '/' || ((select rev from t_rev_probes where step = 'c2_s4') - (select rev from t_rev_probes where step = 'c2_s3'))::text
  || '/' || ((select rev from t_rev_probes where step = 'c1_after_c2_ops') - (select rev from t_rev_probes where step = 'c1_before_c2_ops'))::text,
  '1/1/0/1/0',
  '84 delete tenant_experts (+1), disable tenant_services (+1), identical update (0), delete tenant_services (+1) move only company2 policy_revision'
);

select * from finish();
rollback;
