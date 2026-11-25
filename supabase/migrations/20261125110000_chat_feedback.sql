-- T-302: answer feedback rows and the two reads the "Save as knowledge" form and the reviewer queue need
-- (plan §7.4, §6.1, §15.0 "Feedback buttons + Save as knowledge"; rulings #73, #39, #102).
--
-- 1. `chat_feedback`: one rating per user per run — Useful, Incorrect or Suggest correction (with text).
--    A rating is an evaluation signal: nothing here touches the stored answer, the run or a source.
--    Written only through `rate_answer_v1`, which requires the run to be the caller's own, in this
--    tenant, already completed; a second rating replaces the first (one signal per user per run).
-- 2. `list_submission_collections_v1`: collections the caller may read (`collection_is_readable`),
--    with their data class, for the audience picker. Submitting still re-checks everything
--    (`submit_employee_knowledge_v1`): this list only stops the form offering what will be refused.
-- 3. `list_knowledge_submissions_v1`: a reviewer (`user_may_review_knowledge`) sees submissions in
--    collections they can read, with an `author_is_caller` flag (the author is never an eligible
--    approver); anyone else sees only their own. Text is returned because the reviewer must read it;
--    the data class travels with it (§6.2).

-- ---------------------------------------------------------------- chat_feedback
create table public.chat_feedback (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  run_id uuid not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('useful', 'incorrect', 'suggest_correction')),
  correction_text text check (correction_text is null or char_length(correction_text) between 1 and 4000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chat_feedback_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint chat_feedback_run_fk
    foreign key (run_id, organisation_id) references public.agent_runs (id, organisation_id) on delete cascade,
  constraint chat_feedback_one_per_user_run unique (run_id, user_id),
  constraint chat_feedback_correction_only_for_suggestion
    check ((kind = 'suggest_correction') = (correction_text is not null))
);
comment on table public.chat_feedback is
  'T-302: one rating per user per run (plan §7.4). Evaluation signal only; never rewrites an answer.';

alter table public.chat_feedback enable row level security;
revoke all on table public.chat_feedback from public, anon, authenticated, service_role;
grant select on table public.chat_feedback to authenticated;

create policy chat_feedback_own_read on public.chat_feedback
  for select to authenticated
  using (
    organisation_id = public.current_organisation_id()
    and public.is_active_member(organisation_id)
    and user_id = auth.uid()
  );

create or replace function public.rate_answer_v1(
  p_organisation_id uuid,
  p_run_id uuid,
  p_kind text,
  p_correction_text text default null
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_org uuid;
  v_user uuid;
  v_run public.agent_runs%rowtype;
  v_text text := nullif(btrim(coalesce(p_correction_text, '')), '');
  v_id uuid;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_org := public.current_organisation_id();
  v_user := auth.uid();
  if p_kind is null or p_kind not in ('useful', 'incorrect', 'suggest_correction') then
    raise exception 'kind must be useful, incorrect or suggest_correction' using errcode = '22023';
  end if;
  if p_kind = 'suggest_correction' then
    if v_text is null or char_length(v_text) > 4000 then
      raise exception 'a suggested correction needs 1-4000 characters of text' using errcode = '22023';
    end if;
  elsif v_text is not null then
    raise exception 'only a suggested correction carries text' using errcode = '22023';
  end if;

  select * into v_run
    from public.agent_runs r
   where r.id = p_run_id
     and r.organisation_id = v_org;
  -- Someone else's run, another tenant's run and no run at all are the same refusal.
  if not found or v_run.requested_by <> v_user then
    raise exception 'not permitted to rate this answer' using errcode = '42501';
  end if;
  if v_run.status = 'running' then
    raise exception 'the answer has not been delivered yet' using errcode = '22023';
  end if;

  insert into public.chat_feedback (organisation_id, run_id, user_id, kind, correction_text)
  values (v_org, p_run_id, v_user, p_kind, v_text)
  on conflict (run_id, user_id) do update
     set kind = excluded.kind,
         correction_text = excluded.correction_text,
         updated_at = now()
  returning id into v_id;
  return v_id;
end;
$$;
comment on function public.rate_answer_v1(uuid, uuid, text, text) is
  'T-302: rate one of your own delivered answers; a second rating replaces the first. Correction text is stored as data, never followed (§4.8).';
revoke all on function public.rate_answer_v1(uuid, uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.rate_answer_v1(uuid, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------- audience picker
create or replace function public.list_submission_collections_v1(
  p_organisation_id uuid
) returns table (
  id uuid,
  key text,
  name text,
  data_class text,
  project_id uuid
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.set_tenant_scope(p_organisation_id);
  return query
    select c.id, c.key, c.name, c.data_class, c.project_id
      from public.knowledge_collections c
     where c.organisation_id = public.current_organisation_id()
       and public.collection_is_readable(c.id)
     order by c.name, c.id;
end;
$$;
comment on function public.list_submission_collections_v1(uuid) is
  'T-302: collections the caller may read, for the Save-as-knowledge audience picker. Submission re-checks (submit_employee_knowledge_v1).';
revoke all on function public.list_submission_collections_v1(uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_submission_collections_v1(uuid) to authenticated;

-- ---------------------------------------------------------------- reviewer queue / own submissions
create or replace function public.list_knowledge_submissions_v1(
  p_organisation_id uuid,
  p_state text
) returns table (
  id uuid,
  collection_id uuid,
  collection_name text,
  kind text,
  proposed_text text,
  data_class text,
  state text,
  cited_source_version_ids uuid[],
  author_is_caller boolean,
  created_at timestamptz,
  reviewed_at timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_reviewer boolean;
begin
  perform public.set_tenant_scope(p_organisation_id);
  if p_state is not null and p_state not in ('submitted', 'approved', 'rejected', 'withdrawn') then
    raise exception 'unknown submission state' using errcode = '22023';
  end if;
  v_reviewer := public.user_may_review_knowledge(public.current_organisation_id());

  return query
    select s.id, s.collection_id, c.name, s.kind, s.proposed_text, s.data_class, s.state,
           s.cited_source_version_ids, s.author_user_id = auth.uid(), s.created_at, s.reviewed_at
      from public.knowledge_submissions s
      join public.knowledge_collections c
        on c.id = s.collection_id and c.organisation_id = s.organisation_id
     where s.organisation_id = public.current_organisation_id()
       and (p_state is null or s.state = p_state)
       and public.collection_is_readable(s.collection_id)
       and (v_reviewer or s.author_user_id = auth.uid())
     order by s.created_at desc, s.id
     limit 200;
end;
$$;
comment on function public.list_knowledge_submissions_v1(uuid, text) is
  'T-302: reviewers (knowledge.write|admin) see submissions in collections they can read; others see their own. Capped at 200.';
revoke all on function public.list_knowledge_submissions_v1(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.list_knowledge_submissions_v1(uuid, text) to authenticated;
