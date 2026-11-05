-- T-130: pilot inquiries from the public terraoi.app form (ADR-0002).
-- No anonymous database path: the intake schema is not exposed through the Supabase API, and only
-- the NOLOGIN role inquiry_writer (used by the web Worker over Hyperdrive) may call the insert-only
-- function. Its login user and password are created by hand and never live in the repo.

create schema if not exists intake;
revoke all on schema intake from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'inquiry_writer') then
    create role inquiry_writer nologin;
  end if;
end
$$;

grant usage on schema intake to inquiry_writer;

-- Bounds mirror src/platform/site/pilot-inquiry.ts. Zod counts UTF-16 units, which is never fewer
-- than char_length's code points, so anything the API accepts also passes these checks.
create table intake.pilot_inquiries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 120),
  email text not null check (
    char_length(email) <= 254
    and email = lower(email)
    and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ),
  company text not null check (char_length(company) between 1 and 160),
  role text check (role is null or char_length(role) between 1 and 120),
  services text[] not null check (
    cardinality(services) >= 1
    and services <@ array['uav', 'gpr', 'other']::text[]
  ),
  message text check (message is null or char_length(message) between 1 and 2000),
  ip_hash text not null check (ip_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'new' check (status in ('new', 'contacted', 'closed'))
);

comment on table intake.pilot_inquiries is
  'Pilot inquiries from terraoi.app (T-130, ADR-0002). ip_hash is HMAC-SHA256 of the client IP; the raw IP is never stored. Rows are deleted after 12 months.';

-- RLS on, no policies: nobody reads or writes through RLS. The owner-run functions below are the
-- only way in; the supervisor reads rows from the Supabase dashboard.
alter table intake.pilot_inquiries enable row level security;
revoke all on table intake.pilot_inquiries from public, anon, authenticated, inquiry_writer;

create index pilot_inquiries_created_at_idx on intake.pilot_inquiries (created_at);

-- Insert-only entry point. Validation is the table's CHECK constraints (SQLSTATE 23514), so the
-- function and any later write path cannot drift apart.
create function intake.submit_pilot_inquiry_v1(
  p_name text,
  p_email text,
  p_company text,
  p_role text,
  p_services text[],
  p_message text,
  p_ip_hash text
) returns void
language sql
security definer
set search_path = intake, pg_temp
as $$
  insert into intake.pilot_inquiries (name, email, company, role, services, message, ip_hash)
  values (p_name, p_email, p_company, p_role, p_services, p_message, p_ip_hash);
$$;

revoke execute on function intake.submit_pilot_inquiry_v1(text, text, text, text, text[], text, text)
  from public, anon, authenticated;
grant execute on function intake.submit_pilot_inquiry_v1(text, text, text, text, text[], text, text)
  to inquiry_writer;

-- Retention: 12 months. Owner only; pg_cron runs it daily.
create function intake.prune_pilot_inquiries() returns integer
language sql
security definer
set search_path = intake, pg_temp
as $$
  with gone as (
    delete from intake.pilot_inquiries
     where created_at < now() - interval '12 months'
    returning 1
  )
  select count(*)::integer from gone;
$$;

revoke execute on function intake.prune_pilot_inquiries() from public, anon, authenticated, inquiry_writer;

create extension if not exists pg_cron;
select cron.schedule('prune-pilot-inquiries', '17 3 * * *', 'select intake.prune_pilot_inquiries()');
