-- Synthetic fixtures for local development and staging smoke tests only (AGENTS.md §4.7):
-- two tenants, five people, two projects. No real client data, no real credentials —
-- password hashes are generated at seed time so nothing secret is stored in the repository.
-- Ids are fixed so the pgTAP tests in supabase/tests/database/ can name them.

-- ------------------------------------------------------------ identities (auth.users → profiles)
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
) values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000000',
   'authenticated', 'authenticated', 'owner1@company1.test',
   extensions.crypt('local-seed-only', extensions.gen_salt('bf', 8)), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"Company1 Owner"}'::jsonb),
  ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000000',
   'authenticated', 'authenticated', 'field2@company1.test',
   extensions.crypt('local-seed-only', extensions.gen_salt('bf', 8)), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"Company1 Field"}'::jsonb),
  ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-000000000000',
   'authenticated', 'authenticated', 'left@company1.test',
   extensions.crypt('local-seed-only', extensions.gen_salt('bf', 8)), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"Former Company1 Member"}'::jsonb),
  ('00000000-0000-4000-8000-0000000000a4', '00000000-0000-4000-8000-000000000000',
   'authenticated', 'authenticated', 'multi@example.test',
   extensions.crypt('local-seed-only', extensions.gen_salt('bf', 8)), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"Member of Two Tenants"}'::jsonb),
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000000',
   'authenticated', 'authenticated', 'owner2@company2.test',
   extensions.crypt('local-seed-only', extensions.gen_salt('bf', 8)), now(), now(), now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{"name":"Company2 Owner"}'::jsonb)
on conflict (id) do nothing;

insert into public.profiles (id, email, display_name, is_platform_admin) values
  ('00000000-0000-4000-8000-0000000000a1', 'owner1@company1.test', 'Company1 Owner', false),
  ('00000000-0000-4000-8000-0000000000a2', 'field2@company1.test', 'Company1 Field', false),
  ('00000000-0000-4000-8000-0000000000a3', 'left@company1.test', 'Former Company1 Member', false),
  ('00000000-0000-4000-8000-0000000000a4', 'multi@example.test', 'Member of Two Tenants', false),
  ('00000000-0000-4000-8000-0000000000b1', 'owner2@company2.test', 'Company2 Owner', false)
on conflict (id) do nothing;

-- ------------------------------------------------------------ tenants, hosts, memberships
insert into public.organisations (id, slug, display_name, status, locale, timezone) values
  ('11111111-1111-4111-8111-111111111111', 'company1', 'Company1 Geotechnics', 'active', 'en', 'UTC'),
  ('22222222-2222-4222-8222-222222222222', 'company2', 'Company2 Surveys', 'active', 'en', 'UTC')
on conflict (id) do nothing;

insert into public.tenant_domains (organisation_id, host, kind, status) values
  ('11111111-1111-4111-8111-111111111111', 'company1.terraoi.app', 'tenant', 'active'),
  ('11111111-1111-4111-8111-111111111111', 'company1-staging.terraoi.app', 'staging', 'active'),
  ('22222222-2222-4222-8222-222222222222', 'company2.terraoi.app', 'tenant', 'active')
on conflict (host) do nothing;

insert into public.organisation_memberships (organisation_id, user_id, status, joined_at) values
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000a1', 'active', now()),
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000a2', 'active', now()),
  -- a live session belonging to a removed membership must grant nothing (§4.2 tests)
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000a3', 'suspended', now()),
  ('11111111-1111-4111-8111-111111111111', '00000000-0000-4000-8000-0000000000a4', 'active', now()),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-0000000000b1', 'active', now()),
  ('22222222-2222-4222-8222-222222222222', '00000000-0000-4000-8000-0000000000a4', 'active', now())
on conflict (organisation_id, user_id) do nothing;

-- roles and permission areas (plan §5.2): seeded per tenant, tenant-scoped like everything else
insert into public.organisation_roles (id, organisation_id, key, name) values
  ('31000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'member', 'Member'),
  ('31000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'admin', 'Tenant admin'),
  ('32000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'member', 'Member')
on conflict (organisation_id, key) do nothing;

insert into public.role_permissions (organisation_id, role_id, area, level) values
  ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-000000000001', 'chat.ask', 'read'),
  ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-000000000001', 'knowledge.read', 'read'),
  ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-000000000001', 'projects.read', 'read'),
  ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-000000000002', 'knowledge.admin', 'admin'),
  ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-000000000002', 'members.admin', 'admin'),
  ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-000000000002', 'projects.admin', 'admin'),
  ('22222222-2222-4222-8222-222222222222', '32000000-0000-4000-8000-000000000001', 'chat.ask', 'read')
on conflict (role_id, area) do nothing;

insert into public.membership_roles (organisation_id, membership_id, role_id)
select m.organisation_id, m.id, r.id
  from public.organisation_memberships m
  join public.organisation_roles r
    on r.organisation_id = m.organisation_id
   and r.key = case when m.user_id in ('00000000-0000-4000-8000-0000000000a1',
                                       '00000000-0000-4000-8000-0000000000b1')
                    then 'admin' else 'member' end
on conflict (membership_id, role_id) do nothing;

-- ------------------------------------------------------------ projects
insert into public.projects (id, organisation_id, key, name, visibility) values
  ('41000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'site-a', 'Site A survey', 'project'),
  ('41000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'field-notes', 'Field notes (tenant-wide)', 'organisation'),
  ('42000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'xray-site', 'Company2 X-ray site', 'organisation')
on conflict (id) do nothing;

insert into public.project_memberships (organisation_id, project_id, user_id) values
  ('11111111-1111-4111-8111-111111111111', '41000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1'),
  ('11111111-1111-4111-8111-111111111111', '41000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a4')
on conflict (project_id, user_id) do nothing;

-- ------------------------------------------------------------ knowledge (T-111)
-- Fixtures for supabase/tests/database/020_knowledge.test.sql and for local development.
-- Everything below is invented for this repository (AGENTS.md §4.7): the prose reads like field
-- guidance but is synthetic sample text written for the fixtures, never a customer document, and
-- the content hashes are made-up 64-hex strings rather than digests of a real object. Ids are
-- fixed so the tests can name them.

-- Owner2 needs a project membership: a client_confidential collection is project-scoped, so even
-- the tenant's own owner sees it only as a member of the bound project (§6.2).
insert into public.project_memberships (organisation_id, project_id, user_id) values
  ('22222222-2222-4222-8222-222222222222', '42000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000b1')
on conflict (project_id, user_id) do nothing;

-- Two collections per tenant: one tenant-wide `public` corpus and one project-scoped
-- `client_confidential` corpus. `restricted` is not insertable in M1 at all (§12.4).
insert into public.knowledge_collections (id, organisation_id, key, service_key, project_id, name, data_class) values
  ('51000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'uav-reference', 'uav-compliance', null,
   'UAV reference library (synthetic)', 'public'),
  ('51000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'site-a-data', 'uav-compliance', '41000000-0000-4000-8000-000000000001',
   'Site A client data (synthetic)', 'client_confidential'),
  ('52000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'gpr-reference', 'gpr', null,
   'GPR reference library (synthetic)', 'public'),
  ('52000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'xray-site-data', 'gpr', '42000000-0000-4000-8000-000000000001',
   'X-ray site data (synthetic)', 'client_confidential')
on conflict (id) do nothing;

-- A published upload per tenant plus a confidential note for company1, so the project-audience
-- assertions have a chunk to hide and a chunk to show (AGENTS.md §4.2: another project).
insert into public.knowledge_sources (id, organisation_id, collection_id, kind, external_id, owner_user_id) values
  ('61000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000001', 'upload',
   'synthetic-uav-manual-0001', '00000000-0000-4000-8000-0000000000a1'),
  ('61000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '51000000-0000-4000-8000-000000000002', 'note',
   null, '00000000-0000-4000-8000-0000000000a1'),
  ('62000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '52000000-0000-4000-8000-000000000002', 'upload',
   'synthetic-gpr-log-0001', '00000000-0000-4000-8000-0000000000b1')
on conflict (id) do nothing;

-- Published versions. object_ref is a synthetic storage key, never a URL or a signed grant.
-- collection_id is denormalized from the source (it must match, or the guard trigger refuses the
-- write) because content-hash deduplication is scoped to the collection, not the tenant (§6.2).
-- body_text is written at capture only for text-like payloads (the .json note); it is null for
-- PDFs, scans and images, whose extracted text lives in extraction artifacts (#51, ADR-0005 §4).
-- Until that table exists, the PDF fixtures' text is carried by their chunks below.
insert into public.source_versions (
  id, organisation_id, source_id, collection_id, version_number, uploaded_by, data_class, content_hash, object_ref,
  state, parser_generation, body_text, published_at
) values
  ('71000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 1,
   '00000000-0000-4000-8000-0000000000a1',
   'public',
   '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000001/v1.pdf',
   'published', 'v1',
   null,
   now()),
  ('71000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '61000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000002', 1,
   '00000000-0000-4000-8000-0000000000a1',
   'client_confidential',
   '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809',
   'knowledge/11111111-1111-4111-8111-111111111111/61000000-0000-4000-8000-000000000002/v1.json',
   'published', 'v1',
   'Synthetic site note for fixtures. Grid four of the sample site was surveyed twice because the first pass was flown with a low battery margin. The repeatability check in the synthetic procedure asks for a second pass whenever the margin falls below the reserve threshold recorded for the aircraft type.',
   now()),
  ('72000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '62000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000002', 1,
   '00000000-0000-4000-8000-0000000000b1',
   'client_confidential',
   '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0',
   'knowledge/22222222-2222-4222-8222-222222222222/62000000-0000-4000-8000-000000000001/v1.pdf',
   'published', 'v1',
   null,
   now())
on conflict (id) do nothing;

-- Point each source at its published version (F13). A trigger rejects a pointer that is not a
-- version of the same source, so the order here matters: versions first, then the pointers.
update public.knowledge_sources s set current_version_id = v.id
  from public.source_versions v
 where v.source_id = s.id
   and v.organisation_id = s.organisation_id
   and v.version_number = 1
   and s.current_version_id is null;

-- Chunks with page/section locators. A chunk's class is never below its version's (§6.2).
insert into public.knowledge_chunks (id, organisation_id, source_version_id, chunk_index, locator, body_text, data_class, token_count) values
  ('81000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000001', 0,
   '{"page": 3, "section": "Pre-flight"}',
   'Synthetic sample manual, section one: before any training flight, confirm the compass calibration is current and record the battery pack serial numbers.',
   'public', 24),
  ('81000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000001', 1,
   '{"page": 4, "section": "Pre-flight"}',
   'Synthetic sample manual, section two: a pre-flight note is a record of the check, not an authorisation to fly.',
   'public', 21),
  ('81000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000001', 2,
   '{"page": 9, "section": "Fault reporting"}',
   'Synthetic sample manual, section three: if a sensor reports a fault, ground the aircraft and raise a maintenance entry rather than continuing the sortie.',
   'public', 25),
  ('81000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000002', 0,
   '{"page": 1, "section": "Site note"}',
   'Synthetic site note: grid four of the sample site was surveyed twice because the first pass was flown with a low battery margin.',
   'client_confidential', 23),
  ('81000000-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000002', 1,
   '{"page": 1, "section": "Site note"}',
   'Synthetic site note: the repeatability check asks for a second pass whenever the battery margin falls below the reserve threshold for the aircraft type.',
   'client_confidential', 26),
  ('82000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '72000000-0000-4000-8000-000000000001', 0,
   '{"page": 2, "section": "Line one"}',
   'Synthetic radar log, line one: recorded at a nominal trace spacing of a quarter metre with the antenna coupled by a dry couplant.',
   'client_confidential', 24),
  ('82000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', '72000000-0000-4000-8000-000000000001', 1,
   '{"page": 2, "section": "Line one"}',
   'Synthetic radar log: where coupling degrades, the procedure calls for a re-run of the affected chainage rather than an interpretation note on the trace.',
   'client_confidential', 26)
on conflict (id) do nothing;

-- One pinned embedding generation per tenant (§12.4, TOI-ADR-13). Company1's E1/E2 choice —
-- whether Workers AI may embed client_confidential text — is still open (plan §18.3), so the
-- seeded generation is cleared for `public` only and the confidential fixture chunks carry no
-- vectors: the lexical lane still finds them (§8.1). Recording E1 or E2 here is a data change.
insert into public.embedding_indexes (
  id, organisation_id, index_key, provider_key, model, dimensions, metric, generation, status, cleared_for
) values
  ('91000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'corpus', 'workers_ai',
   'synthetic-multilingual-e5', 1024, 'cosine', 1, 'active', array['public']::text[]),
  ('92000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'corpus', 'local_box',
   'synthetic-multilingual-e5', 1024, 'cosine', 1, 'active', array['public']::text[])
on conflict (id) do nothing;

-- Stage rows the walking skeleton shows as progress. The idempotency key is the unique
-- constraint, so a duplicate queue delivery cannot create a second row (§7.5).
insert into public.ingestion_jobs (
  id, organisation_id, source_version_id, stage, executor, status, data_class,
  parser_generation, index_generation, attempt, completed_at
) values
  ('93000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000001',
   'extract', 'cloud_worker', 'succeeded', 'public', 'v1', 1, 1, now()),
  ('93000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '71000000-0000-4000-8000-000000000001',
   'index', 'cloud_worker', 'succeeded', 'public', 'v1', 1, 1, now()),
  ('94000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '72000000-0000-4000-8000-000000000001',
   'extract', 'local_box', 'queued', 'client_confidential', 'v1', 1, 1, null)
on conflict (id) do nothing;

-- The capture events for the three fixture versions were written by the outbox trigger itself,
-- which is exactly what proves §7.2 step 1: the seeder never had to remember them. They are
-- marked dispatched; the publish event below is what a dispatcher run picks up on a fresh local
-- database, and the company2 OCR job waits for a box that is not running locally (§13).
update public.outbox_events set processed_at = now()
 where aggregate_type = 'source_version' and processed_at is null;

insert into public.outbox_events (organisation_id, event_type, aggregate_type, aggregate_id, payload)
select '11111111-1111-4111-8111-111111111111',
       'knowledge.source_version.published',
       'source_version',
       '71000000-0000-4000-8000-000000000001',
       '{"source_version_id": "71000000-0000-4000-8000-000000000001", "organisation_id": "11111111-1111-4111-8111-111111111111", "reason": "fixture"}'::jsonb
 where not exists (
   select 1 from public.outbox_events
    where aggregate_id = '71000000-0000-4000-8000-000000000001'
      and event_type = 'knowledge.source_version.published'
 );
