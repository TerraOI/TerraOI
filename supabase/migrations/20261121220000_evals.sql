-- T-312 PR-2: Evaluation tables + scoped review RPCs (#82, #102; plan §6.1 / §14.1).
-- Timestamp after 20261121210000 (T-211 outbox on #231). Does not edit merged migrations.
--
-- Tables: eval_cases, eval_reviews, eval_runs, eval_results.
-- Permission: seeded `evals.review` (write = approve/edit/reject, admin = export) on role
-- `eval_reviewer` / admin — see supabase/seed.sql. Approval requires a non-author reviewer.
-- Export omits origin = 'pilot' (#102). F35 runner / nightly are later slices.

-- ---------------------------------------------------------------- helpers
create or replace function public.member_has_evals_review(
  p_organisation_id uuid,
  p_min_level text
) returns boolean
language sql stable security definer set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.organisation_memberships m
      join public.membership_roles mr on mr.membership_id = m.id
      join public.role_permissions rp
        on rp.role_id = mr.role_id
       and rp.organisation_id = m.organisation_id
       and rp.area = 'evals.review'
       and (
         (p_min_level = 'write' and rp.level in ('write', 'admin'))
         or (p_min_level = 'admin' and rp.level = 'admin')
         or (p_min_level = 'read' and rp.level in ('read', 'write', 'admin'))
       )
     where m.organisation_id = p_organisation_id
       and m.user_id = auth.uid()
       and m.status = 'active'
  );
$$;
comment on function public.member_has_evals_review(uuid, text) is
  'True when the signed-in active member holds evals.review at or above p_min_level (#82). '
  'Granted to authenticated because RLS policies call it (same shape as is_active_member / collection_is_readable).';
revoke all on function public.member_has_evals_review(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.member_has_evals_review(uuid, text) to authenticated;

-- ---------------------------------------------------------------- eval_cases
create table public.eval_cases (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  case_key text not null check (char_length(case_key) between 1 and 64),
  expert_key text not null check (expert_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  status text not null default 'drafted' check (status in ('drafted', 'approved')),
  origin text not null check (origin in ('agent_drafted', 'expert_written', 'pilot')),
  case_type text not null check (case_type in ('answerable', 'needs_clarification', 'must_refuse', 'out_of_scope')),
  question text not null check (char_length(question) between 1 and 4000),
  data_class text not null,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_by uuid not null references public.profiles (id),
  drafted_by text not null check (char_length(drafted_by) between 1 and 200),
  drafted_on date not null,
  approved_by uuid references public.profiles (id),
  approved_at timestamptz,
  derived_from_run_id uuid,
  derived_from_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint eval_cases_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint eval_cases_data_class_valid
    check (public.data_class_is_valid(data_class)),
  constraint eval_cases_approved_fields
    check (
      (status = 'drafted' and approved_by is null and approved_at is null)
      or (status = 'approved' and approved_by is not null and approved_at is not null)
    ),
  constraint eval_cases_tenant_id_key unique (id, organisation_id),
  constraint eval_cases_case_key_unique unique (organisation_id, case_key, expert_key)
);
comment on table public.eval_cases is
  'Tenant-scoped evaluation cases (plan §6.1 / §14.1). F35 scores only status=approved with approved_by set; origin=pilot is excluded from fixture export (#102).';

create index eval_cases_org_status_idx on public.eval_cases (organisation_id, status);
create index eval_cases_org_expert_idx on public.eval_cases (organisation_id, expert_key);

alter table public.eval_cases enable row level security;
revoke all on table public.eval_cases from public, anon, authenticated, service_role;
grant select on table public.eval_cases to authenticated;

create policy eval_cases_member_read on public.eval_cases
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and public.member_has_evals_review(organisation_id, 'read')
  );

-- ---------------------------------------------------------------- eval_reviews
create table public.eval_reviews (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  case_id uuid not null,
  reviewer_id uuid not null references public.profiles (id),
  decision text not null check (decision in ('approve', 'edit', 'reject')),
  edits jsonb not null default '{}'::jsonb check (jsonb_typeof(edits) = 'object'),
  created_at timestamptz not null default now(),
  constraint eval_reviews_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint eval_reviews_case_fk
    foreign key (case_id, organisation_id)
    references public.eval_cases (id, organisation_id) on delete cascade,
  constraint eval_reviews_tenant_id_key unique (id, organisation_id)
);
comment on table public.eval_reviews is
  'Append-only review decisions for eval_cases (§14.1 step 3). Approval is recorded here and stamped onto the case.';

alter table public.eval_reviews enable row level security;
revoke all on table public.eval_reviews from public, anon, authenticated, service_role;
grant select on table public.eval_reviews to authenticated;

create policy eval_reviews_member_read on public.eval_reviews
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and public.member_has_evals_review(organisation_id, 'read')
  );

-- ---------------------------------------------------------------- eval_runs / eval_results (structure for F35)
create table public.eval_runs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  expert_key text not null check (expert_key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  expert_version text not null check (char_length(expert_version) between 1 and 64),
  chain_config jsonb not null default '{}'::jsonb check (jsonb_typeof(chain_config) = 'object'),
  corpus_generation text not null check (char_length(corpus_generation) between 1 and 128),
  status text not null default 'running' check (status in ('running', 'completed', 'discarded', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  constraint eval_runs_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint eval_runs_tenant_id_key unique (id, organisation_id)
);
comment on table public.eval_runs is
  'One row per F35 execution, bound to expert version, chain configuration and corpus generation (§6.1).';

create table public.eval_results (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  run_id uuid not null,
  case_id uuid not null,
  score numeric(5,4),
  failure_class text check (failure_class is null or char_length(failure_class) between 1 and 64),
  evidence jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence) = 'array'),
  created_at timestamptz not null default now(),
  constraint eval_results_organisation_fk
    foreign key (organisation_id) references public.organisations (id) on delete cascade,
  constraint eval_results_run_fk
    foreign key (run_id, organisation_id)
    references public.eval_runs (id, organisation_id) on delete cascade,
  constraint eval_results_case_fk
    foreign key (case_id, organisation_id)
    references public.eval_cases (id, organisation_id) on delete restrict,
  constraint eval_results_tenant_id_key unique (id, organisation_id),
  constraint eval_results_run_case_unique unique (run_id, case_id)
);
comment on table public.eval_results is
  'Per-case score and failure class for one eval_run (§6.1 / F35).';

alter table public.eval_runs enable row level security;
alter table public.eval_results enable row level security;
revoke all on table public.eval_runs from public, anon, authenticated, service_role;
revoke all on table public.eval_results from public, anon, authenticated, service_role;
grant select on table public.eval_runs to authenticated;
grant select on table public.eval_results to authenticated;

create policy eval_runs_member_read on public.eval_runs
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and public.member_has_evals_review(organisation_id, 'read')
  );
create policy eval_results_member_read on public.eval_results
  for select to authenticated
  using (
    public.is_active_member(organisation_id)
    and organisation_id = public.current_organisation_id()
    and public.member_has_evals_review(organisation_id, 'read')
  );

-- ---------------------------------------------------------------- RPCs
create or replace function public.create_eval_case_draft_v1(
  p_organisation_id uuid,
  p_body jsonb
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid;
  v_actor uuid;
  v_id uuid;
  v_case_key text;
  v_expert text;
  v_origin text;
  v_case_type text;
  v_question text;
  v_data_class text;
  v_drafted_by text;
  v_drafted_on date;
  v_payload jsonb;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_org := public.current_organisation_id();
  v_actor := auth.uid();
  if v_actor is null or v_org is null or not public.is_active_member(v_org) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' then
    raise exception 'eval case body is required' using errcode = '22023';
  end if;

  v_case_key := nullif(btrim(p_body ->> 'case_key'), '');
  v_expert := nullif(btrim(p_body ->> 'expert_key'), '');
  v_origin := nullif(btrim(p_body ->> 'origin'), '');
  v_case_type := nullif(btrim(p_body ->> 'case_type'), '');
  v_question := nullif(btrim(p_body ->> 'question'), '');
  v_data_class := nullif(btrim(p_body ->> 'data_class'), '');
  v_drafted_by := nullif(btrim(p_body ->> 'drafted_by'), '');
  v_drafted_on := (p_body ->> 'drafted_on')::date;
  v_payload := coalesce(p_body -> 'payload', '{}'::jsonb);

  if v_case_key is null or v_expert is null or v_origin is null or v_case_type is null
     or v_question is null or v_data_class is null or v_drafted_by is null or v_drafted_on is null then
    raise exception 'eval case draft fields are incomplete' using errcode = '22023';
  end if;

  insert into public.eval_cases (
    organisation_id, case_key, expert_key, status, origin, case_type, question,
    data_class, payload, created_by, drafted_by, drafted_on
  ) values (
    v_org, v_case_key, v_expert, 'drafted', v_origin, v_case_type, v_question,
    v_data_class, v_payload, v_actor, v_drafted_by, v_drafted_on
  ) returning id into v_id;

  return v_id;
end;
$$;
comment on function public.create_eval_case_draft_v1(uuid, jsonb) is
  'Scoped draft insert for eval_cases. Status is always drafted; claim/approval is review_eval_case_v1.';

create or replace function public.review_eval_case_v1(
  p_organisation_id uuid,
  p_case_id uuid,
  p_decision text,
  p_edits jsonb
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_org uuid;
  v_actor uuid;
  v_case public.eval_cases%rowtype;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_org := public.current_organisation_id();
  v_actor := auth.uid();
  if v_actor is null or v_org is null or not public.is_active_member(v_org) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if not public.member_has_evals_review(v_org, 'write') then
    raise exception 'not permitted to review eval cases' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approve', 'edit', 'reject') then
    raise exception 'decision must be approve, edit or reject' using errcode = '22023';
  end if;

  select * into v_case
    from public.eval_cases c
   where c.id = p_case_id
     and c.organisation_id = v_org
   for update;
  if not found then
    raise exception 'not permitted to review eval cases' using errcode = '42501';
  end if;
  if v_case.created_by = v_actor then
    raise exception 'author cannot review their own draft' using errcode = '42501';
  end if;

  insert into public.eval_reviews (organisation_id, case_id, reviewer_id, decision, edits)
  values (v_org, p_case_id, v_actor, p_decision, coalesce(p_edits, '{}'::jsonb));

  if p_decision = 'approve' then
    update public.eval_cases
       set status = 'approved',
           approved_by = v_actor,
           approved_at = now(),
           updated_at = now()
     where id = p_case_id
       and organisation_id = v_org;
  elsif p_decision = 'reject' then
    update public.eval_cases
       set status = 'drafted',
           approved_by = null,
           approved_at = null,
           updated_at = now()
     where id = p_case_id
       and organisation_id = v_org;
  end if;
end;
$$;
comment on function public.review_eval_case_v1(uuid, uuid, text, jsonb) is
  'Scoped review: non-author with evals.review write may approve/edit/reject (#82).';

create or replace function public.list_eval_cases_v1(
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
  approved_by uuid,
  approved_at timestamptz,
  created_by uuid
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.set_tenant_scope(p_organisation_id);
  if public.current_organisation_id() is null
     or not public.is_active_member(public.current_organisation_id())
     or not public.member_has_evals_review(public.current_organisation_id(), 'read') then
    return;
  end if;

  return query
    select c.id, c.case_key, c.expert_key, c.status, c.origin, c.case_type, c.question,
           c.data_class, c.approved_by, c.approved_at, c.created_by
      from public.eval_cases c
     where c.organisation_id = public.current_organisation_id()
       and (p_status is null or c.status = p_status)
     order by c.expert_key, c.case_key, c.id;
end;
$$;
comment on function public.list_eval_cases_v1(uuid, text) is
  'Scoped list of eval cases for reviewers (evals.review read+). Empty when unscoped or unentitled.';

create or replace function public.export_approved_eval_cases_v1(
  p_organisation_id uuid
) returns table (
  id uuid,
  case_key text,
  expert_key text,
  origin text,
  question text,
  data_class text,
  approved_by uuid,
  approved_at timestamptz,
  payload jsonb
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public.set_tenant_scope(p_organisation_id);
  if public.current_organisation_id() is null
     or not public.is_active_member(public.current_organisation_id())
     or not public.member_has_evals_review(public.current_organisation_id(), 'admin') then
    return;
  end if;

  return query
    select c.id, c.case_key, c.expert_key, c.origin, c.question, c.data_class,
           c.approved_by, c.approved_at, c.payload
      from public.eval_cases c
     where c.organisation_id = public.current_organisation_id()
       and c.status = 'approved'
       and c.approved_by is not null
       and c.origin <> 'pilot'
     order by c.expert_key, c.case_key, c.id;
end;
$$;
comment on function public.export_approved_eval_cases_v1(uuid) is
  'Export approved non-pilot cases for evals/<expert>/ fixtures (#82 / #102). Requires evals.review admin.';

revoke execute on function
  public.create_eval_case_draft_v1(uuid, jsonb),
  public.review_eval_case_v1(uuid, uuid, text, jsonb),
  public.list_eval_cases_v1(uuid, text),
  public.export_approved_eval_cases_v1(uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  public.create_eval_case_draft_v1(uuid, jsonb),
  public.review_eval_case_v1(uuid, uuid, text, jsonb),
  public.list_eval_cases_v1(uuid, text),
  public.export_approved_eval_cases_v1(uuid)
  to authenticated;
