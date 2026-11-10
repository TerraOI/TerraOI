-- T-103 second half: the brand configuration row and the customer brand assets (#62 ruled that
-- T-103 owns this migration). Plan §6.1 line 321 ("tenant brand: mode + validated configuration /
-- version"), §5.1 lines 261–273, §4.4 (public brand cache), F04.
--
-- Shape follows [ADR-0004 §4](../docs/decisions/0004-tenant-brand-contract.md) as written, with two
-- deviations that are stated rather than silent:
--   * `mode` is constrained to ('powered','customer'), i.e. the ADR's RECOMMENDED form. `terraoi`
--     needs a platform organisation row, and there is none: `terraoi.app` / `admin.terraoi.app` are
--     a code constant in src/platform/tenancy/host.ts, not tenant_domains rows (ADR-0004 note 2).
--     A tenant with no valid row still *shows* platform branding, through load-tenant-brand.ts's
--     fallback — that is a fallback, not a stored mode.
--   * `show_powered_by` is **not a column**. ADR-0004 §2 fixes it as "derived from `mode`, never
--     stored independently", and the merged validator (brand-rules.ts:190) refuses a row whose
--     attribution disagrees with its mode. The projections below compute it.
--
-- `config_version` follows `organisations.policy_revision`'s meaning (tenancy_core.sql:27-29) and
-- inherits its **unimplemented** convention (ADR-0004 §4: no merged trigger or RPC writes that one).
-- This migration is the first reader of a version column, so per the ADR it also owns the bump path
-- — put_tenant_brand_v1 below — and 026_brand_config.test.sql asserts that the number actually
-- moves and that the served asset path moves with it.
--
-- Assets are stored **in the row** (`content bytea`), because FAQ-0008 says customer assets are
-- "stored in `tenant_brand_assets`" and #38's object-storage path is still open. 64 KiB (#117) is
-- what makes that safe, and it is a CHECK, not a policy.

create table public.tenant_brand_assets (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  -- The asset belongs to one brand configuration version. The path FAQ-0008 serves
  -- (`/brand-assets/{configVersion}/{name}`) is this triple, so a version bump never invalidates a
  -- URL that a browser is still holding: v1 bytes stay readable while the brand points at v2.
  config_version bigint not null check (config_version > 0),
  -- One flat name, no path segments: the URL carries the version, and a name containing "/" or ".."
  -- is not an asset this table can describe. Extension must match the declared content type below.
  name text not null check (name ~ '^[a-z0-9][a-z0-9._-]{0,99}\.(svg|png|ico)$'),
  content_type text not null check (content_type in ('image/svg+xml', 'image/png', 'image/x-icon')),
  byte_size bigint not null check (byte_size between 1 and 65536),
  content bytea not null check (octet_length(content) between 1 and 65536),
  -- The stored length and the declared length are one fact, never two that can drift.
  constraint tenant_brand_assets_size_matches check (byte_size = octet_length(content)),
  constraint tenant_brand_assets_type_matches_name check (
    (name like '%.svg' and content_type = 'image/svg+xml')
    or (name like '%.png' and content_type = 'image/png')
    or (name like '%.ico' and content_type = 'image/x-icon')
  ),
  created_at timestamptz not null default now(),
  unique (organisation_id, config_version, name),
  unique (id, organisation_id),
  foreign key (organisation_id) references public.organisations (id) on delete cascade
);

comment on table public.tenant_brand_assets is
  'Customer brand assets (FAQ-0008). Host-resolved, versioned by path, 64 KiB ceiling (#117).
   No request-role table grant: reads go through load_public_brand_asset.';

create table public.tenant_brands (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  -- #62: a tenant may hold a brand row; only 'powered' and 'customer' are selectable by tenant
  -- configuration (plan §5.1 line 261–262, brand-rules.ts TENANT_BRAND_MODES).
  mode text not null check (mode in ('powered', 'customer')),
  -- Length ceilings are the merged validator's (brand-rules.ts BRAND_TEXT_LIMITS), not invented
  -- here: a row that the database accepts and the loader then refuses would show platform branding
  -- to a tenant that believes it configured its own.
  display_name text not null check (display_name ~ '^\S(.*\S)?$'
    and char_length(display_name) between 1 and 80),
  -- Never in the pre-sign-in projection (ADR-0004 §4). Not null-required: legalName has no kit
  -- source and arrives at provisioning (F05).
  legal_name text check (legal_name is null or (legal_name ~ '^\S(.*\S)?$'
    and char_length(legal_name) between 1 and 200)),
  descriptor text not null check (char_length(descriptor) between 1 and 120),
  tagline text not null check (char_length(tagline) between 0 and 200),
  report_owner text not null check (char_length(report_owner) between 1 and 80),
  email_sender_name text not null check (char_length(email_sender_name) between 1 and 80),
  -- A *display* name and an optional reply-to only. No sending-domain or credential column exists
  -- here, because #64 has not settled who owns the outbound transport and plan §5.1 line 271 is
  -- explicit that a display name does not establish domain authorization.
  email_reply_to text check (email_reply_to is null or email_reply_to = ''
    or email_reply_to ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'),
  document_prefix text not null check (document_prefix ~ '^[A-Z0-9][A-Z0-9.-]{1,11}$'),
  support_label text not null check (char_length(support_label) between 1 and 160),
  -- https only, and no credentials in the authority: brand-rules.ts:126 refuses an '@' because
  -- browsers accept https://admin:pw@host/ while readers do not.
  support_url text check (support_url is null or support_url ~ '^https://[^[:space:]@]+$'),
  primary_color text not null check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  on_primary_color text not null check (on_primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color text not null check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  -- Asset references by composite FK, so a brand can never point at another tenant's asset and a
  -- referenced asset always exists at the brand's current version.
  logo_asset_id uuid,
  favicon_asset_id uuid,
  -- plan §5.1 line 269 and §16: an unresolved placeholder never reaches a user. MUSTACHE covers
  -- '{{company}}'; the three literals are the kit's own template values (brand-rules.ts:56).
  constraint tenant_brands_no_placeholder check (
    display_name not like '%{{%' and descriptor not like '%{{%'
    and tagline not like '%{{%' and report_owner not like '%{{%'
    and support_label not like '%{{%' and email_sender_name not like '%{{%'
    and document_prefix not like '%{{%'
    and lower(btrim(display_name)) not in ('customer brand', 'customer', 'customer ops')
    and lower(btrim(report_owner)) not in ('customer brand', 'customer', 'customer ops')
  ),
  -- The backstop ADR-0004 §4 added at 28badf3 for a writer that forgets: these fields are stored as
  -- text and rendered as text, never interpolated into markup, and the contract keeps no style
  -- field. The primary guard is still the loader/writer; this CHECK only catches a writer that
  -- skips it, which is why it is a tag test rather than a sanitizer.
  constraint tenant_brands_names_are_plain_text check (
    display_name !~ '[<>]' and descriptor !~ '[<>]' and tagline !~ '[<>]'
    and report_owner !~ '[<>]' and support_label !~ '[<>]' and email_sender_name !~ '[<>]'
    and (legal_name is null or legal_name !~ '[<>]')
  ),
  -- Contrast is deliberately NOT a CHECK: a ratio needs both colours and a luminance function SQL
  -- does not have honestly (ADR-0004 §4). It is enforced by the writer (put_tenant_brand_v1 refuses
  -- nothing on contrast; the admin caller validates first) and re-checked on every read by
  -- parseTenantBrand (brand-rules.ts CONTRAST_MIN_RATIO / ACCENT_CONTRAST_MIN_RATIO), so a
  -- contrast failure can never reach a page even though the row is storable.
  config_version bigint not null default 1 check (config_version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_brands_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint tenant_brands_logo_asset_fk
    foreign key (logo_asset_id, organisation_id)
    references public.tenant_brand_assets (id, organisation_id) on delete restrict,
  constraint tenant_brands_favicon_asset_fk
    foreign key (favicon_asset_id, organisation_id)
    references public.tenant_brand_assets (id, organisation_id) on delete restrict,
  unique (organisation_id),          -- ASSUMPTION, labelled as such in ADR-0004 §4: one row per
                                     -- tenant, updated in place, versioned by config_version. A
                                     -- brand *history* would be unique (organisation_id,
                                     -- config_version) instead; nothing in this slice reads one.
  unique (id, organisation_id)
);

comment on table public.tenant_brands is
  'One validated brand row per tenant (#62, ADR-0004). Mode is tenant configuration, never a query
   parameter or header (plan §5.1 line 261). No request-role table grant: RLS filters rows, not
   columns, and legal_name / email_reply_to / config_version must not be readable pre-sign-in.';

create trigger tenant_brands_touch_updated before update on public.tenant_brands
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- RLS
-- Enabled, not FORCEd, exactly as tenancy_core.sql:252-255 explains: the definer helpers below are
-- owned by the migration role and must read without a policy, while every request role is filtered.
alter table public.tenant_brands enable row level security;
alter table public.tenant_brand_assets enable row level security;

-- Member-scoped and scope-scoped, the same predicate as tenant_domains_member_read
-- (tenancy_core.sql:277-282): a member of two tenants, working under one scope, must not read the
-- other tenant's brand configuration.
create policy tenant_brands_member_read on public.tenant_brands
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
  );

create policy tenant_brand_assets_member_read on public.tenant_brand_assets
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
  );

-- Supabase exposes a new `public` table to anon/authenticated automatically, and the blanket revoke
-- at tenancy_core.sql:335 reached only the tables that existed when it ran. Per object, never
-- blanket (the warning is written out at 20261106100000_knowledge_uploads.sql:591-596).
-- **No table grant is issued to any request role**, for the column reason ADR-0004 §4 states: a
-- member-scoped policy would still hand every signed-in member legal_name, email_reply_to and
-- config_version.
revoke all on public.tenant_brands from anon, authenticated;
revoke all on public.tenant_brand_assets from anon, authenticated;

-- ---------------------------------------------------------------- read projections

/**
 * F04's public brand read (ADR-0004 §4): one exact, active, tenant-class host in, the presentation
 * projection out. `config_version`, `legal_name` and the reply-to address are deliberately absent
 * from the returned columns; the version appears only *inside* the composed asset paths, because
 * FAQ-0008 puts the version in the URL and ADR-0004 §4 refuses it as a page fact.
 */
create or replace function public.load_public_brand(p_host text)
returns table (mode text, display_name text, descriptor text, tagline text,
               primary_color text, on_primary_color text, accent_color text,
               logo_path text, logo_bytes bigint, favicon_path text, favicon_bytes bigint,
               support_label text, support_url text, report_owner text,
               email_sender_name text, document_prefix text, show_powered_by boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  -- Same normalization guard resolve_tenant_host applies (tenancy_core.sql:238-240): a host that is
  -- not already a bare lowercase hostname is a caller bug or an attack, never something to guess at.
  if p_host is null or p_host <> lower(btrim(p_host)) or p_host ~ '[[:space:]:/]' then
    raise exception 'host must be a normalized bare hostname' using errcode = '22023';
  end if;
  return query
    select b.mode, b.display_name, b.descriptor, b.tagline,
           b.primary_color, b.on_primary_color, b.accent_color,
           case when la.id is null then null
                else b.config_version::text || '/' || la.name end,
           case when la.id is null then null else la.byte_size end,
           case when fa.id is null then null
                else b.config_version::text || '/' || fa.name end,
           case when fa.id is null then null else fa.byte_size end,
           b.support_label, b.support_url, b.report_owner, b.email_sender_name,
           b.document_prefix, (b.mode = 'powered')
      from public.tenant_domains d
      join public.organisations o on o.id = d.organisation_id
      join public.tenant_brands b on b.organisation_id = d.organisation_id
      left join public.tenant_brand_assets la
        on la.id = b.logo_asset_id and la.organisation_id = b.organisation_id
      left join public.tenant_brand_assets fa
        on fa.id = b.favicon_asset_id and fa.organisation_id = b.organisation_id
     where d.host = p_host                       -- exact host only, no suffix or alias matching
       and d.status = 'active'
       and d.kind = 'tenant'                     -- staging aliases: still open in ADR-0004 note 3
       and o.status = 'active';                  -- suspended tenants get no brand (F28)
end;
$$;

/**
 * FAQ-0008's asset read. Unknown host, version or name returns **no rows**, so the route answers one
 * identical 404 and cannot be probed for whether another tenant has an asset of that name.
 */
create or replace function public.load_public_brand_asset(p_host text, p_config_version bigint, p_name text)
returns table (content_type text, content_base64 text, byte_size bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_host is null or p_host <> lower(btrim(p_host)) or p_host ~ '[[:space:]:/]' then
    raise exception 'host must be a normalized bare hostname' using errcode = '22023';
  end if;
  -- A name that is not this table's own name shape is refused rather than searched for: `..`, a
  -- path separator or an uppercase variant can only be a probe.
  if p_name is null or p_name !~ '^[a-z0-9][a-z0-9._-]{0,99}\.(svg|png|ico)$' then
    raise exception 'asset name must be a single lowercase filename' using errcode = '22023';
  end if;
  return query
    -- `encode(content,'base64')` rather than the raw `bytea` on purpose: PostgREST renders `bytea` in
    -- the JSON body according to the connection's bytea_output, which is a wire detail this project
    -- must not depend on to decode a customer's logo. Base64 text is the same on every path.
    select a.content_type, encode(a.content, 'base64'), a.byte_size
      from public.tenant_domains d
      join public.organisations o on o.id = d.organisation_id
      join public.tenant_brand_assets a
        on a.organisation_id = d.organisation_id
       and a.config_version = p_config_version
       and a.name = p_name
     where d.host = p_host
       and d.status = 'active'
       and d.kind = 'tenant'
       and o.status = 'active';
end;
$$;

/**
 * The member/admin read of their own tenant's full row, including the columns the public projection
 * refuses. **No organisation argument**: the tenant comes from the transaction scope, which only
 * `set_tenant_scope` can establish after verifying membership (AGENTS.md §4.1 — never an org id from
 * a request argument).
 */
create or replace function public.get_tenant_brand_v1()
returns table (organisation_id uuid, mode text, display_name text, legal_name text,
               descriptor text, tagline text, report_owner text, email_sender_name text,
               email_reply_to text, document_prefix text, support_label text, support_url text,
               primary_color text, on_primary_color text, accent_color text,
               logo_asset_id uuid, favicon_asset_id uuid, config_version bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  return query
    select b.organisation_id, b.mode, b.display_name, b.legal_name, b.descriptor, b.tagline,
           b.report_owner, b.email_sender_name, b.email_reply_to, b.document_prefix,
           b.support_label, b.support_url, b.primary_color, b.on_primary_color, b.accent_color,
           b.logo_asset_id, b.favicon_asset_id, b.config_version
      from public.tenant_brands b
     where b.organisation_id = public.current_organisation_id()
       and public.is_active_member(b.organisation_id);
end;
$$;

-- ---------------------------------------------------------------- the write path

/**
 * One brand write, atomically: validate, insert the new version's assets, point the row at them,
 * bump `config_version`. It takes the brand and the assets as jsonb because the caller that builds
 * this call is the admin surface (T-202, slot 013), which does not exist yet — see the grant note
 * below, which is why nothing can reach this function today.
 *
 * What it validates is what SQL can validate honestly (shapes, placeholders, mode, size, extension
 * and content-type agreement, and an SVG that carries a script or an event handler — plan §5.1
 * "sanitize or reject uploaded SVG/HTML", decided here as *reject*: no sanitizer ships in this
 * slice). Contrast is **not** validated here: a ratio needs the WCAG luminance maths, which lives
 * in brand-rules.ts and is re-applied on every read, so a bad-contrast row is stored and then
 * refused by the loader rather than silently shown.
 */
create or replace function public.put_tenant_brand_v1(p_brand jsonb, p_assets jsonb)
returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid := public.current_organisation_id();
  v_version bigint;
  v_asset jsonb;
  v_name text;
  v_kind text;
  v_bytes bytea;
  v_svg text;
  v_brand public.tenant_brands%rowtype;
begin
  if v_org is null then
    raise exception 'a tenant scope is required to write a brand' using errcode = '28000';
  end if;
  if not public.is_active_member(v_org) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  -- Branding is a customer-visible identity change, so it is permissioned, not merely membership:
  -- the same area/level shape knowledge's publish predicate uses (FAQ-0006). The area is 'brand.admin'.
  if not exists (
    select 1
      from public.membership_roles mr
      join public.role_permissions rp on rp.role_id = mr.role_id
       and rp.organisation_id = mr.organisation_id
      join public.organisation_memberships m on m.id = mr.membership_id
     where m.organisation_id = v_org
       and m.user_id = auth.uid()
       and m.status = 'active'
       and rp.area = 'brand.admin'
       and rp.level in ('write', 'admin')
  ) then
    raise exception 'branding requires the brand.admin permission' using errcode = '42501';
  end if;

  if p_brand is null or jsonb_typeof(p_brand) <> 'object'
     or p_assets is null or jsonb_typeof(p_assets) <> 'array' then
    raise exception 'brand and assets are required' using errcode = '22023';
  end if;

  -- The row is built through the table's own CHECKs, so this function cannot accept a shape the
  -- schema would refuse; a violation surfaces as 23514 with the constraint name.
  v_brand.organisation_id := v_org;
  v_brand.mode := p_brand ->> 'mode';
  v_brand.display_name := p_brand ->> 'displayName';
  v_brand.legal_name := nullif(p_brand ->> 'legalName', '');
  v_brand.descriptor := coalesce(p_brand ->> 'descriptor', 'Operational Intelligence');
  v_brand.tagline := coalesce(p_brand ->> 'tagline', '');
  v_brand.report_owner := coalesce(p_brand ->> 'reportOwner', p_brand ->> 'displayName');
  v_brand.email_sender_name := coalesce(p_brand ->> 'emailSenderName', p_brand ->> 'displayName');
  v_brand.email_reply_to := nullif(p_brand ->> 'emailReplyTo', '');
  v_brand.document_prefix := p_brand ->> 'documentPrefix';
  v_brand.support_label := coalesce(p_brand ->> 'supportLabel', 'Contact your workspace administrator');
  v_brand.support_url := nullif(p_brand ->> 'supportUrl', '');
  v_brand.primary_color := p_brand ->> 'primary';
  v_brand.on_primary_color := p_brand ->> 'onPrimary';
  v_brand.accent_color := p_brand ->> 'accent';

  insert into public.tenant_brands as b (
    organisation_id, mode, display_name, legal_name, descriptor, tagline, report_owner,
    email_sender_name, email_reply_to, document_prefix, support_label, support_url,
    primary_color, on_primary_color, accent_color, config_version
  ) values (
    v_brand.organisation_id, v_brand.mode, v_brand.display_name, v_brand.legal_name,
    v_brand.descriptor, v_brand.tagline, v_brand.report_owner, v_brand.email_sender_name,
    v_brand.email_reply_to, v_brand.document_prefix, v_brand.support_label, v_brand.support_url,
    v_brand.primary_color, v_brand.on_primary_color, v_brand.accent_color,
    coalesce((select x.config_version from public.tenant_brands x where x.organisation_id = v_org), 0) + 1
  )
  on conflict (organisation_id) do update set
    mode = excluded.mode, display_name = excluded.display_name, legal_name = excluded.legal_name,
    descriptor = excluded.descriptor, tagline = excluded.tagline, report_owner = excluded.report_owner,
    email_sender_name = excluded.email_sender_name, email_reply_to = excluded.email_reply_to,
    document_prefix = excluded.document_prefix, support_label = excluded.support_label,
    support_url = excluded.support_url, primary_color = excluded.primary_color,
    on_primary_color = excluded.on_primary_color, accent_color = excluded.accent_color,
    config_version = excluded.config_version
  returning b.config_version into v_version;

  for v_asset in select jsonb_array_elements(p_assets) loop
    v_name := v_asset ->> 'name';
    v_kind := v_asset ->> 'contentType';
    v_bytes := decode(coalesce(v_asset ->> 'contentBase64', ''), 'base64');

    if v_name is null or v_kind is null or v_bytes is null or octet_length(v_bytes) = 0 then
      raise exception 'an asset needs name, contentType and contentBase64' using errcode = '22023';
    end if;
    if octet_length(v_bytes) > 65536 then
      raise exception 'brand assets are limited to 65536 bytes (#117)' using errcode = '22023';
    end if;

    -- Reject, not sanitize (plan §5.1 line 269): a script element, an event handler, or an external
    -- reference in an SVG is refused outright. No sanitizer ships in this slice.
    if v_kind = 'image/svg+xml' then
      begin
        v_svg := convert_from(v_bytes, 'UTF8');
      exception when others then
        raise exception 'an SVG brand asset must be valid UTF-8 text' using errcode = '22023';
      end;
      if v_svg ~* '<[[:space:]]*(script|iframe|object|embed)'
         or v_svg ~* '[[:space:]]on[a-z]+[[:space:]]*='
         or v_svg ~* '(xlink:)?href[[:space:]]*=' then
        raise exception 'an SVG brand asset may not carry scripts, handlers or external references'
          using errcode = '22023';
      end if;
    end if;

    insert into public.tenant_brand_assets (organisation_id, config_version, name, content_type, byte_size, content)
      values (v_org, v_version, v_name, v_kind, octet_length(v_bytes), v_bytes)
      on conflict (organisation_id, config_version, name) do nothing;
  end loop;

  -- Point the row at this version's assets. Unknown names are a caller error, not a silent drop:
  -- a logo that quietly disappears is exactly the half-brand the packet's failure box forbids.
  update public.tenant_brands b
     set logo_asset_id = (select a.id from public.tenant_brand_assets a
                           where a.organisation_id = v_org and a.config_version = v_version
                             and a.name = p_brand ->> 'logoName'),
         favicon_asset_id = (select a.id from public.tenant_brand_assets a
                              where a.organisation_id = v_org and a.config_version = v_version
                                and a.name = p_brand ->> 'faviconName')
   where b.organisation_id = v_org;

  if (p_brand ->> 'logoName') is not null
     and not exists (select 1 from public.tenant_brands b
                      where b.organisation_id = v_org and b.logo_asset_id is not null) then
    raise exception 'the named logo asset was not among the submitted assets' using errcode = '22023';
  end if;
  if (p_brand ->> 'faviconName') is not null
     and not exists (select 1 from public.tenant_brands b
                      where b.organisation_id = v_org and b.favicon_asset_id is not null) then
    raise exception 'the named favicon asset was not among the submitted assets' using errcode = '22023';
  end if;

  return v_version;
end;
$$;

-- ---------------------------------------------------------------- function privileges (FAQ-0010)
-- Every function this migration creates is revoked in the same transaction, by full signature,
-- from PUBLIC and both request roles: PostgreSQL hands EXECUTE to PUBLIC on creation and a
-- migration cannot close that default (20261109160000_function_privileges.sql section 4).
revoke execute on function
  public.load_public_brand(text),
  public.load_public_brand_asset(text, bigint, text),
  public.get_tenant_brand_v1(),
  public.put_tenant_brand_v1(jsonb, jsonb)
  from public, anon, authenticated;

-- Granted back by name, and each grant is a decision with a reason:
--   load_public_brand(text) — anon and authenticated: the sign-in surface must render a tenant's
--     brand before anyone is signed in (ADR-0004 §4, the same reason resolve_tenant_host is anon).
--   load_public_brand_asset(text, bigint, text) — anon only. An <img>/<link rel=icon> request
--     carries no bearer token, and this returns the same bytes every visitor of that host gets.
--   get_tenant_brand_v1() — authenticated only: a signed-in member/admin read of their own tenant.
--   put_tenant_brand_v1(jsonb, jsonb) — **no request role**, on purpose. Which member may change a
--     customer-visible identity is a security decision this slice does not make; the merged
--     precedent for a function that exists but is granted to nobody is 20261107024000_session_store.sql
--     (toi_identity, pending #75, pinned shut by 001_function_privileges.test.sql test 33). The
--     admin surface that needs it is T-202 (pgTAP slot 013), and the grant should travel with the
--     seeded `brand.admin` permission row, not arrive before it. 026_brand_config.test.sql proves
--     the function's own gates regardless of who can reach it.
grant execute on function public.load_public_brand(text) to anon, authenticated;
grant execute on function public.load_public_brand_asset(text, bigint, text) to anon;
grant execute on function public.get_tenant_brand_v1() to authenticated;
