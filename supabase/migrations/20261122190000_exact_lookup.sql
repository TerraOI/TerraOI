-- T-216 Migration: `exact_lookup_v1` — deterministic identifier match before hybrid search.
-- Plan §8.1 step 4, §8.2, ADR-0008 (returns text, never offsets); FAQ-0011 / #163 tenant scope;
-- FAQ-0010 / #60 revoke-and-grant by full signature. Slot `070` (COORDINATION §6b).
-- Timestamp claim (COORDINATION §3): `20261122190000`, later than every migration on `main` and later
-- than in-flight open-PR timestamps through `20261121230000_eval_run_writers.sql`. Exactly one
-- migration in this PR; never edit merged ones.
--
-- Signature, in that order — p_organisation_id, p_service_keys, p_project_id, p_collection_ids,
-- p_identifier, p_limit.
--
-- Invariants this migration encodes:
--   * SECURITY INVOKER, reader only (#136). Same published/active filters as search_corpus_v1 so
--     revoke stops matches in the same session with no re-index (F14).
--   * First statement is `perform public.set_tenant_scope(p_organisation_id)` (FAQ-0011). Volatile.
--   * Pre-existing mismatched scope → 28000. Foreign/unknown project → 42501 (not an empty match).
--   * Match kinds: verbatim case-insensitive phrase in `knowledge_chunks.body_text` (`body_phrase`),
--     or case-insensitive equality against `source_versions.payload->>'filename'` (`filename`) with
--     the version's lowest chunk_index returned as the locator carrier. No offsets (ADR-0008).
--   * Another tenant's identifier yields zero rows (no existence signal). Empty ≠ failure.
--   * `p_service_keys` / `p_collection_ids` only narrow; null service_keys is refused (22023).

create or replace function public.exact_lookup_v1(
  p_organisation_id uuid,
  p_service_keys text[],
  p_project_id uuid,
  p_collection_ids uuid[],
  p_identifier text,
  p_limit integer
) returns table (
  o_organisation_id uuid,
  o_collection_id uuid,
  o_project_id uuid,
  o_source_id uuid,
  o_source_version_id uuid,
  o_chunk_id uuid,
  o_chunk_index integer,
  o_body_text text,
  o_locator jsonb,
  o_data_class text,
  o_content_hash text,
  o_published_at timestamptz,
  o_service_key text,
  o_match_kind text,
  o_rank integer
)
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_arrived_scope uuid := public.current_organisation_id();
  v_scope uuid;
  v_user uuid := auth.uid();
  v_limit integer := 12;
  v_needle text;
begin
  perform public.set_tenant_scope(p_organisation_id);

  if v_arrived_scope is not null and v_arrived_scope <> p_organisation_id then
    raise exception 'exact_lookup_v1: this transaction is already scoped to organization %, so it cannot look up %: the scope is not an argument to override (§4.1, #163)',
      v_arrived_scope, p_organisation_id using errcode = '28000';
  end if;

  v_scope := p_organisation_id;

  if v_user is null then
    raise exception 'exact_lookup_v1: no authenticated user' using errcode = '28000';
  end if;
  if not public.is_active_member(v_scope) then
    raise exception 'exact_lookup_v1: not an active member of this organization (§4.2)'
      using errcode = '28000';
  end if;

  if p_identifier is null or btrim(p_identifier) = '' then
    raise exception 'exact_lookup_v1: p_identifier must not be blank'
      using errcode = '22023';
  end if;
  if char_length(p_identifier) > 200 then
    raise exception 'exact_lookup_v1: p_identifier exceeds the 200-character bound'
      using errcode = '22023';
  end if;
  if p_service_keys is null then
    raise exception 'exact_lookup_v1: p_service_keys must be stated; an empty array means the tenant-wide corpus (§8.2)'
      using errcode = '22023';
  end if;
  if p_limit is not null and (p_limit < 1 or p_limit > 25) then
    raise exception 'exact_lookup_v1: p_limit must be between 1 and 25'
      using errcode = '22023';
  end if;
  v_limit := coalesce(p_limit, 12);
  v_needle := lower(btrim(p_identifier));

  if p_project_id is not null then
    if not exists (select 1 from public.projects pr
                    where pr.id = p_project_id and pr.organisation_id = v_scope) then
      raise exception 'exact_lookup_v1: project % is not readable in this scope (§4.2)', p_project_id
        using errcode = '42501';
    end if;
  end if;

  return query
  with visible as (
    select c.id as chunk_id,
           c.organisation_id,
           c.source_version_id,
           c.chunk_index,
           c.locator,
           c.body_text,
           c.data_class,
           s.id as source_id,
           col.id as collection_id,
           col.project_id,
           col.service_key,
           v.content_hash,
           v.published_at,
           v.payload,
           case
             when strpos(lower(c.body_text), v_needle) > 0 then 'body_phrase'
             when lower(coalesce(v.payload ->> 'filename', '')) = v_needle then 'filename'
             else null
           end as match_kind
      from public.knowledge_chunks c
      join public.source_versions v
        on v.id = c.source_version_id and v.organisation_id = c.organisation_id
      join public.knowledge_sources s
        on s.id = v.source_id and s.organisation_id = v.organisation_id
      join public.knowledge_collections col
        on col.id = v.collection_id and col.organisation_id = v.organisation_id
     where c.organisation_id = v_scope
       and v.state = 'published'
       and v.published_at is not null
       and s.lifecycle_state = 'active'
       and (p_collection_ids is null or col.id = any (p_collection_ids))
       and (cardinality(p_service_keys) = 0 or col.service_key = any (p_service_keys))
       and (p_project_id is null or col.project_id is null or col.project_id = p_project_id)
  ), matched as (
    -- Body-phrase: every chunk that carries the identifier. Filename: one row per version — the
    -- lowest chunk_index, which is the document carrier (ADR-0008 returns text, not an offset).
    select * from visible where match_kind = 'body_phrase'
    union all
    select distinct on (source_version_id) *
      from visible
     where match_kind = 'filename'
     order by source_version_id, chunk_index, chunk_id
  ), ranked as (
    select m.*,
           row_number() over (
             order by case m.match_kind when 'filename' then 0 else 1 end,
                      m.chunk_index, m.chunk_id
           )::integer as out_rank
      from matched m
  )
  select r.organisation_id,
         r.collection_id,
         r.project_id,
         r.source_id,
         r.source_version_id,
         r.chunk_id,
         r.chunk_index,
         r.body_text,
         r.locator,
         r.data_class,
         r.content_hash,
         r.published_at,
         r.service_key,
         r.match_kind,
         r.out_rank
    from ranked r
   where r.out_rank <= v_limit
   order by r.out_rank;
end;
$$;

comment on function public.exact_lookup_v1(uuid, text[], uuid, uuid[], text, integer) is
  'T-216 deterministic identifier lookup (plan §8.1 step 4): verbatim body phrase or payload filename under the querying role''s RLS (SECURITY INVOKER). First statement set_tenant_scope(p_organisation_id) (FAQ-0011). Returns text and locator, never character offsets (ADR-0008). Another tenant''s id yields zero rows.';

revoke execute on function
  public.exact_lookup_v1(uuid, text[], uuid, uuid[], text, integer)
  from public, anon, authenticated;

grant execute on function
  public.exact_lookup_v1(uuid, text[], uuid, uuid[], text, integer)
  to authenticated;
