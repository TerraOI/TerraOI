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
