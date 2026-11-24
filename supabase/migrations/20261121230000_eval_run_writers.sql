-- T-312 PR-5: scoped writers for eval_runs / eval_results (F35 persistence).
-- Timestamp after 20261121220000_evals.sql (#240). One migration per PR.
-- Rerun = new call = new run row; completed runs are never updated by these RPCs.

create or replace function public.record_eval_run_v1(
  p_organisation_id uuid,
  p_run jsonb,
  p_results jsonb
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid;
  v_actor uuid;
  v_run_id uuid;
  v_expert text;
  v_version text;
  v_chain jsonb;
  v_corpus text;
  v_status text;
  v_item jsonb;
  v_case_id uuid;
  v_score numeric;
  v_failure text;
  v_evidence jsonb;
  v_case_org uuid;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_org := public.current_organisation_id();
  v_actor := auth.uid();
  if v_actor is null or v_org is null or not public.is_active_member(v_org) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if not public.member_has_evals_review(v_org, 'write') then
    raise exception 'not permitted to record eval runs' using errcode = '42501';
  end if;
  if p_run is null or jsonb_typeof(p_run) <> 'object' then
    raise exception 'eval run body is required' using errcode = '22023';
  end if;
  if p_results is null or jsonb_typeof(p_results) <> 'array' then
    raise exception 'eval results must be a json array' using errcode = '22023';
  end if;

  v_expert := nullif(btrim(p_run ->> 'expert_key'), '');
  v_version := nullif(btrim(p_run ->> 'expert_version'), '');
  v_corpus := nullif(btrim(p_run ->> 'corpus_generation'), '');
  v_status := nullif(btrim(p_run ->> 'status'), '');
  v_chain := coalesce(p_run -> 'chain_config', '{}'::jsonb);

  if v_expert is null or v_version is null or v_corpus is null or v_status is null then
    raise exception 'eval run fields are incomplete' using errcode = '22023';
  end if;
  if v_status not in ('completed', 'discarded', 'failed') then
    raise exception 'eval run status must be completed, discarded or failed' using errcode = '22023';
  end if;
  if jsonb_typeof(v_chain) <> 'object' then
    raise exception 'chain_config must be a json object' using errcode = '22023';
  end if;
  if v_status = 'discarded' and jsonb_array_length(p_results) <> 0 then
    raise exception 'discarded eval runs carry no results' using errcode = '22023';
  end if;

  insert into public.eval_runs (
    organisation_id, expert_key, expert_version, chain_config, corpus_generation,
    status, started_at, finished_at
  ) values (
    v_org, v_expert, v_version, v_chain, v_corpus,
    v_status, now(), now()
  ) returning id into v_run_id;

  for v_item in select value from jsonb_array_elements(p_results)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'each eval result must be a json object' using errcode = '22023';
    end if;
    begin
      v_case_id := (v_item ->> 'case_id')::uuid;
    exception when others then
      raise exception 'eval result case_id is required' using errcode = '22023';
    end;
    if v_case_id is null then
      raise exception 'eval result case_id is required' using errcode = '22023';
    end if;

    select c.organisation_id into v_case_org
      from public.eval_cases c
     where c.id = v_case_id
       and c.organisation_id = v_org
       and c.status = 'approved';
    if not found then
      raise exception 'not permitted to record eval runs' using errcode = '42501';
    end if;

    if v_item ? 'score' and v_item ->> 'score' is not null and v_item ->> 'score' <> 'null' then
      v_score := (v_item ->> 'score')::numeric;
    else
      v_score := null;
    end if;
    v_failure := nullif(btrim(v_item ->> 'failure_class'), '');
    v_evidence := coalesce(v_item -> 'evidence', '[]'::jsonb);
    if jsonb_typeof(v_evidence) <> 'array' then
      raise exception 'eval result evidence must be a json array' using errcode = '22023';
    end if;

    insert into public.eval_results (
      organisation_id, run_id, case_id, score, failure_class, evidence
    ) values (
      v_org, v_run_id, v_case_id, v_score, v_failure, v_evidence
    );
  end loop;

  return v_run_id;
end;
$$;
comment on function public.record_eval_run_v1(uuid, jsonb, jsonb) is
  'Append-only F35 run writer: one new eval_runs row plus per-case eval_results. Reruns never update prior rows.';

revoke execute on function public.record_eval_run_v1(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_eval_run_v1(uuid, jsonb, jsonb) to authenticated;
