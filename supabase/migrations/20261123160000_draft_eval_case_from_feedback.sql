-- T-312 PR-9: draft_eval_case_from_feedback_v1 (#102 / plan §14.1 step 5).
-- Timestamp after 20261121230000 (PR-5 run writers). Does not edit merged migrations.
--
-- Feedback-derived cases stay in the database only (origin = 'pilot'); export already omits them.
-- derived_from_* are stored as opaque tenant UUIDs today — composite FKs onto agent_runs/messages
-- land after T-104 (#178) merges (columns already exist from PR-2).

create unique index if not exists eval_cases_pilot_message_unique
  on public.eval_cases (organisation_id, derived_from_message_id)
  where origin = 'pilot' and derived_from_message_id is not null;

comment on index public.eval_cases_pilot_message_unique is
  'One pilot draft per rated message (#102); duplicate Incorrect/Suggest-correction saves do not double-book.';

create or replace function public.draft_eval_case_from_feedback_v1(
  p_organisation_id uuid,
  p_body jsonb
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid;
  v_actor uuid;
  v_id uuid;
  v_expert text;
  v_question text;
  v_data_class text;
  v_case_type text;
  v_rating text;
  v_run_id uuid;
  v_message_id uuid;
  v_case_key text;
  v_payload jsonb;
  v_run_text text;
  v_msg_text text;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_org := public.current_organisation_id();
  v_actor := auth.uid();
  if v_actor is null or v_org is null or not public.is_active_member(v_org) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception 'feedback draft body is required' using errcode = '22023';
  end if;

  v_expert := nullif(btrim(p_body ->> 'expert_key'), '');
  v_question := nullif(btrim(p_body ->> 'question'), '');
  v_data_class := nullif(btrim(p_body ->> 'data_class'), '');
  v_case_type := coalesce(nullif(btrim(p_body ->> 'case_type'), ''), 'must_refuse');
  v_rating := nullif(btrim(p_body ->> 'rating'), '');
  v_run_text := nullif(btrim(p_body ->> 'derived_from_run_id'), '');
  v_msg_text := nullif(btrim(p_body ->> 'derived_from_message_id'), '');
  v_payload := coalesce(p_body -> 'payload', '{}'::jsonb);

  if v_expert is null or v_question is null or v_data_class is null
     or v_rating is null or v_run_text is null or v_msg_text is null then
    raise exception 'feedback draft fields are incomplete' using errcode = '22023';
  end if;
  if v_rating not in ('incorrect', 'suggest_correction') then
    raise exception 'rating must be incorrect or suggest_correction' using errcode = '22023';
  end if;
  if not public.data_class_is_valid(v_data_class) then
    raise exception 'data_class is not valid' using errcode = '22023';
  end if;
  if v_case_type not in ('answerable', 'needs_clarification', 'must_refuse', 'out_of_scope') then
    raise exception 'case_type is not valid' using errcode = '22023';
  end if;

  begin
    v_run_id := v_run_text::uuid;
    v_message_id := v_msg_text::uuid;
  exception when invalid_text_representation then
    raise exception 'derived_from ids must be uuids' using errcode = '22023';
  end;

  v_case_key := 'PILOT-'
    || upper(substr(replace(v_run_id::text, '-', ''), 1, 8))
    || '-'
    || upper(substr(replace(v_message_id::text, '-', ''), 1, 8));

  v_payload := v_payload || jsonb_build_object('rating', v_rating);

  insert into public.eval_cases (
    organisation_id, case_key, expert_key, status, origin, case_type, question,
    data_class, payload, created_by, drafted_by, drafted_on,
    derived_from_run_id, derived_from_message_id
  ) values (
    v_org, v_case_key, v_expert, 'drafted', 'pilot', v_case_type, v_question,
    v_data_class, v_payload, v_actor, 'pilot-feedback', (timezone('utc', now()))::date,
    v_run_id, v_message_id
  ) returning id into v_id;

  return v_id;
exception
  when unique_violation then
    raise exception 'pilot draft already exists for this message' using errcode = '23505';
end;
$$;

comment on function public.draft_eval_case_from_feedback_v1(uuid, jsonb) is
  'T-302 calls this on Incorrect / Suggest correction (#102). Always origin=pilot; never exported to evals/.';

revoke all on function public.draft_eval_case_from_feedback_v1(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.draft_eval_case_from_feedback_v1(uuid, jsonb) to authenticated;
