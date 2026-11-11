-- T-114 Migration: `search_corpus_v1` — one hybrid reader (full text + vector, reciprocal-rank fusion)
-- in `public`, scoped by RLS, with bounded coverage diagnostics. Plan §8.1–§8.3, §6.2, §4.3; F08, F16.
-- Supersedes nothing; reads the tables of 20261105070000_knowledge_core.sql and the tenant scope of
-- 20261105060000_tenancy_core.sql.
--
-- Signature: plan §8.2, in that order — p_organisation_id, p_service_keys, p_project_id,
-- p_collection_ids, p_query_text, p_query_embedding, p_embedding_index_id, p_effective_on,
-- p_authority_filters, p_limit.
--
-- Invariants this migration encodes:
--   * SECURITY INVOKER, reader only (#136 ruling, plan §4.3). Every table it touches is reached under
--     the querying role's own policies, so the RPC can never be wider than the caller: revoking a
--     policy or a grant changes the result set, and there is no definer path that outranks RLS here.
--     It writes nothing: no INSERT/UPDATE/DELETE anywhere, no sequence, no outbox row (T-113 owns chunk
--     writes and the publish switch, #136).
--   * Tenant scope is established by this function, as its **first statement** (#163, FAQ-0011, plan
--     §4.3:245-247): `perform public.set_tenant_scope(p_organisation_id)`. The argument never confers
--     anything — `set_tenant_scope` (tenancy_core.sql:203-220) raises 28000 unless `auth.uid()` is an
--     active member of that organisation, and 22023 when it is null — so the caller can only ever pick
--     one of its own tenants, and every RLS policy still requires membership *and* the scope. Because a
--     scope is now always set before the first table is read, there is no unscoped corpus read to
--     forbid: the §4.3 "reads nothing without a scope" invariant is enforced by construction, not by a
--     gate. It also means the function is `volatile`, not `stable`: `set_config(..., true)` is volatile,
--     and a `stable` promise on a function that mutates a GUC is a lie to the planner (037:71 pins
--     `provolatile` from `pg_proc` by full signature; 037:72 pins the call precedes every read).
--   * A **pre-existing** scope is still honoured as a claim about which tenant this transaction is
--     working under: if the transaction arrived scoped to one organisation and `p_organisation_id`
--     names a different one, the call is refused (28000). `set_tenant_scope` would have accepted it —
--     a member of two tenants may legitimately choose either — but a reader must not be able to
--     re-point a transaction that another RPC in the same request already scoped, and "one request,
--     one tenant" is what keeps the host-derived context and the argument from ever disagreeing
--     (§4.1). **Code chosen: 28000, not 42501.** It is the class `set_tenant_scope` itself uses for
--     every scope/identity refusal (tenancy_core.sql:209, :215) and the class this RPC already used
--     for the same mismatch, so "you are not a member of that tenant" and "that is not the tenant you
--     are working under" answer identically and neither is a probe; `42501` stays reserved here for the
--     object-level claims — a foreign project or index id — where the *object* is the thing being
--     denied. #162 maps both classes to a tenancy refusal, never to an empty result (AGENTS.md §4.1).
--   * Every filter narrows. `p_collection_ids` and `p_service_keys` restrict what RLS already allows;
--     an id the caller may not read yields nothing rather than a grant (§4.2). `p_project_id` is the
--     one that raises when invalid (42501): a project is a scope claim, and a filter silently dropped
--     because the id was wrong is precisely the widening plan §8.2 forbids. Foreign and unknown ids
--     answer identically, so neither the project nor the index nor the collection list is probeable.
--   * The index identity is pinned, never assumed (§8.3, TOI-ADR-13): the vector lane resolves
--     `embedding_indexes` by id under RLS, requires `status = 'active'`, compares the query vector's
--     dimensions against `dimensions`, and uses **that row's** metric for distance. A retired,
--     dimension-mismatched or foreign index is an error (55000 / 42501), not a lower-quality search.
--     With no query vector the call still answers — the labelled `lexical_only` lane of §8.1 step 6 —
--     and says so in the diagnostics rather than pretending to be hybrid.
--   * Retrieval is narrower than visibility on purpose: `v.state = 'published'` and
--     `s.lifecycle_state = 'active'` sit on top of the read predicates, so a captured-but-unpublished
--     version is readable and unsearchable, and a revocation stops returning rows in the same session
--     with no re-index (F13, F14; knowledge_core.sql:460-474 documents that split).
--   * Spans are not computed here. The row carries `body_text` and the locator; `startChar`/`endChar`
--     are UTF-16 offsets into `knowledge_chunks.body_text` and only the Worker may derive them
--     (ADR-0008 rule 4). No object key, no URL, no signed grant, no storage reference is returned.
--   * An empty result and a failure are different answers. Refusals raise with a distinct SQLSTATE
--     (28000 scope/membership, 42501 foreign or invalid scope claim, 22023 malformed argument,
--     55000 index unavailable); a search that ran and found nothing returns one diagnostics row whose
--     `result_status` is `no_accessible_evidence` or `coverage_unknown`. `backend_failure` is never a
--     diagnostics value — it is the exception the caller catches, which is the whole distinction.
--   * Diagnostics are bounded and inventory-free: counts, flags, the resolved index identity and the
--     applied filters. Never an id, title or count of a row the caller may not read — the visible
--     counts come from the same RLS-filtered scan, so a hidden corpus is not observable through them
--     (§8.2: employee-facing messages must not disclose inaccessible records).
--   * `p_authority_filters` is refused rather than ignored, exactly as ruled on #161 (answer (A)):
--     source authority has no column in the merged schema (§7.1's taxonomy has no table yet), so
--     accepting the parameter and searching without it would return more rows than the caller asked
--     for. `NULL` or `'{}'` means no filter and answers normally; a **non-empty** array raises 22023;
--     and the `authority_filters_applied` diagnostic is a literal `false` in every row — never a value
--     derived from what the caller passed, so no caller can read a dropped filter as a satisfied
--     constraint. The PR that first stores an authority value replaces the refusal and the flag in a
--     **new** migration and updates `037`'s assertions; the packet records that handover.
--   * `p_effective_on` is evaluated against `source_versions.published_at` for the same reason (no
--     effective-interval columns exist yet — #161 answer (D)), and the ruled form of the comparison is
--     `published_at < ((p_effective_on + 1)::timestamp at time zone 'UTC')`: the date the caller asks
--     for names a **UTC calendar day**, so the cut falls at the first instant of the next UTC day.
--     `cast(published_at as date)` was the first cut and is wrong here — it depends on the session's
--     `TimeZone`, so the same call answers differently in two venues. `historical_gap` is set when
--     readable versions were published **after** that day; `coverage_unknown` when nothing qualifies at
--     it. Tenant-local dates belong to the locale work (#67, slot `015`), not to this reader.
--   * No new index. §8.3 starts from a measured exact-search baseline for pilot-sized corpora: the GIN
--     over the generated `search_vector` (knowledge_core.sql:275) and the composite
--     `(organisation_id, index_id, chunk_id)` key serve the pilot corpus, and HNSW plus
--     `hnsw.iterative_scans` tuning belongs to a PR that carries recall numbers (T-114's harness prints
--     the Recall@10 baseline; the index decision follows it, not this file).

-- The two-lane candidate budget is `p_limit` times this factor (§8.3 "tune candidate budgets"), and
-- the fusion constant is the reciprocal-rank default so the two lanes are combined the same way the
-- evals harness combines them.
create or replace function public.search_corpus_v1(
  p_organisation_id uuid,
  p_service_keys text[],
  p_project_id uuid,
  p_collection_ids uuid[],
  p_query_text text,
  p_query_embedding extensions.vector,
  p_embedding_index_id uuid,
  p_effective_on date,
  p_authority_filters text[],
  p_limit integer
) returns table (
  o_result_status text,
  o_evidence_kind text,
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
  o_index_generation integer,
  o_lane text,
  o_rank integer,
  o_lexical_rank integer,
  o_vector_rank integer,
  o_exact_match boolean,
  o_rrf_score numeric,
  o_diagnostics jsonb
)
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  -- Read in a declare *initializer*, before the body runs, because the body's first statement overwrites
  -- it: this is the only moment a pre-existing scope is still visible. An initializer is an expression
  -- evaluated on block entry, not a statement, so the ruled shape — the first **statement** is
  -- `perform public.set_tenant_scope(p_organisation_id);` — still holds (FAQ-0011, #163).
  v_arrived_scope uuid := public.current_organisation_id();
  v_scope uuid;
  v_user uuid := auth.uid();
  v_limit integer := 12;
  v_budget integer;
  v_index public.embedding_indexes;
  v_vector_lane boolean := (p_query_embedding is not null);
  v_query tsquery;
begin
  -- ---------------------------------------------------------------- the tenant scope (#163, FAQ-0011,
  -- plan §4.3:245-247): the first statement, in the same transaction as the work. This RPC establishes
  -- the scope it reads under, so a caller needs no pre-request hook, no direct connection and no forged
  -- claim, and an unscoped corpus read is impossible rather than merely refused. The argument confers
  -- nothing: `set_tenant_scope` raises 22023 for a null id, 28000 when `auth.uid()` is null and 28000
  -- when that user is not an active member of the named organisation (tenancy_core.sql:203-220), so the
  -- caller can only ever select one of its own tenants and every RLS policy below still requires
  -- membership *and* the scope. `set_config(..., true)` makes it transaction-local, so it cannot outlive
  -- this call on a pooled connection (§4.3:247, pinned by the merged `010` suite).
  perform public.set_tenant_scope(p_organisation_id);

  -- A transaction that arrived already scoped to a *different* organisation is refused, not re-pointed:
  -- `set_tenant_scope` would accept it (a member of two tenants may choose either), but a reader must not
  -- re-point a transaction another RPC in the same request already scoped — the host-derived context and
  -- the argument are never allowed to disagree (§4.1). The tenant-scope bullet in the header above states
  -- the code choice (28000) and why 42501 stays reserved for the object-level claims further down.
  if v_arrived_scope is not null and v_arrived_scope <> p_organisation_id then
    raise exception 'search_corpus_v1: this transaction is already scoped to organization %, so it cannot search %: the scope is not an argument to override (§4.1, #163)',
      v_arrived_scope, p_organisation_id using errcode = '28000';
  end if;

  v_scope := p_organisation_id;

  -- ---------------------------------------------------------------- the identity gates (§4.2). These re-read
  -- what `set_tenant_scope` just verified, deliberately: the tenancy gate belongs to this RPC too, so a
  -- later edit that drops the first statement fails here instead of turning the reader into a
  -- cross-tenant search. `auth.uid()` is what decides, never the GUC — that is the claim 037:33 pins.
  if v_user is null then
    raise exception 'search_corpus_v1: no authenticated user' using errcode = '28000';
  end if;
  if not public.is_active_member(v_scope) then
    raise exception 'search_corpus_v1: not an active member of this organization (§4.2)'
      using errcode = '28000';
  end if;

  -- ---------------------------------------------------------------- the argument bounds (§9.2: validate
  -- question size and limit at the boundary rather than discovering them mid-scan).
  if p_query_text is null or btrim(p_query_text) = '' then
    raise exception 'search_corpus_v1: p_query_text must not be blank: this RPC has no "return the corpus" mode'
      using errcode = '22023';
  end if;
  if char_length(p_query_text) > 2000 then
    raise exception 'search_corpus_v1: p_query_text exceeds the 2000-character question bound (§9.2)'
      using errcode = '22023';
  end if;
  if p_service_keys is null then
    raise exception 'search_corpus_v1: p_service_keys must be stated; an empty array means the tenant-wide corpus, a null would be an unasked-for widening (§8.2)'
      using errcode = '22023';
  end if;
  if p_authority_filters is not null and coalesce(array_length(p_authority_filters, 1), 0) > 0 then
    raise exception 'search_corpus_v1: authority filters cannot be evaluated by this corpus yet (§7.1); pass NULL or an empty array rather than a filter this RPC would drop (§8.2)'
      using errcode = '22023';
  end if;
  if p_limit is not null and (p_limit < 1 or p_limit > 25) then
    raise exception 'search_corpus_v1: p_limit must be between 1 and 25 evidence chunks (§8.3)'
      using errcode = '22023';
  end if;
  v_limit := coalesce(p_limit, 12);
  v_budget := v_limit * 6;

  -- ---------------------------------------------------------------- a claimed project scope must exist
  -- Same refusal for unknown, foreign-tenant and not-their-project, so a project id cannot be probed
  -- (§4.2). `projects` is itself scope-filtered by RLS, which is what makes "not readable here" the
  -- honest answer for all three cases at once.
  if p_project_id is not null then
    if not exists (select 1 from public.projects pr
                    where pr.id = p_project_id and pr.organisation_id = v_scope) then
      raise exception 'search_corpus_v1: project % is not readable in this scope (§4.2)', p_project_id
        using errcode = '42501';
    end if;
  end if;

  -- ---------------------------------------------------------------- the pinned index identity (§8.3)
  if p_embedding_index_id is not null then
    select * into v_index
      from public.embedding_indexes
     where id = p_embedding_index_id
       and organisation_id = v_scope;
    if not found then
      raise exception 'search_corpus_v1: embedding index % is not readable in this scope (§4.2)', p_embedding_index_id
        using errcode = '42501';
    end if;
    if v_index.status <> 'active' then
      raise exception 'search_corpus_v1: embedding index % generation % is %: no vector lane without an active pointer (§8.3)',
        v_index.index_key, v_index.generation, v_index.status using errcode = '55000';
    end if;
    if v_vector_lane and extensions.vector_dims(p_query_embedding) <> v_index.dimensions then
      raise exception 'search_corpus_v1: query embedding has % dimensions, index % generation % pins %: vectors from different models are incomparable (§12.4, TOI-ADR-13)',
        extensions.vector_dims(p_query_embedding), v_index.index_key, v_index.generation, v_index.dimensions
        using errcode = '55000';
    end if;
  elsif v_vector_lane then
    raise exception 'search_corpus_v1: a query vector needs the pinned index identity it was produced for (§8.3)'
      using errcode = '22023';
  end if;

  -- 'simple' analyzer, deliberately: no stemming of aviation or survey vocabulary in M1
  -- (knowledge_core.sql:250-254). `plainto_tsquery` is AND semantics, which is what an equipment
  -- model or provision number needs; the re-ranked phrase signal is `exact_match` below.
  v_query := plainto_tsquery('simple', p_query_text);

  return query
with candidates as (
  -- Everything the caller may read, published, and not revoked — before the effective-date cut. The
  -- joins are policy-bound because this function is SECURITY INVOKER: `chunk_is_readable` (RLS) already
  -- requires an active membership, this transaction's organization and the project audience, and the
  -- predicates below only narrow further (§6.2's effective read predicate).
  select c.id as chunk_id,
         c.organisation_id,
         c.source_version_id,
         c.chunk_index,
         c.locator,
         c.body_text,
         c.search_vector,
         c.data_class,
         s.id as source_id,
         col.id as collection_id,
         col.project_id,
         col.service_key,
         v.content_hash,
         v.published_at,
         -- The deterministic-lookup signal of §8.1 step 4: the question appears verbatim in this chunk.
         (strpos(lower(c.body_text), lower(p_query_text)) > 0) as exact_match
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
     -- A selected project excludes the *other* projects' corpora and keeps the tenant-wide corpus
     -- (§8.1 step 3: bindings plus accessible tenant-wide knowledge; never the reverse).
     and (p_project_id is null or col.project_id is null or col.project_id = p_project_id)
), visible as (
  -- #161 (D), with the supervisor's time-zone precision: `p_effective_on` names a UTC calendar day.
  -- `p_effective_on + 1` is a date; `::timestamp` makes it midnight with no zone attached; `at time
  -- zone 'UTC'` says that midnight *is* UTC, so the boundary is the first instant of the next UTC day
  -- and `<` keeps the whole asked day, 23:30 UTC included. The first cut here was
  -- `cast(published_at as date) <= p_effective_on`, which compares in the *session's* TimeZone and so
  -- lets the venue decide the answer; the ruling replaces it for exactly that reason.
  select * from candidates
   where p_effective_on is null
      or published_at < ((p_effective_on + 1)::timestamp at time zone 'UTC')
), lexical as (
  select chunk_id,
         row_number() over (order by lexical_score desc, exact_match desc, chunk_id) as lane_rank
    from (
      select chunk_id, exact_match,
             ts_rank(search_vector, v_query) as lexical_score
        from visible
       where search_vector @@ v_query
       order by lexical_score desc, exact_match desc, chunk_id
       limit v_budget
    ) matched
), vector_lane as (
  -- The metric comes from the pinned row, never from a default: cosine here because that is what this
  -- generation's row says (§12.4). No ANN index yet, so this is the exact scan of §8.3's baseline.
  select chunk_id,
         row_number() over (order by distance asc, chunk_id) as lane_rank
    from (
      select ce.chunk_id,
             -- The metric comes from the pinned row, never from a default, and the function names are
             -- the ones pgvector actually exposes at SQL level: `l2_distance`, `cosine_distance` and
             -- `vector_negative_inner_product`, which are exactly what the operators <->, <=> and <#>
             -- resolve to. There is no `vector_l2_distance` or `vector_cosine_distance` function: the
             -- first cut of this line asked for those and CI's database job answered `function
             -- extensions.vector_l2_distance(extensions.vector, extensions.vector) does not exist`,
             -- which is also why the calls are schema-qualified - this function pins its search_path
             -- to public, pg_temp (§4.3), so an unqualified pgvector name would not resolve either.
             case v_index.metric
               when 'l2' then extensions.l2_distance(ce.embedding, p_query_embedding)
               when 'ip' then extensions.vector_negative_inner_product(ce.embedding, p_query_embedding)
               else extensions.cosine_distance(ce.embedding, p_query_embedding)
             end as distance
        from public.chunk_embeddings ce
        join visible vv on vv.chunk_id = ce.chunk_id
       where v_vector_lane
         and ce.index_id = p_embedding_index_id
       order by distance asc, chunk_id
       limit v_budget
    ) nearest
), fused as (
  select f.chunk_id, f.organisation_id, f.source_version_id, f.chunk_index, f.locator, f.body_text,
         f.data_class, f.source_id, f.collection_id, f.project_id, f.service_key, f.content_hash,
         f.published_at, f.exact_match,
         l.lane_rank as lexical_rank,
         e.lane_rank as vector_rank,
         coalesce(1.0 / (60 + l.lane_rank), 0.0) + coalesce(1.0 / (60 + e.lane_rank), 0.0) as rrf_score,
         case when l.lane_rank is not null and e.lane_rank is not null then 'both'
              when l.lane_rank is not null then 'lexical'
              else 'vector' end as lane
    from visible f
    left join lexical l on l.chunk_id = f.chunk_id
    left join vector_lane e on e.chunk_id = f.chunk_id
    -- A chunk joins the answer only if a lane actually ranked it. `visible` is the corpus the caller
    -- may read, not a candidate set: leaving the unmatched rows in would emit every readable chunk with
    -- an rrf of zero beside the real hits, so a search that matched nothing would still "find" rows and
    -- the empty-versus-failure split of §8.2 would collapse (037 assertions 20, 21, 63).
    where l.lane_rank is not null or e.lane_rank is not null
), ranked_rows as (
  -- `exact_match` breaks a tie between the lanes: a deterministic hit outranks a semantic neighbour at
  -- the same fused score, which is §8.1 step 4 read literally, and the tie-break has to be written down
  -- somewhere or it is a coin flip that changes between runs.
  select f.*,
         row_number() over (order by f.rrf_score desc, f.exact_match desc,
                            f.lexical_rank nulls last, f.vector_rank nulls last, f.chunk_id) as out_rank
    from fused f
   order by f.rrf_score desc, f.exact_match desc,
            f.lexical_rank nulls last, f.vector_rank nulls last, f.chunk_id
   limit v_limit
), scope_stats as (
  -- #161 (D): `historical_gap` is the distance between the asked day and the corpus that exists now —
  -- readable versions published **after** that day. It is written as the exact negation of the
  -- `visible` cut (`>=` the first instant of the next UTC day) so a version can never fall into neither
  -- bucket and make the flag quietly wrong. Counted by *version*: the claim is about what was published
  -- later, not about how many chunks a later version happened to be split into.
  select count(distinct source_version_id) filter (
           where p_effective_on is not null
             and published_at >= ((p_effective_on + 1)::timestamp at time zone 'UTC')
         ) as later_versions
    from candidates
), coverage as (
  select count(*)::int as chunks_visible,
         count(distinct collection_id)::int as collections_visible,
         count(distinct source_version_id)::int as versions_visible,
         max(public.data_class_rank(data_class))::int as max_class_rank
    from visible
), embedded as (
  select count(*)::int as chunks_with_vectors
    from public.chunk_embeddings ce
    join visible vv on vv.chunk_id = ce.chunk_id
   where p_embedding_index_id is not null
     and ce.index_id = p_embedding_index_id
), outcome as (
  -- Which kind of empty this is (§8.2). Nothing readable and published in scope is a coverage claim;
  -- something readable that did not match is an evidence claim. Neither is an error.
  select case
           when exists (select 1 from ranked_rows) then 'ok'
           when (select chunks_visible from coverage) = 0 then 'coverage_unknown'
           else 'no_accessible_evidence'
         end as code
), diagnostics as (
  select jsonb_build_object(
    'schema_version', 1,
    'result_status', (select code from outcome),
    'retrieval_mode', case when v_vector_lane then 'hybrid' else 'lexical_only' end,
    'fusion', jsonb_build_object('method', 'reciprocal_rank', 'k', 60,
                                 'lanes', case when v_vector_lane then 2 else 1 end),
    'lanes', jsonb_build_object(
      'lexical', jsonb_build_object('queried', true,
                                    'matched', (select count(*)::int from lexical),
                                    'candidate_budget', v_budget),
      'vector', jsonb_build_object('queried', v_vector_lane,
                                   'matched', (select count(*)::int from vector_lane),
                                   'candidate_budget', v_budget,
                                   'index_id', p_embedding_index_id,
                                   'index_key', v_index.index_key,
                                   'model', v_index.model,
                                   'dimensions', v_index.dimensions,
                                   'metric', v_index.metric,
                                   'generation', v_index.generation)
    ),
    'coverage', jsonb_build_object(
      'collections_visible', (select collections_visible from coverage),
      'source_versions_visible', (select versions_visible from coverage),
      'chunks_visible', (select chunks_visible from coverage),
      'chunks_with_vectors', (select chunks_with_vectors from embedded)
    ),
    'filters', jsonb_build_object(
      'service_keys', p_service_keys,
      'collections_narrowed', p_collection_ids is not null,
      'project_applied', p_project_id is not null,
      'effective_on', p_effective_on,
      -- #161 (A), literally and always: this flag is a constant `false`, never a function of what the
      -- caller passed. A non-empty `p_authority_filters` already raised 22023 before this row could be
      -- built, and a caller that passed `NULL` or `'{}'` asked for no filter — so the only answer this
      -- field can honestly give is "no authority filter was applied". Deriving it from the argument is
      -- how a dropped filter starts reading as a satisfied constraint. It stays `false` when an empty
      -- array is accepted (037:68-69 pin both halves), and the PR that first stores an authority value
      -- changes it in a *new* migration.
      'authority_filters_applied', false
    ),
    'limits', jsonb_build_object('limit', v_limit,
                                 'returned', (select count(*)::int from ranked_rows),
                                 'truncated', (select count(*) from fused) > v_limit),
    'signals', jsonb_build_object(
      'coverage_unknown', (select chunks_visible from coverage) = 0,
      'historical_gap', (select later_versions from scope_stats) > 0,
      'index_unavailable', not v_vector_lane,
      'max_data_class', case
        when (select max_class_rank from coverage) is null then null
        else (select d.class
                from unnest(array['public', 'internal', 'client_confidential', 'restricted']) d(class)
               where public.data_class_rank(d.class) = (select max_class_rank from coverage)
                limit 1)
      end
    )
  ) as body
)
select (select code from outcome)::text,
       'chunk'::text,
       r.organisation_id,
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
       case when v_vector_lane then v_index.generation end::integer,
       r.lane::text,
       r.out_rank::integer,
       r.lexical_rank::integer,
       r.vector_rank::integer,
       r.exact_match,
       r.rrf_score::numeric,
       d.body
  from ranked_rows r
  cross join diagnostics d
union all
-- Zero evidence rows still answers exactly one row, so an empty result set is never confused with a
-- failure by the caller (§8.2; 037 asserts both halves of that).
select (select code from outcome)::text,
       'diagnostics'::text,
       null::uuid, null::uuid, null::uuid, null::uuid, null::uuid, null::uuid,
       null::integer, null::text, null::jsonb, null::text, null::text, null::timestamptz,
       null::text, null::integer, null::text, 1::integer, null::integer, null::integer,
       null::boolean, null::numeric,
       d.body
  from diagnostics d
 where not exists (select 1 from ranked_rows);
end;
$$;

comment on function public.search_corpus_v1(
  uuid, text[], uuid, uuid[], text, extensions.vector, uuid, date, text[], integer
) is
  'T-114 hybrid reader (plan §8.2): full-text and vector candidates fused by reciprocal rank, under the querying role''s RLS (SECURITY INVOKER, #136). Tenant: the first statement is perform public.set_tenant_scope(p_organisation_id) (#163, FAQ-0011, plan §4.3:245-247), so the scope is established inside this call under the caller''s own identity — p_organisation_id selects one of the tenants auth.uid() is an active member of and confers nothing by itself, and a transaction already scoped to a different organisation is refused (28000, the same class set_tenant_scope uses; 42501 is reserved here for foreign project or index ids). The function is volatile because set_config is volatile. Filters narrow (collections, services, project); an invalid project raises. p_effective_on is a UTC calendar day — the cut is published_at < the first instant of the next UTC day, never a session-time-zone date cast — with historical_gap when readable versions were published later and coverage_unknown when nothing qualifies at that date; p_authority_filters accepts NULL or ''{}'' and refuses a non-empty array (22023), and filters.authority_filters_applied is the constant false because no authority column exists yet (#161). The index identity is resolved and pinned, never assumed; with no query vector the labelled lexical_only lane answers. Reads only: no write path here (T-113 owns chunk writes and the publish switch). Output columns: o_body_text is the chunk body as stored — ADR-0008 rule 4 means this function returns text and never an offset, so the Worker derives the citation span from it; o_evidence_kind is ''chunk'' for an evidence row and ''diagnostics'' for the single row emitted when there is no evidence, so "empty" and "failed" cannot be confused (§8.2); o_diagnostics is bounded coverage reporting (counts, flags, the resolved index identity, the applied filters) and never an id or title of a row the caller may not read.';

-- ---------------------------------------------------------------- grants, per function by full signature
-- FAQ-0010 and 20261105210000_intake_service_role.sql:10-11: PostgreSQL hands EXECUTE on a new `public`
-- function to PUBLIC, and a migration cannot close that default
-- (20261109160000_function_privileges.sql section 4), so this function is revoked by name first and
-- granted back to exactly one role. Nothing goes to `anon`: knowledge is behind sign-in
-- (knowledge_core.sql:880-883), and 001's rule 31 would fail if it did.
revoke execute on function
  public.search_corpus_v1(uuid, text[], uuid, uuid[], text, extensions.vector, uuid, date, text[], integer)
  from public, anon, authenticated;

grant execute on function
  public.search_corpus_v1(uuid, text[], uuid, uuid[], text, extensions.vector, uuid, date, text[], integer)
  to authenticated;
