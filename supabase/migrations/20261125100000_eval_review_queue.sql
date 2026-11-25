-- T-303 eval review view: the server half the review screens need (plan §14.1 step 3, §6.2; #82, #102).
-- Builds on T-312's eval tables (20261121220000_evals.sql) and T-214's source audience (20261124140000).
--
-- What this adds, and why it is server-side rather than in the page:
-- 1. A case is visible only when every source version it names passes the same audience predicate as
--    retrieval (`source_audience_allows`). A Site A client_confidential case is invisible to a reviewer
--    outside Site A, through the RPCs and through direct SELECT (the RLS policy is re-created).
-- 2. `decide_eval_case_v1` adds what the T-303 packet requires of a decision: optimistic concurrency
--    (a second decision on a stale read is a 40001 conflict, never a silent overwrite), `edit` applies a
--    whitelisted set of fields and returns the case to `drafted`, `approve` is refused (55000) when a
--    named source version is no longer published/active/readable, an edit can never attach a version
--    the reviewer cannot read, and the case's data class is raised to the highest class it cites (§6.2).
-- 3. `review_eval_case_v1` keeps its signature (T-312 clients) and delegates to the same rules, so there
--    is one decision path.
--
-- Source references are read from the case payload exactly as T-312 writes them: `expectedEvidence[].
-- sourceVersionId` (approved cases) and `sourceVersionId:<uuid>` inside `expectedSource` (F34 drafts).

-- ---------------------------------------------------------------- helpers
create or replace function public.eval_case_source_version_ids(p_payload jsonb)
returns uuid[] language sql immutable set search_path = public, pg_temp as $$
  select coalesce(array_agg(distinct ref), '{}'::uuid[])
    from (
      select (e ->> 'sourceVersionId')::uuid as ref
        from jsonb_array_elements(
               case when jsonb_typeof(p_payload -> 'expectedEvidence') = 'array'
                    then p_payload -> 'expectedEvidence' else '[]'::jsonb end) as e
       where jsonb_typeof(e) = 'object'
         and (e ->> 'sourceVersionId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      union
      select m[1]::uuid
        from regexp_matches(
               case when jsonb_typeof(p_payload -> 'expectedSource') = 'string'
                    then p_payload ->> 'expectedSource' else '' end,
               'sourceVersionId:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})',
               'g') as m
    ) refs;
$$;
comment on function public.eval_case_source_version_ids(jsonb) is
  'Source version ids an eval case payload names (expectedEvidence[].sourceVersionId and sourceVersionId:<uuid> in expectedSource). Internal (T-303).';
revoke all on function public.eval_case_source_version_ids(jsonb) from public, anon, authenticated, service_role;

create or replace function public.eval_case_sources_visible(p_payload jsonb)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select not exists (
    select 1
      from unnest(public.eval_case_source_version_ids(p_payload)) as ref(id)
     where not exists (
       select 1
         from public.source_versions sv
        where sv.id = ref.id
          and sv.organisation_id = public.current_organisation_id()
          and public.source_audience_allows(sv.source_id)
     )
  );
$$;
comment on function public.eval_case_sources_visible(jsonb) is
  'True when every source version the case names is in the current tenant and its source audience admits the caller (T-303, §14.1 step 1). Granted to authenticated because the eval_cases RLS policy calls it.';
revoke all on function public.eval_case_sources_visible(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.eval_case_sources_visible(jsonb) to authenticated;

create or replace function public.eval_case_sources_valid(p_payload jsonb)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select not exists (
    select 1
      from unnest(public.eval_case_source_version_ids(p_payload)) as ref(id)
     where not exists (
       select 1
         from public.source_versions sv
        where sv.id = ref.id
          and sv.organisation_id = public.current_organisation_id()
          and sv.state = 'published'
          and public.source_is_readable(sv.source_id)
     )
  );
$$;
comment on function public.eval_case_sources_valid(jsonb) is
  'True when every source version the case names is published and its source is active and readable by the caller; a revoked source makes the case invalid (T-303). Internal.';
revoke all on function public.eval_case_sources_valid(jsonb) from public, anon, authenticated, service_role;

create or replace function public.eval_case_max_source_class(p_payload jsonb, p_floor text)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select x.dc from (
       select p_floor as dc
       union all
       select sv.data_class
         from public.source_versions sv
        where sv.id = any(public.eval_case_source_version_ids(p_payload))
          and sv.organisation_id = public.current_organisation_id()
     ) x
     order by public.data_class_rank(x.dc) desc nulls last
     limit 1),
    p_floor);
$$;
comment on function public.eval_case_max_source_class(jsonb, text) is
  'Highest data class among p_floor and the source versions a case names (§6.2 propagation; never lowers). Internal (T-303).';
revoke all on function public.eval_case_max_source_class(jsonb, text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- RLS: hide cases whose sources the reader cannot see
drop policy if exists eval_cases_member_read on public.eval_cases;
create policy eval_cases_member_read on public.eval_cases
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and public.member_has_evals_review(organisation_id, 'read')
    and public.eval_case_sources_visible(payload)
  );

-- ---------------------------------------------------------------- list / get for the review screens
create or replace function public.list_eval_review_queue_v1(
  p_organisation_id uuid,
  p_status text
) returns table (
  id uuid,
  case_key text,
  expert_key text,
  status text,
  origin text,
  case_type text,
  question text,
  data_class text,
  payload jsonb,
  approved_by uuid,
  approved_at timestamptz,
  updated_at timestamptz,
  author_is_caller boolean,
  sources_valid boolean,
  last_decision text,
  last_decided_at timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.set_tenant_scope(p_organisation_id);
  if p_status is not null and p_status not in ('drafted', 'approved') then
    raise exception 'status must be drafted, approved or null' using errcode = '22023';
  end if;
  if not public.member_has_evals_review(public.current_organisation_id(), 'read') then
    return;
  end if;

  return query
    select c.id, c.case_key, c.expert_key, c.status, c.origin, c.case_type, c.question, c.data_class,
           c.payload, c.approved_by, c.approved_at, c.updated_at,
           c.created_by = auth.uid(),
           public.eval_case_sources_valid(c.payload),
           r.decision, r.created_at
      from public.eval_cases c
      left join lateral (
        select er.decision, er.created_at
          from public.eval_reviews er
         where er.case_id = c.id and er.organisation_id = c.organisation_id
         order by er.created_at desc, er.id desc
         limit 1
      ) r on true
     where c.organisation_id = public.current_organisation_id()
       and (p_status is null or c.status = p_status)
       and public.eval_case_sources_visible(c.payload)
     order by c.expert_key, c.status, c.case_key, c.id;
end;
$$;
comment on function public.list_eval_review_queue_v1(uuid, text) is
  'T-303 review queue: cases the caller may review (evals.review read+) whose named sources pass the retrieval audience predicate. Empty when unentitled; no existence signal.';
revoke all on function public.list_eval_review_queue_v1(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.list_eval_review_queue_v1(uuid, text) to authenticated;

create or replace function public.get_eval_review_case_v1(
  p_organisation_id uuid,
  p_case_id uuid
) returns table (
  id uuid,
  case_key text,
  expert_key text,
  status text,
  origin text,
  case_type text,
  question text,
  data_class text,
  payload jsonb,
  approved_by uuid,
  approved_at timestamptz,
  updated_at timestamptz,
  author_is_caller boolean,
  sources_valid boolean,
  last_decision text,
  last_decided_at timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.set_tenant_scope(p_organisation_id);
  if p_case_id is null then
    return;
  end if;
  return query
    select q.*
      from public.list_eval_review_queue_v1(p_organisation_id, null) q
     where q.id = p_case_id;
end;
$$;
comment on function public.get_eval_review_case_v1(uuid, uuid) is
  'T-303 case detail: one row from the review queue, or none (other tenant, hidden source, unentitled) — the same answer for every withheld case.';
revoke all on function public.get_eval_review_case_v1(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_eval_review_case_v1(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- the one decision path
create or replace function public.decide_eval_case_v1(
  p_organisation_id uuid,
  p_case_id uuid,
  p_decision text,
  p_edits jsonb,
  p_expected_updated_at timestamptz
) returns timestamptz
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid;
  v_actor uuid;
  v_case public.eval_cases%rowtype;
  v_edits jsonb := coalesce(p_edits, '{}'::jsonb);
  v_key text;
  v_payload jsonb;
  v_question text;
  v_case_type text;
  v_point jsonb;
  v_ev jsonb;
  v_now timestamptz := clock_timestamp();
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_org := public.current_organisation_id();
  v_actor := auth.uid();
  if not public.member_has_evals_review(v_org, 'write') then
    raise exception 'not permitted to review eval cases' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approve', 'edit', 'reject') then
    raise exception 'decision must be approve, edit or reject' using errcode = '22023';
  end if;
  if jsonb_typeof(v_edits) <> 'object' then
    raise exception 'edits must be an object' using errcode = '22023';
  end if;
  if p_decision <> 'edit' and v_edits <> '{}'::jsonb then
    raise exception 'only an edit carries edits' using errcode = '22023';
  end if;

  select * into v_case
    from public.eval_cases c
   where c.id = p_case_id
     and c.organisation_id = v_org
   for update;
  -- Hidden and absent answer alike: no existence signal for another tenant's or a hidden case.
  if not found or not public.eval_case_sources_visible(v_case.payload) then
    raise exception 'not permitted to review eval cases' using errcode = '42501';
  end if;
  if v_case.created_by = v_actor then
    raise exception 'author cannot review their own draft' using errcode = '42501';
  end if;
  if p_expected_updated_at is not null and v_case.updated_at <> p_expected_updated_at then
    raise exception 'the case changed since it was read' using errcode = '40001';
  end if;

  if p_decision = 'approve' then
    if v_case.status = 'approved' then
      raise exception 'the case is already approved' using errcode = '40001';
    end if;
    if not public.eval_case_sources_valid(v_case.payload) then
      raise exception 'an expected source is revoked or no longer readable' using errcode = '55000';
    end if;
    update public.eval_cases
       set status = 'approved', approved_by = v_actor, approved_at = v_now, updated_at = v_now
     where id = v_case.id and organisation_id = v_org;

  elsif p_decision = 'reject' then
    update public.eval_cases
       set status = 'drafted', approved_by = null, approved_at = null, updated_at = v_now
     where id = v_case.id and organisation_id = v_org;

  else -- edit
    if v_edits = '{}'::jsonb then
      raise exception 'an edit must change something' using errcode = '22023';
    end if;
    for v_key in select jsonb_object_keys(v_edits) loop
      if v_key not in ('question', 'caseType', 'expectedAnswerPoints', 'expectedSource', 'expectedEvidence') then
        raise exception 'field % cannot be edited here', v_key using errcode = '22023';
      end if;
    end loop;

    v_question := v_case.question;
    if v_edits ? 'question' then
      if jsonb_typeof(v_edits -> 'question') <> 'string'
         or char_length(btrim(v_edits ->> 'question')) not between 1 and 4000 then
        raise exception 'question must be 1-4000 characters' using errcode = '22023';
      end if;
      v_question := btrim(v_edits ->> 'question');
    end if;

    v_case_type := v_case.case_type;
    if v_edits ? 'caseType' then
      if jsonb_typeof(v_edits -> 'caseType') <> 'string'
         or (v_edits ->> 'caseType') not in ('answerable', 'needs_clarification', 'must_refuse', 'out_of_scope') then
        raise exception 'unknown case type' using errcode = '22023';
      end if;
      v_case_type := v_edits ->> 'caseType';
    end if;

    if v_edits ? 'expectedAnswerPoints' then
      if jsonb_typeof(v_edits -> 'expectedAnswerPoints') <> 'array'
         or jsonb_array_length(v_edits -> 'expectedAnswerPoints') not between 1 and 50 then
        raise exception 'expected answer points must be a list of 1-50 items' using errcode = '22023';
      end if;
      for v_point in select * from jsonb_array_elements(v_edits -> 'expectedAnswerPoints') loop
        if jsonb_typeof(v_point) <> 'string' or char_length(btrim(v_point #>> '{}')) not between 1 and 2000 then
          raise exception 'each expected answer point must be 1-2000 characters' using errcode = '22023';
        end if;
      end loop;
    end if;

    if v_edits ? 'expectedSource' then
      if jsonb_typeof(v_edits -> 'expectedSource') <> 'string'
         or char_length(btrim(v_edits ->> 'expectedSource')) not between 1 and 2000 then
        raise exception 'expected source must be 1-2000 characters' using errcode = '22023';
      end if;
    end if;

    if v_edits ? 'expectedEvidence' then
      if jsonb_typeof(v_edits -> 'expectedEvidence') <> 'array' then
        raise exception 'expected evidence must be a list' using errcode = '22023';
      end if;
      for v_ev in select * from jsonb_array_elements(v_edits -> 'expectedEvidence') loop
        if jsonb_typeof(v_ev) <> 'object' or (v_ev ->> 'kind') is distinct from 'chunk'
           or coalesce(v_ev ->> 'sourceVersionId', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception 'expected evidence entries must be chunk locators with a source version id' using errcode = '22023';
        end if;
      end loop;
    end if;

    v_payload := v_case.payload || (v_edits - 'question' - 'caseType')
                 || jsonb_build_object('question', v_question, 'caseType', v_case_type);

    -- An answerable case must still name a source after the edit (an answer-point list naming none is invalid).
    if v_case_type = 'answerable' and cardinality(public.eval_case_source_version_ids(v_payload)) = 0 then
      raise exception 'an answerable case must name at least one expected source version' using errcode = '22023';
    end if;
    -- Never attach a version the reviewer may not read.
    if not public.eval_case_sources_visible(v_payload) then
      raise exception 'not permitted to attach that source' using errcode = '42501';
    end if;

    update public.eval_cases
       set question = v_question,
           case_type = v_case_type,
           payload = v_payload,
           data_class = public.eval_case_max_source_class(v_payload, v_case.data_class),
           status = 'drafted', approved_by = null, approved_at = null,
           updated_at = v_now
     where id = v_case.id and organisation_id = v_org;
  end if;

  insert into public.eval_reviews (organisation_id, case_id, reviewer_id, decision, edits, created_at)
  values (v_org, v_case.id, v_actor, p_decision, v_edits, v_now);

  return v_now;
end;
$$;
comment on function public.decide_eval_case_v1(uuid, uuid, text, jsonb, timestamptz) is
  'T-303 decision: approve/edit/reject by a non-author evals.review writer; stale read → 40001; approve with a revoked/unreadable source → 55000; edit applies whitelisted fields, returns the case to drafted and raises its data class to the highest cited class.';
revoke all on function public.decide_eval_case_v1(uuid, uuid, text, jsonb, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.decide_eval_case_v1(uuid, uuid, text, jsonb, timestamptz) to authenticated;

-- T-312's client keeps its signature and now goes through the same rules (no concurrency token).
create or replace function public.review_eval_case_v1(
  p_organisation_id uuid,
  p_case_id uuid,
  p_decision text,
  p_edits jsonb
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.decide_eval_case_v1(p_organisation_id, p_case_id, p_decision, p_edits, null);
end;
$$;
comment on function public.review_eval_case_v1(uuid, uuid, text, jsonb) is
  'Scoped review (#82); since T-303 delegates to decide_eval_case_v1 so there is one decision path.';
revoke all on function public.review_eval_case_v1(uuid, uuid, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.review_eval_case_v1(uuid, uuid, text, jsonb) to authenticated;
