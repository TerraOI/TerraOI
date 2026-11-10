-- T-103 second half: brand configuration and brand assets (#62). Slot 026 (docs/COORDINATION.md §6b).
-- Plan §5.1 lines 261–273, §6.1 line 321, §4.4; F04; FAQ-0008 (asset delivery), FAQ-0010 (function
-- privileges), #116 (contrast floors), #117 (64 KiB), #65 (customer-mode identity).
--
-- Fixtures are the synthetic ones in supabase/seed.sql plus rows this file inserts and rolls back:
-- no real tenant's brand is seeded anywhere (AGENTS.md §4.7).
--
-- The two RLS negatives AGENTS.md §4.2 asks for that *fit* a tenant-level row are here (another
-- tenant's member, a deactivated member via the scope rule), and the honest substitute for "another
-- project" is the host-negative pair, exactly as ADR-0004 §4 says to state rather than fake: a brand
-- row has no project axis, so "this host never returns that tenant's row" is the equivalent test.
begin;
create extension if not exists pgtap with schema extensions;

-- COUNT: 50 assertions below, numbered 1–50 in their messages. `plan` equals that count exactly:
-- CI's `database` job is the venue for this file (no builder machine has Docker), and a `plan(N)`
-- that does not match the assertions that run is a red run, not a warning.
select plan(50);

-- Error-as-SQLSTATE helpers. SECURITY INVOKER on purpose: they run as the role under test.
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

create function pg_temp.try_host_brand(p_host text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from public.load_public_brand(p_host);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_host_asset(p_host text, p_version bigint, p_name text) returns text
language plpgsql security invoker as $fn$
begin
  begin
    perform 1 from public.load_public_brand_asset(p_host, p_version, p_name);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Direct table writes, used only to prove the schema's own CHECKs and FKs.
create function pg_temp.try_asset(org uuid, version bigint, name text, kind text, size bigint, content bytea)
returns text language plpgsql security invoker as $fn$
begin
  begin
    insert into public.tenant_brand_assets (organisation_id, config_version, name, content_type, byte_size, content)
      values (org, version, name, kind, size, content);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_brand(org uuid, p_mode text, p_display text, p_prefix text,
                                  p_primary text, p_on_primary text, p_accent text)
returns text language plpgsql security invoker as $fn$
begin
  begin
    insert into public.tenant_brands (organisation_id, mode, display_name, descriptor, tagline,
                                      report_owner, email_sender_name, document_prefix, support_label,
                                      primary_color, on_primary_color, accent_color)
      values (org, p_mode, p_display, 'Operational Intelligence', '', p_display, p_display, p_prefix,
              'Contact your workspace administrator', p_primary, p_on_primary, p_accent);
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

create function pg_temp.try_logo_of(p_org uuid, p_asset_id uuid) returns text
language plpgsql security invoker as $fn$
begin
  begin
    update public.tenant_brands set logo_asset_id = p_asset_id where organisation_id = p_org;
    return 'ok';
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- The write RPC, called as the migration owner with the request GUCs set, because it is granted to
-- **no request role** today (see the migration's grant note): the grant is T-202's to add, and this
-- file proves the function's own gates regardless.
create function pg_temp.try_put(p_brand jsonb, p_assets jsonb) returns text
language plpgsql security invoker as $fn$
begin
  begin
    return public.put_tenant_brand_v1(p_brand, p_assets)::text;
  exception when others then
    return sqlstate::text;
  end;
end;
$fn$;

-- Temp tables are created as `authenticated` because the role-switched sections write into them.
set local role authenticated;
create temp table t_out (case_name text, result text);
create temp table t_brand (case_name text, mode text, display_name text, logo_path text, logo_bytes bigint,
                           show_powered_by boolean, rows int);
create temp table t_asset (case_name text, content_base64 text, kind text, size bigint, rows int);
create temp table t_full (case_name text, organisation_id uuid, legal_name text, config_version bigint, rows int);
reset role;

-- ---------------------------------------------------------------- fixtures (synthetic)
-- company1: one brand row at config_version 1 with a logo and a favicon; company2: its own.
insert into public.tenant_brand_assets (id, organisation_id, config_version, name, content_type, byte_size, content) values
  ('50000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 1, 'logo.svg',
   'image/svg+xml', octet_length(convert_to('<svg xmlns="http://www.w3.org/2000/svg"/>', 'UTF8')),
   convert_to('<svg xmlns="http://www.w3.org/2000/svg"/>', 'UTF8')),
  ('50000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 1, 'favicon.ico',
   'image/x-icon', 4, '\x00000100'::bytea),
  ('50000000-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 1, 'logo-c2.png',
   'image/png', 8, '\x89504e470d0a1a0a'::bytea);

insert into public.tenant_brands (organisation_id, mode, display_name, legal_name, descriptor, tagline,
                                  report_owner, email_sender_name, document_prefix, support_label,
                                  support_url, primary_color, on_primary_color, accent_color,
                                  logo_asset_id, favicon_asset_id, config_version) values
  ('11111111-1111-4111-8111-111111111111', 'customer', 'Company1 Geotechnics',
   'Company1 Geotechnics Pty Ltd', 'Operational Intelligence', 'Field data, answered',
   'Company1 Geotechnics', 'Company1 Geotechnics', 'CO1', 'Contact your workspace administrator',
   'https://support.company1.example/help', '#007F78', '#FFFFFF', '#A48748',
   '50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', 1),
  ('22222222-2222-4222-8222-222222222222', 'powered', 'Company2 Surveys', null,
   'Operational Intelligence', '', 'Company2 Surveys', 'Company2 Surveys', 'C2',
   'Contact your workspace administrator', null, '#183B66', '#FFFFFF', '#637D99',
   '50000000-0000-4000-8000-000000000003', null, 1);

-- ---------------------------------------------------------------- 1-9 privileges (FAQ-0010)
select is(has_table_privilege('anon', 'public.tenant_brands', 'select'), false,
  '1 anon cannot select tenant_brands directly: sign-in reads it through load_public_brand (§4.1)');
select is(has_table_privilege('anon', 'public.tenant_brand_assets', 'select'), false,
  '2 anon cannot select tenant_brand_assets directly (§4.3)');
select is(has_table_privilege('authenticated', 'public.tenant_brands', 'select'), false,
  '3 no member holds a table grant on tenant_brands: RLS filters rows, not columns, and legal_name, '
  || 'email_reply_to and config_version must not be readable by every signed-in member (ADR-0004 §4)');
select is(has_table_privilege('authenticated', 'public.tenant_brands', 'insert'), false,
  '4 a brand write is not a member table privilege: it is a definer RPC (§4.3, plan §13)');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef
              and p.proname in ('load_public_brand', 'load_public_brand_asset',
                                'get_tenant_brand_v1', 'put_tenant_brand_v1')
              and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c
                           where c like 'search_path=%')),
  4::int, '5 all four brand functions are SECURITY DEFINER with a pinned search_path (guardrail 000)');
select is(has_function_privilege('anon', 'public.load_public_brand(text)', 'execute'), true,
  '6 anon can execute load_public_brand: the sign-in surface needs a brand before anyone is signed in');
select is(has_function_privilege('anon', 'public.load_public_brand_asset(text, bigint, text)', 'execute'), true,
  '7 anon can execute load_public_brand_asset: an <img> or favicon request carries no bearer token (FAQ-0008)');
select is(has_function_privilege('anon', 'public.get_tenant_brand_v1()', 'execute'), false,
  '8 anon cannot execute the member read: the full row includes never-pre-sign-in columns (§4.1)');
select is(has_function_privilege('authenticated', 'public.put_tenant_brand_v1(jsonb, jsonb)', 'execute'), false,
  '9 the brand write is granted to no request role today: who may change a customer-visible identity '
  || 'is a decision this slice does not make, and the grant should arrive with T-202 and the seeded '
  || 'brand.admin permission (precedent: toi_identity, pinned shut by 001 test 33)');

-- ---------------------------------------------------------------- 10-15 the public projection
insert into t_brand
  select 'c1', b.mode, b.display_name, b.logo_path, b.logo_bytes, b.show_powered_by, 1
    from public.load_public_brand('company1.terraoi.app') b;
insert into t_brand
  select 'c2', b.mode, b.display_name, b.logo_path, b.logo_bytes, b.show_powered_by, 1
    from public.load_public_brand('company2.terraoi.app') b;

-- anon writes only into a table it owns: the capture tables above belong to `authenticated`, and a
-- temp table owned by one role is not writable by another (the same split 010_tenancy.test.sql uses).
set local role anon;
create temp table t_anon_brand (case_name text, rows int);
insert into t_anon_brand select 'c1_anon', count(*)::int
  from public.load_public_brand('company1.terraoi.app') b;
reset role;

select ok((select count(*)::int from t_brand where case_name = 'c1') = 1
          and (select rows from t_anon_brand where case_name = 'c1_anon') = 1,
  '10 one exact active tenant host returns exactly one brand row — to the migration owner and to anon, '
  || 'because the sign-in surface is anonymous and this projection is all it may see (§4.1)');
select is((select display_name from t_brand where case_name = 'c1'), 'Company1 Geotechnics',
  '11 the host picks the tenant, and the row is that tenant''s own (plan §4.1 step 1)');
select is((select show_powered_by from t_brand where case_name = 'c2'), true,
  '12 attribution is computed from the mode, never stored: powered mode shows it, and the projection '
  || 'derives it (ADR-0004 §2)');
select is((select show_powered_by from t_brand where case_name = 'c1'), false,
  '13 and customer mode hides it without anyone having to remember to set a flag');
select is((select string_agg(a, ',' order by a)
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             cross join lateral unnest(p.proargnames) a
            where n.nspname = 'public' and p.proname = 'load_public_brand'
              and a in ('config_version', 'legal_name', 'email_reply_to', 'organisation_id')),
  null::text,
  '14 the public projection carries no config_version, legal_name, reply-to or organisation id: the '
  || 'version lives inside the asset path, not as a page fact (ADR-0004 §4, §5.1 line 273)');
select is((select logo_path from t_brand where case_name = 'c1'), '1/logo.svg',
  '15 the logo path is composed with the version in it, which is what makes FAQ-0008''s immutable '
  || 'Cache-Control honest');

select is((select logo_bytes from t_brand where case_name = 'c1'),
  octet_length(convert_to('<svg xmlns="http://www.w3.org/2000/svg"/>', 'UTF8'))::bigint,
  '16 the measured byte size travels with the asset, because brand-rules.ts refuses an unmeasured '
  || 'asset rather than trusting a guess (§5.1 line 269)');

-- ---------------------------------------------------------------- 17-20 host negatives
insert into t_brand select 'unknown', null, null, null, null, null, count(*)::int
  from public.load_public_brand('company3.terraoi.app');
insert into t_brand select 'lookalike', null, null, null, null, null, count(*)::int
  from public.load_public_brand('evil.terraoi.app');
insert into t_brand select 'staging', null, null, null, null, null, count(*)::int
  from public.load_public_brand('company1-staging.terraoi.app');
insert into t_brand (case_name, rows) select 'c2_not_c1', count(*)::int
  from public.load_public_brand('company2.terraoi.app') b
 where b.display_name = 'Company1 Geotechnics';

select is((select rows from t_brand where case_name = 'unknown'), 0::int,
  '17 an unregistered host gets no brand at all: never a default tenant (§4.1 step 3)');
select is((select rows from t_brand where case_name = 'lookalike'), 0::int,
  '18 a look-alike host gets nothing: exact match only, no suffix rule');
select is((select rows from t_brand where case_name = 'staging'), 0::int,
  '19 the staging alias is deliberately excluded: kind = ''tenant'' only, because ADR-0004 note 3 '
  || 'records that the alias question is still open and a brand PR must not settle it by accident');
select is((select rows from t_brand where case_name = 'c2_not_c1'), 0::int,
  '20 company1''s brand is never returned on company2''s host — the project-axis substitute this row '
  || 'type allows, named as such in ADR-0004 §4');

-- ---------------------------------------------------------------- 21 the suspended tenant (F28)
savepoint sp_suspend;
update public.organisations set status = 'suspended' where id = '11111111-1111-4111-8111-111111111111';
insert into t_brand select 'suspended', null, null, null, null, null, count(*)::int
  from public.load_public_brand('company1.terraoi.app');
select is((select rows from t_brand where case_name = 'suspended'), 0::int,
  '21 a suspended tenant gets no brand row, public or otherwise (plan F28)');
rollback to savepoint sp_suspend;

-- ---------------------------------------------------------------- 22-25 the asset read
-- The bytes case captures the row itself; the refusal cases aggregate a count, because an aggregate
-- over zero rows yields one row of `0` while a bare select over zero rows yields none — and a missing
-- capture row would read as NULL, which is not the same claim.
insert into t_asset (case_name, content_base64, kind, size)
  select 'right', a.content_base64, a.content_type, a.byte_size
    from public.load_public_brand_asset('company1.terraoi.app', 1, 'logo.svg') a;
insert into t_asset (case_name, rows) select 'other_host', count(*)::int
  from public.load_public_brand_asset('company2.terraoi.app', 1, 'logo.svg');
insert into t_asset (case_name, rows) select 'old_version', count(*)::int
  from public.load_public_brand_asset('company1.terraoi.app', 99, 'logo.svg');
insert into t_asset (case_name, rows) select 'no_name', count(*)::int
  from public.load_public_brand_asset('company1.terraoi.app', 1, 'other.svg');

select is((select content_base64 from t_asset where case_name = 'right'),
  encode(convert_to('<svg xmlns="http://www.w3.org/2000/svg"/>', 'UTF8'), 'base64'),
  '22 the asset function returns the exact stored bytes for the right host, version and name (FAQ-0008)');
select is((select rows from t_asset where case_name = 'other_host'), 0::int,
  '23 company1''s asset name on company2''s host returns nothing: a host can never be asked for '
  || 'another tenant''s asset, which is the reason FAQ-0008 rules this shape');
select is((select rows from t_asset where case_name = 'old_version'), 0::int,
  '24 an unknown version returns nothing, and identically to the unknown-name case below: one 404, '
  || 'so the endpoint cannot be probed for which assets a tenant holds');
select is((select rows from t_asset where case_name = 'no_name'), 0::int,
  '25 an unknown name returns nothing');

-- ---------------------------------------------------------------- 26-27 normalization guards
insert into t_out values
  ('host_upper', pg_temp.try_host_brand('Company1.TerraOI.App')),
  ('host_port', pg_temp.try_host_brand('company1.terraoi.app:8443')),
  ('asset_host_upper', pg_temp.try_host_asset('Company1.TerraOI.App', 1, 'logo.svg')),
  ('asset_name_climb', pg_temp.try_host_asset('company1.terraoi.app', 1, '../company2/secret.svg')),
  ('asset_name_upper', pg_temp.try_host_asset('company1.terraoi.app', 1, 'Logo.SVG'));

select ok((select count(*)::int = 3 from t_out
             where case_name in ('host_upper', 'host_port', 'asset_host_upper') and result = '22023'),
  '26 a host that is not already a bare lowercase hostname is refused by both brand readers, in all '
  || 'three variants, rather than repaired somewhere downstream (same guard as resolve_tenant_host)');
select ok((select count(*)::int = 2 from t_out
             where case_name in ('asset_name_climb', 'asset_name_upper') and result = '22023'),
  '27 a name that climbs out of the version segment, or is not the table''s own lowercase name form, '
  || 'is refused before it is ever searched for — it can only be a probe (§4.1)');

-- ---------------------------------------------------------------- 28-35 the schema's own CHECKs
insert into t_out values
  ('asset_oversize', pg_temp.try_asset('11111111-1111-4111-8111-111111111111', 1, 'big.svg',
      'image/svg+xml', 65537, convert_to(repeat('A', 65537), 'UTF8'))),
  ('asset_type_mismatch', pg_temp.try_asset('11111111-1111-4111-8111-111111111111', 1, 'logo.png',
      'image/svg+xml', 4, '\x89504e47'::bytea)),
  ('asset_size_declared_differs', pg_temp.try_asset('11111111-1111-4111-8111-111111111111', 1, 'ok.svg',
      'image/svg+xml', 3, convert_to('<svg/>', 'UTF8'))),
  ('asset_path_name', pg_temp.try_asset('11111111-1111-4111-8111-111111111111', 1, 'a/b.svg',
      'image/svg+xml', 4, convert_to('<svg/>', 'UTF8'))),
  ('mode_terraoi', pg_temp.try_brand('11111111-1111-4111-8111-111111111111', 'terraoi',
      'Company1 Geotechnics', 'CO1', '#007F78', '#FFFFFF', '#A48748')),
  ('placeholder', pg_temp.try_brand('11111111-1111-4111-8111-111111111111', 'customer',
      '{{company}}', 'CO1', '#007F78', '#FFFFFF', '#A48748')),
  ('markup_in_name', pg_temp.try_brand('11111111-1111-4111-8111-111111111111', 'customer',
      'Company1 <script>alert(1)</script>', 'CO1', '#007F78', '#FFFFFF', '#A48748')),
  ('kit_placeholder', pg_temp.try_brand('11111111-1111-4111-8111-111111111111', 'customer',
      'Customer Brand', 'CO1', '#007F78', '#FFFFFF', '#A48748'));

select is((select result from t_out where case_name = 'asset_oversize'), '23514',
  '28 an asset over 65536 bytes is refused by the table, not by a policy that could be widened (#117)');
select is((select result from t_out where case_name = 'asset_type_mismatch'), '23514',
  '29 an extension/content-type mismatch is refused: the route answers from the stored content type, '
  || 'so the two cannot be allowed to disagree (§4.1)');
select ok((select count(*)::int = 2 from t_out
             where case_name in ('asset_size_declared_differs', 'asset_path_name') and result = '23514'),
  '30 the declared size must equal octet_length(content) — one fact, never two that can drift — and a '
  || 'name with a path separator is refused, because the URL is built from this name');
select is((select result from t_out where case_name = 'mode_terraoi'), '23514',
  '31 a tenant row cannot claim terraoi mode: platform identity is a code constant with no row at all '
  || '(ADR-0004 note 2, #62)');
select is((select result from t_out where case_name = 'placeholder'), '23514',
  '32 an unresolved {{placeholder}} is refused at the boundary, not cleaned on the way out (§5.1 line 269)');
select is((select result from t_out where case_name = 'markup_in_name'), '23514',
  '33 the plain-text backstop added in 28badf3 catches a writer that skips the loader''s validation');
select is((select result from t_out where case_name = 'kit_placeholder'), '23514',
  '34 the kit''s own template value is refused, matching brand-rules.ts:56 so the two halves agree');

-- Contrast is deliberately storable in SQL and refused on read. Both halves are asserted; the read
-- half lives in Vitest (brand-rules.test.ts, load-tenant-brand.test.ts), which is why this pair is
-- here rather than a fake SQL ratio.
savepoint sp_contrast;
update public.tenant_brands set primary_color = '#FFFFFF', on_primary_color = '#FFFFFF'
 where organisation_id = '11111111-1111-4111-8111-111111111111';
insert into t_brand select 'lowcontrast', b.mode, b.display_name, b.logo_path, b.logo_bytes, b.show_powered_by, 1
  from public.load_public_brand('company1.terraoi.app') b;
select is((select count(*)::int from t_brand where case_name = 'lowcontrast'), 1::int,
  '35 a failing contrast pair is storable, because SQL has no honest luminance function — and the '
  || 'loader refuses it on every read (#116, brand-rules.ts), so it can never reach a page');
rollback to savepoint sp_contrast;

-- ---------------------------------------------------------------- 36-38 identity and FK rules
insert into t_out values
  ('brand_dup', pg_temp.try_brand('11111111-1111-4111-8111-111111111111', 'customer',
      'Second Company1 Brand', 'CO2', '#007F78', '#FFFFFF', '#A48748')),
  ('logo_cross_tenant', pg_temp.try_logo_of('11111111-1111-4111-8111-111111111111',
      '50000000-0000-4000-8000-000000000003'));

select is((select result from t_out where case_name = 'brand_dup'), '23505',
  '36 one brand row per tenant: the unique (organisation_id) assumption ADR-0004 §4 labels as an '
  || 'assumption, asserted rather than assumed');
select is((select result from t_out where case_name = 'logo_cross_tenant'), '23503',
  '37 a brand cannot reference another tenant''s asset: the composite (id, organisation_id) FK makes '
  || 'the cross-host case impossible, not merely filtered (plan §4.1 step 4)');
select is((select count(*)::int from pg_policies where schemaname = 'public'
            and tablename in ('tenant_brands', 'tenant_brand_assets')
            and cmd = 'SELECT' and permissive = 'PERMISSIVE'),
  2::int, '38 both new tables carry a member-and-scope read policy, held ready for the day a table '
  || 'grant is decided — the grant is withheld today on the column reason (test 3)');

-- ---------------------------------------------------------------- 39-41 the member read
set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_full (case_name, rows) select 'a1_noscope', count(*)::int from public.get_tenant_brand_v1();
insert into t_out values ('scope_c1', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
insert into t_full (case_name, organisation_id, legal_name, config_version)
  select 'a1_c1', f.organisation_id, f.legal_name, f.config_version from public.get_tenant_brand_v1() f;
insert into t_out values ('scope_c2_forged', pg_temp.try_scope('22222222-2222-4222-8222-222222222222'));
reset role;

select is((select rows from t_full where case_name = 'a1_noscope'), 0::int,
  '39 a signed-in member with no scope reads no brand row at all: the read is scope-bound, not '
  || 'membership-bound (plan §4.3, AGENTS.md §4.1)');
select is((select organisation_id from t_full where case_name = 'a1_c1'),
  '11111111-1111-4111-8111-111111111111'::uuid,
  '40 under their own scope a member reads their tenant''s full row');
select is((select legal_name from t_full where case_name = 'a1_c1'), 'Company1 Geotechnics Pty Ltd',
  '41 and the columns the public projection refuses — legal_name and config_version — are here, for '
  || 'the surface that is allowed them (ADR-0004 §4)');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000b1';
insert into t_out values ('scope_b1_c2', pg_temp.try_scope('22222222-2222-4222-8222-222222222222'));
insert into t_full select 'b1_c2', f.organisation_id, f.legal_name, f.config_version, 1
  from public.get_tenant_brand_v1() f;
reset role;

select is((select count(*)::int from t_full
            where case_name = 'b1_c2' and organisation_id = '11111111-1111-4111-8111-111111111111'), 0::int,
  '42 a company2 member under the company2 scope never sees company1''s row: the other-tenant negative '
  || 'AGENTS.md §4.2 asks for, on a tenant-level table (the read takes no organisation argument)');

-- ---------------------------------------------------------------- 43-48 the write path
-- Run as the migration owner with the request GUCs set, because nothing grants this function to a
-- request role today (test 9). The gates are its own, so they are testable either way.
-- The member-read section above established a scope; clear it first, or the no-scope gate below
-- would be tested against a scope that is still set and would pass for the wrong reason.
select set_config('app.organisation_id', '', true);
insert into t_out values ('put_noscope', pg_temp.try_put('{"mode":"customer"}'::jsonb, '[]'::jsonb));

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a2';
insert into t_out values ('scope_a2', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
reset role;

insert into t_out values
  ('put_member_no_permission', pg_temp.try_put(
     '{"mode":"customer","displayName":"Company1 Geotechnics","documentPrefix":"CO1",'
     || '"primary":"#007F78","onPrimary":"#FFFFFF","accent":"#A48748","logoName":"logo.svg"}'::jsonb,
     '[]'::jsonb));

insert into public.role_permissions (organisation_id, role_id, area, level) values
  ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-000000000002', 'brand.admin', 'admin')
  on conflict (role_id, area) do nothing;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-4000-8000-0000000000a1';
insert into t_out values ('scope_a1_admin', pg_temp.try_scope('11111111-1111-4111-8111-111111111111'));
reset role;

insert into t_out values
  ('put_svg_with_script', pg_temp.try_put(
     jsonb_build_object('mode', 'customer', 'displayName', 'Company1 Geotechnics',
                        'documentPrefix', 'CO1', 'primary', '#007F78', 'onPrimary', '#FFFFFF',
                        'accent', '#A48748', 'logoName', 'evil.svg'),
     jsonb_build_array(jsonb_build_object('name', 'evil.svg', 'contentType', 'image/svg+xml',
       'contentBase64', encode(convert_to('<svg xmlns="http://www.w3.org/2000/svg">'
         || '<script>alert(1)</script></svg>', 'UTF8'), 'base64'))))),
  ('put_oversize', pg_temp.try_put(
     jsonb_build_object('mode', 'customer', 'displayName', 'Company1 Geotechnics',
                        'documentPrefix', 'CO1', 'primary', '#007F78', 'onPrimary', '#FFFFFF',
                        'accent', '#A48748', 'logoName', 'big.svg'),
     jsonb_build_array(jsonb_build_object('name', 'big.svg', 'contentType', 'image/svg+xml',
       'contentBase64', encode(convert_to(repeat('A', 65600), 'UTF8'), 'base64'))))),
  ('put_missing_logo', pg_temp.try_put(
     jsonb_build_object('mode', 'customer', 'displayName', 'Company1 Geotechnics',
                        'documentPrefix', 'CO1', 'primary', '#007F78', 'onPrimary', '#FFFFFF',
                        'accent', '#A48748', 'logoName', 'absent.svg'),
     '[]'::jsonb)),
  ('put_first', pg_temp.try_put(
     jsonb_build_object('mode', 'customer', 'displayName', 'Company1 Geotechnics',
                        'legalName', 'Company1 Geotechnics Pty Ltd', 'documentPrefix', 'CO1',
                        'primary', '#007F78', 'onPrimary', '#FFFFFF', 'accent', '#A48748',
                        'logoName', 'logo-v2.svg'),
     jsonb_build_array(jsonb_build_object('name', 'logo-v2.svg', 'contentType', 'image/svg+xml',
       'contentBase64', encode(convert_to('<svg xmlns="http://www.w3.org/2000/svg"/>', 'UTF8'), 'base64'))))),
  ('put_second', pg_temp.try_put(
     jsonb_build_object('mode', 'powered', 'displayName', 'Company1 Geotechnics',
                        'documentPrefix', 'CO1', 'primary', '#007F78', 'onPrimary', '#FFFFFF',
                        'accent', '#A48748', 'logoName', 'logo-v3.svg'),
     jsonb_build_array(jsonb_build_object('name', 'logo-v3.svg', 'contentType', 'image/svg+xml',
       'contentBase64', encode(convert_to('<svg xmlns="http://www.w3.org/2000/svg"/>', 'UTF8'), 'base64')))));

insert into t_brand (case_name, mode, display_name, logo_path, logo_bytes, show_powered_by)
  select 'after_write', b.mode, b.display_name, b.logo_path, b.logo_bytes, b.show_powered_by
    from public.load_public_brand('company1.terraoi.app') b;
insert into t_asset (case_name, rows) select 'v1_after', count(*)::int
  from public.load_public_brand_asset('company1.terraoi.app', 1, 'logo.svg');

select is((select result from t_out where case_name = 'put_noscope'), '28000',
  '43 a brand write without a scope refuses outright: there is no organisation argument to forge (§4.1)');
select is((select result from t_out where case_name = 'put_member_no_permission'), '42501',
  '44 an active member without the brand.admin permission cannot write the brand: branding is a '
  || 'customer-visible identity change, so it is permissioned, like knowledge publish is (FAQ-0006)');
select is((select result from t_out where case_name = 'put_svg_with_script'), '22023',
  '45 an SVG carrying a script element is rejected, not sanitized: plan §5.1 line 269 offers both and '
  || 'this slice ships no sanitizer (§4.8 documents the choice)');
select is((select result from t_out where case_name = 'put_oversize'), '22023',
  '46 the write path enforces the 64 KiB ceiling before the table''s own CHECK has to (#117)');
select is((select result from t_out where case_name = 'put_missing_logo'), '22023',
  '47 a logo named but not supplied fails the write: a half-brand that silently drops the logo is the '
  || 'failure the packet''s failure box forbids');
select is((select result from t_out where case_name = 'put_first'), '2',
  '48 the write bumps config_version (1 fixture -> 2): this migration is the first reader of a version '
  || 'column, so per ADR-0004 §4 it also owns the bump path and asserts the number moves');

select is((select logo_path from t_brand where case_name = 'after_write'), '3/logo-v3.svg',
  '49 the served path moves with the version: after two writes the brand points at v3, which is what '
  || 'makes the cache key and the immutable URL mean the same thing (§4.4, FAQ-0008)');
select is((select rows from t_asset where case_name = 'v1_after'), 1::int,
  '50 and v1''s bytes are still readable at v1: the version is in the path, so a URL a browser is '
  || 'already holding is never re-pointed at another tenant''s bytes by a write');

select * from finish();
rollback;
