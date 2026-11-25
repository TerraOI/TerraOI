-- Minimal Supabase-compatible bootstrap for running migrations + pgTAP without Docker.
-- Mirrors the parts of the Supabase image the TerraOI migrations rely on.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='authenticator') then create role authenticator login noinherit; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_admin') then create role supabase_admin superuser; end if;
  if not exists (select 1 from pg_roles where rolname='supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
end $$;
grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres with admin option;
grant usage, create on schema public to postgres;
alter schema public owner to postgres;

create schema if not exists extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists vector with schema extensions;
create extension if not exists pgtap with schema extensions;
create extension if not exists pg_cron;
grant usage on schema cron to postgres;
grant all on all tables in schema cron to postgres;
grant execute on all functions in schema cron to postgres;
grant all on schema extensions to postgres with grant option;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;
create table if not exists auth.users (
  instance_id uuid, id uuid primary key, aud varchar(255), role varchar(255), email varchar(255),
  encrypted_password varchar(255), email_confirmed_at timestamptz, invited_at timestamptz,
  confirmation_token varchar(255), confirmation_sent_at timestamptz, recovery_token varchar(255),
  recovery_sent_at timestamptz, email_change_token_new varchar(255), email_change varchar(255),
  email_change_sent_at timestamptz, last_sign_in_at timestamptz, raw_app_meta_data jsonb,
  raw_user_meta_data jsonb, is_super_admin boolean, created_at timestamptz, updated_at timestamptz,
  phone text, phone_confirmed_at timestamptz, phone_change text, phone_change_token varchar(255),
  phone_change_sent_at timestamptz, confirmed_at timestamptz, email_change_token_current varchar(255),
  email_change_confirm_status smallint, banned_until timestamptz, reauthentication_token varchar(255),
  reauthentication_sent_at timestamptz, is_sso_user boolean not null default false, deleted_at timestamptz,
  is_anonymous boolean not null default false
);
create table if not exists auth.identities (
  provider_id text not null, user_id uuid not null references auth.users(id) on delete cascade,
  identity_data jsonb not null, provider text not null, last_sign_in_at timestamptz,
  created_at timestamptz, updated_at timestamptz, email text, id uuid primary key default gen_random_uuid()
);
create or replace function auth.uid() returns uuid language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $f$;
create or replace function auth.role() returns text language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $f$;
create or replace function auth.email() returns text language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.email', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'))::text $f$;
create or replace function auth.jwt() returns jsonb language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $f$;
grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt() to anon, authenticated, service_role;

create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;
create table if not exists storage.buckets (
  id text primary key, name text not null unique, owner uuid, created_at timestamptz default now(),
  updated_at timestamptz default now(), public boolean default false, avif_autodetection boolean default false,
  file_size_limit bigint, allowed_mime_types text[], owner_id text
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text,
  owner uuid, created_at timestamptz default now(), updated_at timestamptz default now(),
  last_accessed_at timestamptz default now(), metadata jsonb, version text, owner_id text, user_metadata jsonb
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $f$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $f$;
create or replace function storage.filename(name text) returns text language sql immutable as $f$
  select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)] $f$;

-- Supabase default privileges in public (what makes RLS, not grants, the gate).
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;

grant all on auth.users, auth.identities to postgres;
grant all on schema auth to postgres;
grant all on schema storage to postgres; grant all on all tables in schema storage to postgres;

do $$ begin if not exists (select 1 from pg_roles where rolname='supabase_storage_admin') then create role supabase_storage_admin nologin; end if; end $$;
alter table storage.objects owner to supabase_storage_admin;
alter table storage.buckets owner to supabase_storage_admin;
grant supabase_storage_admin to postgres;

-- graphql_public stub so generated types carry the same schema block as the Supabase image
create schema if not exists graphql_public;
grant usage on schema graphql_public to postgres, anon, authenticated, service_role;
create or replace function graphql_public.graphql("operationName" text default null, query text default null, variables jsonb default null, extensions jsonb default null)
returns jsonb language sql as $f$ select null::jsonb $f$;
grant execute on function graphql_public.graphql(text, text, jsonb, jsonb) to postgres, anon, authenticated, service_role;
