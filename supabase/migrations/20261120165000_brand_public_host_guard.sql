-- T-103 residual: refuse comma-folded hosts on the public brand readers (Round 2 B4.3).
--
-- A Host list like `company1.terraoi.app,evil.example` previously fell through to the exact-host
-- join (0 rows). Safe, but unlabelled. Raise 22023 for `,` too, matching the "bare hostname"
-- message used for uppercase / port variants.
--
-- Body otherwise identical to 20261116210000_brand_config.sql. CREATE OR REPLACE keeps grants.

create or replace function public.load_public_brand(p_host text)
returns table (mode text, display_name text, descriptor text, tagline text,
               primary_color text, on_primary_color text, accent_color text,
               logo_path text, logo_bytes bigint, favicon_path text, favicon_bytes bigint,
               support_label text, support_url text, report_owner text,
               email_sender_name text, document_prefix text, show_powered_by boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  -- Same shape as resolve_tenant_host, plus `,` so a folded Host list cannot be guessed as a prefix.
  if p_host is null or p_host <> lower(btrim(p_host)) or p_host ~ '[[:space:]:/,]' then
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

create or replace function public.load_public_brand_asset(p_host text, p_config_version bigint, p_name text)
returns table (content_type text, content_base64 text, byte_size bigint)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_host is null or p_host <> lower(btrim(p_host)) or p_host ~ '[[:space:]:/,]' then
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
