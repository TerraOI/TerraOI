-- T-301 - TerraOI forms: versioned templates, private drafts, submissions that become knowledge.
-- pgTAP slot 080 is this packet's (docs/COORDINATION.md 6b). Plan 7.6 steps 1-4 and 15.0 (two to
-- three seeded forms), F33 over T-112/T-113's capture path; #51 (body_text is written at capture
-- for text-like payloads) and #39 (the merged capture predicate: active membership + project
-- audience + knowledge.write at write or admin).
--
-- Written BEFORE the migration (AGENTS.md 5.2): this file is red until `20261117*_forms.sql`
-- lands, and after that it is the definition of the behaviour.
--
-- Fixtures are supabase/seed.sql: company1 11111111-1111-4111-8111-111111111111 (...a1 owner and
-- admin, ...a2 member with no knowledge.write, ...a3 suspended membership, ...a4 member of both
-- tenants and of project site-a) and company2 22222222-2222-4222-8222-222222222222 (...b1 owner).
-- Collections: 51000000-0000-4000-8000-000000000001 tenant-wide public, 51000000-0000-4000-8000-
-- 000000000002 project site-a client_confidential, 52000000-0000-4000-8000-000000000001 company2
-- public. The three seeded templates are added by this PR; no test here inserts seed rows
-- (AGENTS.md 4.2), so no other slot's counts move.
--
-- auth.uid() only resolves for a real JWT, so every identity case runs in CI's `database` job.

begin;
create extension if not exists pgtap with schema extensions;
select plan(67);

-- ---------------------------------------------------------------- probes: SQLSTATE or a value
create function pg_temp.try_draft(
  p_organisation_id uuid, p_template_id uuid, p_template_version text, p_values jsonb,
  p_supersedes uuid default null
) returns text language plpgsql security invoker as $fn$
begin
  begin
    return public.save_form_draft_v1(p_organisation_id, p_template_id, p_template_version,
                                     p_values, p_supersedes)::text;
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_submit(p_organisation_id uuid, p_submission_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    return public.submit_form_v1(p_organisation_id, p_submission_id)::text;
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- A hand-written insert, to test the composite FK the RPCs never exercise (AGENTS.md 4.1: the
-- schema itself must make a cross-tenant row impossible, not only the RPC).
create function pg_temp.try_raw_submission(
  p_organisation_id uuid, p_template_id uuid, p_template_version text, p_created_by uuid
) returns text language plpgsql security invoker as $fn$
begin
  begin
    insert into public.form_submissions
      (organisation_id, template_id, template_version, created_by, state, values_json)
      values (p_organisation_id, p_template_id, p_template_version, p_created_by, 'draft',
              '{"airframe_check": "synthetic"}'::jsonb);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;


-- ------------------------------------------------------------------------ 1..16 shape and grants
select has_table('public', 'form_templates',
  '1 form_templates exists: a template is versioned content with a path into retrieval (7.6)');
select has_table('public', 'form_submissions',
  '2 form_submissions exists: a submission is a knowledge capture, not an app-side blob (F33)');
select has_index('public', 'form_templates', 'form_templates_tenant_id_key',
  '3 (id, organisation_id) is unique so a child can name both columns and cannot cross tenants (4.1)');
select has_index('public', 'form_submissions', 'form_submissions_tenant_id_key',
  '4 the same anti-cross-tenant key on the submission side');
select has_column('public', 'form_submissions', 'template_version',
  '5 the validated template version is stored on the row, never re-resolved from the newest one (16)');
select has_column('public', 'form_submissions', 'body_text',
  '6 the rendered text representation, written at capture (#51 option 1)');
select has_column('public', 'form_submissions', 'source_version_id',
  '7 the submission points at the source version it produced: forms reuse the pipeline (TOI-ADR-16)');
select has_column('public', 'form_submissions', 'supersedes_submission_id',
  '8 a correction links a new submission to the old one instead of editing it (7.6 step 4)');
select has_function('public', 'save_form_draft_v1',
  array['uuid', 'uuid', 'text', 'jsonb', 'uuid'],
  '9 save_form_draft_v1 takes p_organisation_id first, like every scoped RPC (FAQ-0011)');
select has_function('public', 'submit_form_v1', array['uuid', 'uuid'],
  '10 submit_form_v1 is scoped the same way');
select has_function_privilege('authenticated', 'public.save_form_draft_v1(uuid,uuid,text,jsonb,uuid)', 'execute',
  '11 the request role may call the draft RPC');
select hasnt_function_privilege('anon', 'public.submit_form_v1(uuid,uuid)', 'execute',
  '12 anon cannot submit: a submission is an employee action (4.2)');
select has_table_privilege('authenticated', 'public.form_templates', 'select',
  '13 templates are readable through RLS, so the shell can render one');
select hasnt_table_privilege('authenticated', 'public.form_templates', 'insert',
  '14 templates are not writable by the request role: only platform seeds and later admin RPCs (7.6)');

-- ------------------------------------------------------------------- 15..16 the seeded catalogue
select is((select count(*) from public.form_templates), 3::bigint,
  '15 three seeded templates: plan 15.0 says two to three, and 7.6 wants one per expert service');
select is_empty($q$select id from public.form_templates
                  where scope <> 'platform' or status <> 'published' or published_at is null$q$,
  '16 every seed is a published platform template, the only M1 authoring path (15.0)');

-- ------------------------------------------------------------- 17..26 drafts against one version
-- Seeded ids: 80000000-0000-4000-8000-000000000001 UAV pre-flight (company1, tenant-wide public
-- collection); ...002 Site observation note (company1, project site-a, client_confidential);
-- ...003 GPR field log (company2).
-- As the owner of company1: ...a1 is an admin, so it holds knowledge.write and may publish into the
-- tenant-wide collection (#39's predicate: membership + audience + knowledge.write). The pg_temp
-- table is created under this role so the role can write its own probe results (025's shape).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
create table pg_temp.drafts (tag text primary key, result text);

insert into pg_temp.drafts (tag, result) values
  ('a1_uav', pg_temp.try_draft('11111111-1111-4111-8111-111111111111',
                                '80000000-0000-4000-8000-000000000001', 'v1',
                                '{"airframe_check": "tether and props checked", "battery_pct": 92,'
                                || ' "weather_notes": "wind 4 m/s, synthetic"}')),
  ('a1_uav_badtype', pg_temp.try_draft('11111111-1111-4111-8111-111111111111',
                                '80000000-0000-4000-8000-000000000001', 'v1',
                                '{"airframe_check": "synthetic", "battery_pct": "full",'
                                || ' "weather_notes": "synthetic"}')),
  ('a1_uav_missing', pg_temp.try_draft('11111111-1111-4111-8111-111111111111',
                                '80000000-0000-4000-8000-000000000001', 'v1',
                                '{"airframe_check": "synthetic"}')),
  ('a1_uav_unknown', pg_temp.try_draft('11111111-1111-4111-8111-111111111111',
                                '80000000-0000-4000-8000-000000000001', 'v1',
                                '{"airframe_check": "synthetic", "battery_pct": 92,'
                                || ' "weather_notes": "synthetic", "sql": "drop table things"}')),
  ('a1_uav_oversize', pg_temp.try_draft('11111111-1111-4111-8111-111111111111',
                                '80000000-0000-4000-8000-000000000001', 'v1',
                                jsonb_build_object('airframe_check', repeat('x', 4000),'battery_pct', 92,
                                                   'weather_notes', 'synthetic'))),
  ('a1_uav_version', pg_temp.try_draft('11111111-1111-4111-8111-111111111111',
                                '80000000-0000-4000-8000-000000000001', 'v0',
                                '{"airframe_check": "synthetic", "battery_pct": 92,'
                                || ' "weather_notes": "synthetic"}'));

select isnt_null((select result::uuid from pg_temp.drafts where tag = 'a1_uav'),
  '17 an owner with knowledge.write can open a draft against the published version');
select is((select state from public.form_submissions
            where id = (select result::uuid from pg_temp.drafts where tag = 'a1_uav')), 'draft',
  '18 a draft is a draft: it is not yet a source version (7.6 step 3)');
select is((select source_version_id is null and body_text is null from public.form_submissions
            where id = (select result::uuid from pg_temp.drafts where tag = 'a1_uav')), true,
  '19 nothing is rendered or captured until submit, so a draft cannot reach retrieval yet');
select is((select count(*) from public.form_submissions), 1::bigint,
  '20 the four rejected drafts created nothing: validation is not a warning (7.6)');
select is((select result from pg_temp.drafts where tag = 'a1_uav_badtype'), '22023',
  '21 a value of the wrong type fails validation against the exact template version');
select is((select result from pg_temp.drafts where tag = 'a1_uav_missing'), '22023',
  '22 a missing required field is refused, not stored half-filled');
select is((select result from pg_temp.drafts where tag = 'a1_uav_unknown'), '22023',
  '23 a field the schema does not declare is refused: a submission cannot invent a column');
select is((select result from pg_temp.drafts where tag = 'a1_uav_oversize'), '22023',
  '24 an oversized value is refused at the boundary, not truncated on the way in');
select is((select result from pg_temp.drafts where tag = 'a1_uav_version'), '22023',
  '25 a draft must name a version that exists; the version is never guessed (16 Forms/OCR row)');
select is((select values_json ->> 'battery_pct' from public.form_submissions
            where id = (select result::uuid from pg_temp.drafts where tag = 'a1_uav')), '92',
  '26 values are stored as JSON as written, so a form_field citation addresses a stored value (7.6)');


-- --------------------------------------------------------------------- 27..34 tenancy and scope
-- company2's owner tries company1's template. The scope argument is honoured, so the template is
-- simply not in scope: 42501, never "not found" with a different tenant's row (4.1).
insert into pg_temp.drafts (tag, result) values
  ('b1_company1_template', pg_temp.try_draft('22222222-2222-4222-8222-222222222222',
                                '80000000-0000-4000-8000-000000000001', 'v1',
                                '{"airframe_check": "synthetic", "battery_pct": 92,'
                                || ' "weather_notes": "synthetic"}')),
  ('a1_as_company2', pg_temp.try_draft('22222222-2222-4222-8222-222222222222',
                                '80000000-0000-4000-8000-000000000003', 'v1',
                                '{"line_id": "L1", "passes": 3}'));

select is((select result from pg_temp.drafts where tag = 'b1_company1_template'), '42501',
  '27 a company2 member cannot draft on a company1 template, even with a valid company2 scope');
select is((select result from pg_temp.drafts where tag = 'a1_as_company2'), '28000',
  '28 a company1 member cannot take a company2 scope at all: the scope is checked, not assumed (4.1)');

-- ...a4 belongs to both tenants: the scope argument selects the tenant, membership allows it, and
-- the visible template catalogue follows.
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
select set_tenant_scope('11111111-1111-4111-8111-111111111111');
select is((select count(*) from public.form_templates), 2::bigint,
  '29 scoped to company1, a dual member sees company1 templates only');
select set_tenant_scope('22222222-2222-4222-8222-222222222222');
select is((select count(*) from public.form_templates), 1::bigint,
  '30 the same person scoped to company2 sees one template: the same id in both tenants is not a leak');
select isnt_null(pg_temp.try_draft('22222222-2222-4222-8222-222222222222',
                                   '80000000-0000-4000-8000-000000000003', 'v1',
                                   '{"line_id": "L1", "passes": 3}'),
  '31 a member of the second tenant can draft in it: nothing about the first tenant leaks in');

-- The schema, not only the RPC, must make a cross-tenant row impossible: a hand-built insert with
-- company2's organisation and company1's template is refused by the composite FK (4.1).
reset role;
select is(pg_temp.try_raw_submission('22222222-2222-4222-8222-222222222222',
                                     '80000000-0000-4000-8000-000000000001', 'v1',
                                     '00000000-0000-4000-8000-0000000000b1'), '23503',
  '32 the (template_id, organisation_id) composite FK refuses a cross-tenant submission outright');
select is(pg_temp.try_raw_submission('22222222-2222-4222-8222-222222222222',
                                     '80000000-0000-4000-8000-000000000003', 'v1',
                                     '00000000-0000-4000-8000-0000000000b1'), 'ok',
  '33 the same insert with matching columns works, so 32 tests the pairing and not a typo');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
select set_tenant_scope('22222222-2222-4222-8222-222222222222');
select is((select count(*) from public.form_submissions
            where organisation_id = '11111111-1111-4111-8111-111111111111'), 0::bigint,
  '34 a company2 member sees no company1 submission row, draft or submitted (4.2 negative)');


-- --------------------------------------------------------------- 35..46 submit becomes knowledge
-- Back to company1's admin, whose draft 'a1_uav' is still open. Baselines first: the seed holds
-- knowledge fixtures, so every pipeline count below is a delta, not an absolute (020's rows move
-- if another packet seeds anything).
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
create table pg_temp.baseline (sources bigint, versions bigint, outbox bigint);
insert into pg_temp.baseline
  select (select count(*) from public.knowledge_sources
           where organisation_id = '11111111-1111-4111-8111-111111111111'),
         (select count(*) from public.source_versions
           where organisation_id = '11111111-1111-4111-8111-111111111111'),
         (select count(*) from public.outbox_events);

select is(pg_temp.try_submit('11111111-1111-4111-8111-111111111111',
          (select result::uuid from pg_temp.drafts where tag = 'a1_uav')),
          (select result from pg_temp.drafts where tag = 'a1_uav'),
  '35 submit_form_v1 returns the submission it captured, so the caller can cite it immediately');
select is((select count(*) from public.knowledge_sources
            where organisation_id = '11111111-1111-4111-8111-111111111111'),
          (select sources + 1 from pg_temp.baseline),
  '36 exactly one source: a submission is a source of knowledge, not an attachment (TOI-ADR-16)');
select is((select count(*) from public.source_versions
            where organisation_id = '11111111-1111-4111-8111-111111111111'),
          (select versions + 1 from pg_temp.baseline),
  '37 exactly one source version in the same transaction: no half-captured form (F33)');
select is((select count(*) from public.outbox_events), (select outbox + 1 from pg_temp.baseline),
  '38 exactly one outbox event: the pipeline learns of it once, from the trigger, not twice');
select is((select o.event_type from public.outbox_events o
            order by o.id desc limit 1), 'knowledge.source_version.received',
  '39 the event is the one every other capture path raises, so no new pipeline path is invented');
select is((select v.state from public.source_versions v
            order by v.created_at desc, v.id desc limit 1), 'received',
  '40 capture lands at received, never published: review is a later stage (7.2 step 5)');
select is((select v.body_text is not null and v.payload is not null from public.source_versions v
            order by v.created_at desc, v.id desc limit 1), true,
  '41 the version carries rendered text and the structured values together (#51 option 1)');
select is((select v.body_text from public.source_versions v
            order by v.created_at desc, v.id desc limit 1),
          'airframe_check: tether and props checked' || E'\n' || 'battery_pct: 92' || E'\n'
          || 'weather_notes: wind 4 m/s, synthetic',
  '42 the rendered text is deterministic field-by-field, which is what a chunk can be cited against');
select is((select v.content_hash ~ '^[0-9a-f]{64}$' from public.source_versions v
            order by v.created_at desc, v.id desc limit 1), true,
  '43 a content hash exists for a form too: content identity is per collection, forms included (B3)');
select is((select v.data_class from public.source_versions v
            order by v.created_at desc, v.id desc limit 1),
          (select c.data_class from public.knowledge_collections c
            where c.id = '51000000-0000-4000-8000-000000000001'),
  '44 the class comes from the collection and never goes down (6.2)');
select is((select state || '/' || template_version from public.form_submissions
            where id = (select result::uuid from pg_temp.drafts where tag = 'a1_uav')),
          'submitted/v1',
  '45 the submission is immutable and records the version it was validated against');
select is(pg_temp.try_submit('11111111-1111-4111-8111-111111111111',
          (select result::uuid from pg_temp.drafts where tag = 'a1_uav')), '22023',
  '46 a replayed submit is refused: one submission, one source version, even on retry');


-- ---------------------------------------------------------- 47..54 who may draft and who may submit
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into pg_temp.drafts (tag, result) values
  ('a2_uav', pg_temp.try_draft('11111111-1111-4111-8111-111111111111',
                                '80000000-0000-4000-8000-000000000001', 'v1',
                                '{"airframe_check": "synthetic", "battery_pct": 70,'
                                || ' "weather_notes": "synthetic"}')),
  ('a2_site_a', pg_temp.try_draft('11111111-1111-4111-8111-111111111111',
                                '80000000-0000-4000-8000-000000000002', 'v1',
                                '{"location": "synthetic", "observation": "synthetic"}'));

select isnt_null((select result from pg_temp.drafts where tag = 'a2_uav')::uuid,
  '47 a plain member may open a draft: filling a form is not publishing (7.6 step 2)');
select is((select result from pg_temp.drafts where tag = 'a2_site_a'), '42501',
  '48 a Site A template refuses a submitter outside Site A: audience is the collection''s (T-214)');
select is(pg_temp.try_submit('11111111-1111-4111-8111-111111111111',
          (select result::uuid from pg_temp.drafts where tag = 'a2_uav')), '42501',
  '49 submitting needs the merged publish predicate: a member without knowledge.write is refused (#39)');
select is((select count(*) from public.form_submissions
            where created_by = '00000000-0000-4000-8000-0000000000a2'), 1::bigint,
  '50 the author still sees their own draft');

set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is((select count(*) from public.form_submissions
            where created_by = '00000000-0000-4000-8000-0000000000a2'), 0::bigint,
  '51 an admin in the same tenant cannot read a colleague''s draft: drafts are private (7.6 step 2)');
select isnt_null(pg_temp.try_draft('11111111-1111-4111-8111-111111111111',
                                   '80000000-0000-4000-8000-000000000002', 'v1',
                                   '{"location": "synthetic", "observation": "synthetic"}'),
  '52 a Site A member may draft on the project-scoped client_confidential template');

set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
select is(pg_temp.try_draft('11111111-1111-4111-8111-111111111111',
                            '80000000-0000-4000-8000-000000000001', 'v1',
                            '{"airframe_check": "synthetic", "battery_pct": 10,'
                            || ' "weather_notes": "synthetic"}'), '28000',
  '53 a suspended membership cannot open a draft at all (4.2 negative: deactivated member)');
select is((select count(*) from public.form_templates), 0::bigint,
  '54 a suspended membership reads no templates either: the catalogue is membership-scoped too');

-- ------------------------------------------------------------------- 55..60 immutability, links
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
create function pg_temp.try_update_submission(p_submission_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.form_submissions set values_json = '{"airframe_check": "rewritten"}'::jsonb
      where id = p_submission_id;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

select is(pg_temp.try_update_submission((select result::uuid from pg_temp.drafts where tag = 'a1_uav')),
          '42501',
  '55 a submitted row cannot be edited in place, not even by its author: corrections are versions (4.1)');
insert into pg_temp.drafts (tag, result) values
  ('a1_fix', pg_temp.try_draft('11111111-1111-4111-8111-111111111111',
                                '80000000-0000-4000-8000-000000000001', 'v1',
                                '{"airframe_check": "tether and props checked, corrected",'
                                || ' "battery_pct": 92, "weather_notes": "wind 4 m/s, synthetic"}',
                                (select result::uuid from pg_temp.drafts where tag = 'a1_uav'))),
  ('a1_fix_foreign', pg_temp.try_draft('11111111-1111-4111-8111-111111111111',
                                '80000000-0000-4000-8000-000000000001', 'v1',
                                '{"airframe_check": "synthetic", "battery_pct": 92,'
                                || ' "weather_notes": "synthetic"}',
                                '99999999-9999-4999-8999-999999999999'));

select isnt_null((select result from pg_temp.drafts where tag = 'a1_fix')::uuid,
  '56 a correction opens as a new draft linked to the one it replaces (7.6 step 4)');
select is((select result from pg_temp.drafts where tag = 'a1_fix_foreign'), '42501',
  '57 a correction cannot point at a submission from another tenant, even by guessed uuid');
select isnt_null(pg_temp.try_submit('11111111-1111-4111-8111-111111111111',
                                    (select result::uuid from pg_temp.drafts where tag = 'a1_fix')),
  '58 the correction submits: the corrected field values are citable as form_field evidence');
select is((select supersedes_submission_id = (select result::uuid from pg_temp.drafts
                                               where tag = 'a1_uav')
            from public.form_submissions
            where id = (select result::uuid from pg_temp.drafts where tag = 'a1_fix')), true,
  '59 the new submission names the old one, so the history is walkable');
select is((select state || '/' || values_json ->> 'airframe_check' from public.form_submissions
            where id = (select result::uuid from pg_temp.drafts where tag = 'a1_uav')),
          'submitted/tether and props checked',
  '60 the superseded submission keeps its own values: nothing is rewritten in place');


-- ------------------------------------------------- 61 a re-versioned or retired template mid-draft
insert into pg_temp.drafts (tag, result) values
  ('a1_late', pg_temp.try_draft('11111111-1111-4111-8111-111111111111',
                                 '80000000-0000-4000-8000-000000000001', 'v1',
                                 '{"airframe_check": "synthetic", "battery_pct": 88,'
                                 || ' "weather_notes": "synthetic"}'));
reset role;
update public.form_templates set status = 'retired'
  where id = '80000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_submit('11111111-1111-4111-8111-111111111111',
                             (select result::uuid from pg_temp.drafts where tag = 'a1_late')),
          '22023',
  '61 a draft opened before the template was retired is refused by name of that version: never '
  || 'silently re-validated against a newer one (16 Forms/OCR row)');

-- ----------------------------------------------------- 62..67 untrusted template content at write
-- A template is untrusted content with a path into retrieval (4.8), so the guard lives in the
-- schema as well as in the contract: these inserts are hand-built and must never be storable.
create function pg_temp.try_raw_template(p_json_schema jsonb, p_ui_hints jsonb, p_data_class text)
returns text language plpgsql security invoker as $fn$
begin
  begin
    insert into public.form_templates
      (organisation_id, scope, service_key, name, version, json_schema, ui_hints,
       default_collection_id, data_class, status, published_at)
      values ('11111111-1111-4111-8111-111111111111', 'platform', 'uav-compliance',
              'Synthetic probe template', 'v9', p_json_schema, p_ui_hints,
              '51000000-0000-4000-8000-000000000001', p_data_class, 'published', now());
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

select is(pg_temp.try_raw_template(
            '{"type": "object", "properties": {"note": {"type": "string", "href": '
            || '"https://example.invalid/x"}}}'::jsonb, '{}'::jsonb, 'public'), '23514',
  '62 a template holding a remote URL is refused at write (7.6, 4.8)');
select is(pg_temp.try_raw_template(
            '{"type": "object", "properties": {"note": {"type": "string"}}, "$ref": '
            || '"https://example.invalid/schema.json"}'::jsonb, '{}'::jsonb, 'public'), '23514',
  '63 a $ref is refused: a template may not pull in a schema it does not contain');
select is(pg_temp.try_raw_template(
            '{"type": "object", "properties": {"note": {"type": "string", "default": '
            || '"<script>alert(1)</script>"}}}'::jsonb, '{}'::jsonb, 'public'), '23514',
  '64 markup in a default is refused: the renderer never evaluates template content');
select is(pg_temp.try_raw_template(
            '{"type": "object", "properties": {"note": {"type": "string"}}}'::jsonb,
            '{"note": {"css": "body{display:none}"}}'::jsonb, 'public'), '23514',
  '65 a CSS key in the UI hints is refused: hints are whitelisted, not free-form (7.6)');
select is(pg_temp.try_raw_template(
            '{"type": "object", "properties": {"note": {"type": "string"}}}'::jsonb,
            '{"note": {"placeholder": "https://example.invalid"}}'::jsonb, 'public'), '23514',
  '66 a remote URL in a hint is refused too: the whitelist is not the only check (4.8)');
select is(pg_temp.try_raw_template(
            '{"type": "object", "properties": {"note": {"type": "string"}}}'::jsonb,
            '{}'::jsonb, 'restricted'), '23514',
  '67 restricted is not representable on a form template in M1 (12.4, isIngestibleInM1)');

select * from finish();
rollback;
