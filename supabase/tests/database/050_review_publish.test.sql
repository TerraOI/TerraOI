-- T-213 PR-1: review / publish / revoke (F13/F14). Slot 050 (COORDINATION.md §6b).
-- Does not consume T-104 derived-output invalidation.
begin;
create extension if not exists pgtap with schema extensions;

select plan(28);

-- ---------------------------------------------------------------- helpers
create function pg_temp.try_scope(p_organisation_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.set_tenant_scope(p_organisation_id);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_review(
  p_organisation_id uuid, p_version uuid, p_decision text, p_reason text
) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.review_decision_v1(p_organisation_id, p_version, p_decision, p_reason);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_publish(p_organisation_id uuid, p_version uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.publish_knowledge_version_v1(p_organisation_id, p_version);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_revoke(p_organisation_id uuid, p_source uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform public.revoke_source_v1(p_organisation_id, p_source, 'test revoke');
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Publisher role for field member a2 (write) — same pattern as 040.
insert into public.organisation_roles (id, organisation_id, key, name) values
  ('31000000-0000-4000-8000-0000000000r1', '11111111-1111-4111-8111-111111111111', 'publisher', 'Knowledge publisher')
on conflict (organisation_id, key) do nothing;
insert into public.role_permissions (organisation_id, role_id, area, level) values
  ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-0000000000r1', 'knowledge.write', 'write')
on conflict (role_id, area) do nothing;
insert into public.membership_roles (organisation_id, membership_id, role_id)
select m.organisation_id, m.id, '31000000-0000-4000-8000-0000000000r1'::uuid
  from public.organisation_memberships m
 where m.user_id = '00000000-0000-4000-8000-0000000000a2'
   and m.organisation_id = '11111111-1111-4111-8111-111111111111'
  and not exists (
    select 1 from public.membership_roles mr
     where mr.membership_id = m.id
       and mr.role_id = '31000000-0000-4000-8000-0000000000r1'
  );

-- Auto-publish internal notes collection (tenant-wide).
insert into public.knowledge_collections (
  id, organisation_id, key, service_key, project_id, name, data_class, auto_publish, review_independent
) values (
  '51000000-0000-4000-8000-0000000000ap',
  '11111111-1111-4111-8111-111111111111',
  'auto-notes', 'uav', null, 'Auto notes', 'internal', true, false
);

-- Source + awaiting_review version uploaded by a1 (owner) for independence tests.
insert into public.knowledge_sources (
  id, organisation_id, collection_id, kind, external_id, owner_user_id
) values (
  '61000000-0000-4000-8000-0000000000rv',
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-000000000001',
  'upload', 'synthetic-review-0001', '00000000-0000-4000-8000-0000000000a1'
);

insert into public.source_versions (
  id, organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
  content_hash, object_ref, state, parser_generation, body_text, published_at
) values (
  '71000000-0000-4000-8000-0000000000rv',
  '11111111-1111-4111-8111-111111111111',
  '61000000-0000-4000-8000-0000000000rv',
  '51000000-0000-4000-8000-000000000001',
  1,
  '00000000-0000-4000-8000-0000000000a1',
  'public',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-0000000000rv/v1.pdf',
  'awaiting_review', 'v1', null, null
);

insert into public.knowledge_chunks (
  id, organisation_id, source_version_id, chunk_index, locator, body_text, data_class, token_count
) values (
  '81000000-0000-4000-8000-0000000000rv',
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-0000000000rv',
  0,
  '{"page": 1}',
  'Synthetic review fixture: rotor clear of personnel during spool-up.',
  'public', 12
);

-- Force review_independent on the public manuals collection for independence pin.
update public.knowledge_collections
   set review_independent = true
 where id = '51000000-0000-4000-8000-000000000001';

-- Auto-publish note version (kind=note, internal, auto_publish collection).
insert into public.knowledge_sources (
  id, organisation_id, collection_id, kind, external_id, owner_user_id
) values (
  '61000000-0000-4000-8000-0000000000ap',
  '11111111-1111-4111-8111-111111111111',
  '51000000-0000-4000-8000-0000000000ap',
  'note', null, '00000000-0000-4000-8000-0000000000a2'
);

insert into public.source_versions (
  id, organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
  content_hash, object_ref, state, parser_generation, body_text, published_at
) values (
  '71000000-0000-4000-8000-0000000000ap',
  '11111111-1111-4111-8111-111111111111',
  '61000000-0000-4000-8000-0000000000ap',
  '51000000-0000-4000-8000-0000000000ap',
  1,
  '00000000-0000-4000-8000-0000000000a2',
  'internal',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-0000000000ap/v1.json',
  'awaiting_review', 'v1',
  'Synthetic auto-publish note body for T-213.',
  null
);

insert into public.knowledge_chunks (
  id, organisation_id, source_version_id, chunk_index, locator, body_text, data_class, token_count
) values (
  '81000000-0000-4000-8000-0000000000ap',
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-0000000000ap',
  0,
  '{"page": 1}',
  'Synthetic auto-publish note body for T-213.',
  'internal', 8
);

-- ---------------------------------------------------------------- 1-3 signatures / volatility / privileges
select has_function('public', 'review_decision_v1',
  array['uuid', 'uuid', 'text', 'text'],
  '1 review_decision_v1(uuid,uuid,text,text) exists');
select is((select provolatile from pg_proc
            where oid = 'public.review_decision_v1(uuid,uuid,text,text)'::regprocedure),
  'v', '2 review_decision_v1 is volatile (sets tenant scope)');
select is(has_function_privilege('authenticated',
  'public.review_decision_v1(uuid,uuid,text,text)', 'execute'), true,
  '3 authenticated may execute review_decision_v1');

-- ---------------------------------------------------------------- 4-6 independence + cross-tenant
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_review(
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-0000000000rv',
  'approve', null), '42501',
  '4 uploader cannot approve own version when review_independent (#8)');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
select is(pg_temp.try_review(
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-0000000000rv',
  'approve', null), '28000',
  '5 company2 owner cannot establish company1 scope to review');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
select is(pg_temp.try_review(
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-0000000000rv',
  'approve', null), '28000',
  '6 suspended membership cannot review');
reset role;

-- ---------------------------------------------------------------- 7-12 approve + publish by a2
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select is(pg_temp.try_review(
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-0000000000rv',
  'approve', 'looks good'), 'ok',
  '7 non-author publisher can approve');
select is(pg_temp.try_review(
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-0000000000rv',
  'approve', 'again'), 'ok',
  '8 duplicate approve is a no-op');
select is(pg_temp.try_publish(
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-0000000000rv'), 'ok',
  '9 publish after approve succeeds');
reset role;

select is((select state from public.source_versions
            where id = '71000000-0000-4000-8000-0000000000rv'), 'published',
  '10 version is published');
select is((select current_version_id from public.knowledge_sources
            where id = '61000000-0000-4000-8000-0000000000rv'),
  '71000000-0000-4000-8000-0000000000rv'::uuid,
  '11 source current_version_id points at the published version');
select is((select count(*)::int from public.knowledge_review_decisions
            where source_version_id = '71000000-0000-4000-8000-0000000000rv'), 1,
  '12 only one review decision row');

-- ---------------------------------------------------------------- 13-15 auto-publish note
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_publish(
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-0000000000ap'), 'ok',
  '13 auto_publish note publishes without a prior review decision');
reset role;

select is((select state from public.source_versions
            where id = '71000000-0000-4000-8000-0000000000ap'), 'published',
  '14 auto-published note is published');

-- Incomplete publish refused: strip chunks from a fresh awaiting_review copy via privileged path.
insert into public.source_versions (
  id, organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
  content_hash, object_ref, state, parser_generation, body_text, published_at
) values (
  '71000000-0000-4000-8000-0000000000ix',
  '11111111-1111-4111-8111-111111111111',
  '61000000-0000-4000-8000-0000000000ap',
  '51000000-0000-4000-8000-0000000000ap',
  2,
  '00000000-0000-4000-8000-0000000000a2',
  'internal',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-0000000000ap/v2.json',
  'awaiting_review', 'v1', 'incomplete', null
);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_publish(
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-0000000000ix'), '22023',
  '15 publish without chunks is refused (embedding incomplete)');
reset role;

-- ---------------------------------------------------------------- 16-22 revoke + search filter
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_revoke(
  '11111111-1111-4111-8111-111111111111',
  '61000000-0000-4000-8000-0000000000rv'), 'ok',
  '16 owner can revoke a published source');
select is(pg_temp.try_revoke(
  '11111111-1111-4111-8111-111111111111',
  '61000000-0000-4000-8000-0000000000rv'), 'ok',
  '17 duplicate revoke is a no-op');
reset role;

select is((select lifecycle_state from public.knowledge_sources
            where id = '61000000-0000-4000-8000-0000000000rv'), 'revoked',
  '18 source lifecycle is revoked');
select is((select state from public.source_versions
            where id = '71000000-0000-4000-8000-0000000000rv'), 'revoked',
  '19 published version is revoked');
select is((select current_version_id from public.knowledge_sources
            where id = '61000000-0000-4000-8000-0000000000rv'), null,
  '20 revoked source clears current_version_id');

-- search_corpus must not return the revoked version (state filter).
select is((
  select count(*)::int
    from public.knowledge_chunks c
    join public.source_versions v on v.id = c.source_version_id
    join public.knowledge_sources s on s.id = v.source_id
   where v.id = '71000000-0000-4000-8000-0000000000rv'
     and v.state = 'published'
     and s.lifecycle_state = 'active'
), 0, '21 revoked version is invisible to the published+active retrieval predicate');

-- ---------------------------------------------------------------- 22-25 confidential defaults + member without write
select is((select review_independent from public.knowledge_collections
            where id = '51000000-0000-4000-8000-000000000002'), true,
  '22 seeded client_confidential collection has review_independent');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
-- a4 is a member of company1 without knowledge.write in the seed (unless publisher was granted).
select is(pg_temp.try_review(
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-0000000000ix',
  'approve', null), '42501',
  '23 member without knowledge.write|admin cannot review');
reset role;

select is(has_function_privilege('anon',
  'public.publish_knowledge_version_v1(uuid,uuid)', 'execute'), false,
  '24 anon cannot execute publish_knowledge_version_v1');
select is(has_function_privilege('anon',
  'public.revoke_source_v1(uuid,uuid,text)', 'execute'), false,
  '25 anon cannot execute revoke_source_v1');

-- ---------------------------------------------------------------- 26-28 supersede prior on second publish
-- Re-open a new awaiting_review version on the auto-notes source after fixing chunks.
insert into public.knowledge_chunks (
  id, organisation_id, source_version_id, chunk_index, locator, body_text, data_class, token_count
) values (
  '81000000-0000-4000-8000-0000000000i2',
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-0000000000ix',
  0,
  '{"page": 1}',
  'Second auto note version body.',
  'internal', 6
);

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_publish(
  '11111111-1111-4111-8111-111111111111',
  '71000000-0000-4000-8000-0000000000ix'), 'ok',
  '26 second version publishes');
reset role;

select is((select state from public.source_versions
            where id = '71000000-0000-4000-8000-0000000000ap'), 'superseded',
  '27 prior published version is superseded');
select is((select current_version_id from public.knowledge_sources
            where id = '61000000-0000-4000-8000-0000000000ap'),
  '71000000-0000-4000-8000-0000000000ix'::uuid,
  '28 source pointer moves to the new published version');

select * from finish();
rollback;
