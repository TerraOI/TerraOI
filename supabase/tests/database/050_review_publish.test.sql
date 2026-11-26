-- T-213 PR-1: review / publish / revoke (F13/F14). Slot 050 (COORDINATION.md §6b).
-- Does not consume T-104 derived-output invalidation.
begin;
create extension if not exists pgtap with schema extensions;

select plan(45);

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

-- Builds a source (if new), one awaiting_review version and, unless p_chunk is false, one chunk.
create function pg_temp.mk(
  p_src uuid, p_ver uuid, p_col uuid, p_kind text, p_uploader uuid, p_class text,
  p_version_number int, p_chunk boolean
) returns void
language plpgsql as $fn$
begin
  insert into public.knowledge_sources (id, organisation_id, collection_id, kind, external_id, owner_user_id)
  values (p_src, '11111111-1111-4111-8111-111111111111', p_col, p_kind,
          case when p_kind = 'note' then null else 'synthetic-review-' || p_src::text end, p_uploader)
  on conflict (id) do nothing;
  insert into public.source_versions (
    id, organisation_id, source_id, collection_id, version_number, uploaded_by, data_class,
    content_hash, object_ref, state, parser_generation, body_text, published_at
  ) values (
    p_ver, '11111111-1111-4111-8111-111111111111', p_src, p_col, p_version_number, p_uploader, p_class,
    md5('t213-' || p_ver::text) || md5('t213-' || p_ver::text || '-tail'),
    'knowledge/11111111-1111-4111-8111-111111111111/' || p_src::text || '/v' || p_version_number || '.pdf',
    'awaiting_review', 'v1', 'Synthetic review fixture ' || p_ver::text, null
  );
  if p_chunk then
    insert into public.knowledge_chunks (
      id, organisation_id, source_version_id, chunk_index, locator, body_text, data_class, token_count
    ) values (
      ('81' || substr(p_ver::text, 3))::uuid, '11111111-1111-4111-8111-111111111111', p_ver, 0, '{"page": 1}',
      'Synthetic review fixture chunk ' || p_ver::text, p_class, 6
    );
  end if;
end;
$fn$;

-- ---------------------------------------------------------------- roles (transaction-local)
-- …a2 is the contributor: knowledge.write only (the #227 seed grants this; the fixture keeps this file
-- independent of that order and is a no-op duplicate once the seed is on main). …a4 is the reviewer:
-- knowledge.review at write, using an id outside the seeded range, as 040 does for its publisher.
-- …a1 holds knowledge.admin at admin through the seeded admin role.
insert into public.organisation_roles (id, organisation_id, key, name) values
  ('31000000-0000-4000-8000-0000000000d1', '11111111-1111-4111-8111-111111111111', 'publisher_050', 'Contributor stand-in (050)'),
  ('31000000-0000-4000-8000-0000000000d2', '11111111-1111-4111-8111-111111111111', 'reviewer_050', 'Knowledge reviewer (050)');
insert into public.role_permissions (organisation_id, role_id, area, level) values
  ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-0000000000d1', 'knowledge.write', 'write'),
  ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-0000000000d2', 'knowledge.review', 'write');
insert into public.membership_roles (organisation_id, membership_id, role_id)
select m.organisation_id, m.id, r.role_id
  from public.organisation_memberships m
  join (values ('00000000-0000-4000-8000-0000000000a2'::uuid, '31000000-0000-4000-8000-0000000000d1'::uuid),
               ('00000000-0000-4000-8000-0000000000a4'::uuid, '31000000-0000-4000-8000-0000000000d2'::uuid)) as r(user_id, role_id)
    on r.user_id = m.user_id
 where m.organisation_id = '11111111-1111-4111-8111-111111111111';

-- ---------------------------------------------------------------- collections
-- a5: tenant-wide internal notes with auto_publish. a9: Site A client_confidential with auto_publish
-- (the trigger forces review_independent on). 001 is forced review_independent for the #8 pins.
insert into public.knowledge_collections (
  id, organisation_id, key, service_key, project_id, name, data_class, auto_publish, review_independent
) values
  ('51000000-0000-4000-8000-0000000000a5', '11111111-1111-4111-8111-111111111111', 'auto-notes', 'uav', null, 'Auto notes', 'internal', true, false),
  ('51000000-0000-4000-8000-0000000000a9', '11111111-1111-4111-8111-111111111111', 'auto-confidential', 'uav',
   '41000000-0000-4000-8000-000000000001', 'Auto confidential', 'client_confidential', true, false);
update public.knowledge_collections set review_independent = true
 where id = '51000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------- versions
select pg_temp.mk('61000000-0000-4000-8000-0000000000a6', '71000000-0000-4000-8000-0000000000a6', '51000000-0000-4000-8000-000000000001', 'upload', '00000000-0000-4000-8000-0000000000a1', 'public', 1, true);
select pg_temp.mk('61000000-0000-4000-8000-0000000000a5', '71000000-0000-4000-8000-0000000000a5', '51000000-0000-4000-8000-0000000000a5', 'note', '00000000-0000-4000-8000-0000000000a2', 'internal', 1, true);
select pg_temp.mk('61000000-0000-4000-8000-0000000000a5', '71000000-0000-4000-8000-0000000000a7', '51000000-0000-4000-8000-0000000000a5', 'note', '00000000-0000-4000-8000-0000000000a2', 'internal', 2, false);
select pg_temp.mk('61000000-0000-4000-8000-0000000000b1', '71000000-0000-4000-8000-0000000000b1', '51000000-0000-4000-8000-000000000001', 'upload', '00000000-0000-4000-8000-0000000000a4', 'public', 1, true);
select pg_temp.mk('61000000-0000-4000-8000-0000000000b3', '71000000-0000-4000-8000-0000000000b3', '51000000-0000-4000-8000-000000000001', 'upload', '00000000-0000-4000-8000-0000000000a2', 'public', 1, true);
select pg_temp.mk('61000000-0000-4000-8000-0000000000b4', '71000000-0000-4000-8000-0000000000b4', '51000000-0000-4000-8000-000000000001', 'upload', '00000000-0000-4000-8000-0000000000a2', 'public', 1, true);
select pg_temp.mk('61000000-0000-4000-8000-0000000000b5', '71000000-0000-4000-8000-0000000000b5', '51000000-0000-4000-8000-0000000000a5', 'upload', '00000000-0000-4000-8000-0000000000a2', 'internal', 1, true);
select pg_temp.mk('61000000-0000-4000-8000-0000000000b6', '71000000-0000-4000-8000-0000000000b6', '51000000-0000-4000-8000-0000000000a9', 'note', '00000000-0000-4000-8000-0000000000a4', 'client_confidential', 1, true);
select pg_temp.mk('61000000-0000-4000-8000-0000000000c1', '71000000-0000-4000-8000-0000000000c1', '51000000-0000-4000-8000-000000000002', 'upload', '00000000-0000-4000-8000-0000000000a4', 'client_confidential', 1, true);

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

-- ---------------------------------------------------------------- 4-6 independence + tenant + suspended
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_review('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000a6', 'approve', null), '42501',
  '4 knowledge.admin uploader cannot approve their own version when review_independent (#8)');
reset role;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
select is(pg_temp.try_review('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000a6', 'approve', null), '28000',
  '5 company2 owner cannot establish company1 scope to review');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a3';
select is(pg_temp.try_review('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000a6', 'approve', null), '28000',
  '6 suspended membership cannot review');
reset role;

-- ---------------------------------------------------------------- 7-9 the contributor is capture only (FAQ-0006, FAQ-0015)
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select is(pg_temp.try_review('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000a6', 'approve', null), '42501',
  '7 a knowledge.write-only contributor cannot review');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select is(pg_temp.try_publish('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000a6'), '42501',
  '8 …nor publish');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select is(pg_temp.try_revoke('11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-0000000000a6'), '42501',
  '9 …nor revoke');
reset role;

-- ---------------------------------------------------------------- 10-15 a knowledge.review holder approves and publishes another member's upload
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
select is(pg_temp.try_review('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000a6', 'approve', null), 'ok',
  '10 a knowledge.review holder approves another members upload');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
select is(pg_temp.try_review('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000a6', 'approve', null), 'ok',
  '11 the same decision again is a no-op');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
select is(pg_temp.try_publish('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000a6'), 'ok',
  '12 …and publishes it after approval');
reset role;

select is((select state from public.source_versions where id = '71000000-0000-4000-8000-0000000000a6'), 'published',
  '13 version is published');
select is((select current_version_id from public.knowledge_sources where id = '61000000-0000-4000-8000-0000000000a6'),
  '71000000-0000-4000-8000-0000000000a6'::uuid, '14 source current_version_id points at the published version');
select is((select count(*)::int from public.knowledge_review_decisions
            where source_version_id = '71000000-0000-4000-8000-0000000000a6'), 1,
  '15 only one review decision row');

-- ---------------------------------------------------------------- 16-18 auto-publish note, incomplete embedding
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_publish('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000a5'), 'ok',
  '16 an auto_publish internal note publishes without a prior review decision');
reset role;

select is((select state from public.source_versions where id = '71000000-0000-4000-8000-0000000000a5'), 'published',
  '17 auto-published note is published');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_publish('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000a7'), '22023',
  '18 publish without chunks is refused (embedding incomplete)');
reset role;

-- ---------------------------------------------------------------- 19-27 guards that had no test (#267 B4)
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
select is(pg_temp.try_review('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000b1', 'approve', null), '42501',
  '19 a knowledge.review holder is refused by independence on their own upload (#8)');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_publish('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000b1'), '22023',
  '20 publishing an awaiting_review upload with no approve decision, outside auto_publish, is refused');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
select is(pg_temp.try_review('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000b3', 'reject', null), 'ok',
  '21 a reviewer can reject');
reset role;

select is((select state from public.source_versions where id = '71000000-0000-4000-8000-0000000000b3'), 'failed',
  '22 reject moves the version to failed');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_publish('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000b3'), '22023',
  '23 …and a rejected version cannot be published');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
select is(pg_temp.try_review('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000b4', 'approve', null), 'ok',
  '24 approve b4');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a4';
select is(pg_temp.try_review('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000b4', 'reject', null), '22023',
  '25 a different second decision is refused, not silently accepted (N2)');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_publish('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000b5'), '22023',
  '26 auto_publish does not cover a non-note kind: an upload still needs approval');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_publish('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000b6'), '22023',
  '27 auto_publish does not cover a client_confidential note');
reset role;

-- ---------------------------------------------------------------- 28-34 revoke + in-flight jobs
insert into public.ingestion_jobs (
  organisation_id, source_version_id, stage, executor, status, data_class, index_generation,
  lease_token, lease_expires_at
) values
  ('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000a6', 'index', 'cloud_worker', 'queued', 'public', 1, null, null),
  ('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000a6', 'publish', 'cloud_worker', 'leased', 'public', 1, 'lease-token-050-0001', now() + interval '5 minutes');
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_revoke('11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-0000000000a6'), 'ok',
  '28 knowledge.admin can revoke a published source');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_revoke('11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-0000000000a6'), 'ok',
  '29 duplicate revoke is a no-op');
reset role;

select is((select lifecycle_state from public.knowledge_sources where id = '61000000-0000-4000-8000-0000000000a6'), 'revoked',
  '30 source lifecycle is revoked');
select is((select state from public.source_versions where id = '71000000-0000-4000-8000-0000000000a6'), 'revoked',
  '31 published version is revoked');
select is((select current_version_id from public.knowledge_sources where id = '61000000-0000-4000-8000-0000000000a6'), null,
  '32 revoked source clears current_version_id');
select is((
  select count(*)::int
    from public.knowledge_chunks c
    join public.source_versions v on v.id = c.source_version_id
    join public.knowledge_sources s on s.id = v.source_id
   where v.id = '71000000-0000-4000-8000-0000000000a6' and v.state = 'published' and s.lifecycle_state = 'active'
), 0, '33 revoked version is invisible to the published+active retrieval predicate');
select is((select count(*)::int from public.ingestion_jobs
            where source_version_id = '71000000-0000-4000-8000-0000000000a6'
              and status = 'failed' and last_error = 'source_revoked'
              and lease_token is null and lease_expires_at is null), 2,
  '34 the queued and the leased job for the source are failed as source_revoked with the lease cleared');

-- ---------------------------------------------------------------- 35-37 defaults + anon
select is((select review_independent from public.knowledge_collections
            where id = '51000000-0000-4000-8000-000000000002'), true,
  '35 seeded client_confidential collection has review_independent');
select is(has_function_privilege('anon',
  'public.publish_knowledge_version_v1(uuid,uuid)', 'execute'), false,
  '36 anon cannot execute publish_knowledge_version_v1');
select is(has_function_privilege('anon',
  'public.revoke_source_v1(uuid,uuid,text)', 'execute'), false,
  '37 anon cannot execute revoke_source_v1');

-- ---------------------------------------------------------------- 38-40 supersede prior on second publish
insert into public.knowledge_chunks (
  id, organisation_id, source_version_id, chunk_index, locator, body_text, data_class, token_count
) values ('81000000-0000-4000-8000-0000000000a8', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000a7', 0, '{"page": 1}',
          'Second auto note version body.', 'internal', 6);
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_publish('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000a7'), 'ok',
  '38 second version publishes');
reset role;

select is((select state from public.source_versions where id = '71000000-0000-4000-8000-0000000000a5'), 'superseded',
  '39 prior published version is superseded');
select is((select current_version_id from public.knowledge_sources where id = '61000000-0000-4000-8000-0000000000a5'),
  '71000000-0000-4000-8000-0000000000a7'::uuid, '40 source pointer moves to the new published version');

-- ---------------------------------------------------------------- 41-45 project audience (#267 B2)
-- …a2 now also holds knowledge.review, so the permission half passes and only the audience half can
-- refuse: …a2 is not a Site A member. Without the audience check, 42 would reach the approval check
-- (22023) and 43 would succeed.
insert into public.membership_roles (organisation_id, membership_id, role_id)
select m.organisation_id, m.id, '31000000-0000-4000-8000-0000000000d2'
  from public.organisation_memberships m
 where m.organisation_id = '11111111-1111-4111-8111-111111111111' and m.user_id = '00000000-0000-4000-8000-0000000000a2';
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select is(pg_temp.try_review('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000c1', 'approve', null), '42501',
  '41 a reviewer outside Site A cannot review a Site A version');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select is(pg_temp.try_publish('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000c1'), '42501',
  '42 …nor publish it');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
select is(pg_temp.try_revoke('11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-0000000000c1'), '42501',
  '43 …nor revoke its source');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_review('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000c1', 'approve', null), 'ok',
  '44 knowledge.admin at admin passes the permission check and approves another members upload');
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
select is(pg_temp.try_publish('11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-0000000000c1'), 'ok',
  '45 …and publishes it');
reset role;

select * from finish();
rollback;
