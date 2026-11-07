-- T-102 (#37 option b, ADR-0003): the server-side session store.
--
-- What the supervisor decided (issue #37, comment 6693315053, 2026-11-06T19:17:09Z):
--   "`__Host-toi_session`, holding an **opaque random ID** (32 bytes, base64url). It carries no
--    claims… A **server-side session row**, keyed by a hash of that ID, holds `user_id` and the host
--    it was issued on; `created_at`, `expires_at` (8 h) and `revoked_at`; the user's Supabase access
--    and refresh tokens, **encrypted at rest** with a Worker secret… The row lives in a schema the
--    Data API does not expose, reachable only by the session code path."
--
-- pgTAP slot: this migration is tested by `supabase/tests/database/014_identity_session.test.sql`.
-- Slot 014, not 050: 040 is taken by the merged `040_knowledge_uploads.test.sql` (T-211 has been asked
-- to move to 045), and the packet board already claims 012 (T-201), 013 (T-202), 035 (T-104), 050
-- (T-213), 060 (T-214), 070 (T-216) and the week-3 slots. 014 sits with the identity block
-- (010 tenancy, 011 identity, 012 methods, 013 admin) and nothing else claims it.
--
-- What is deliberately NOT decided here (issue #75, opened by the lead 2026-11-06): **how the Worker
-- reaches this schema.** `supabase/config.toml` exposes only `public` and `graphql_public`
-- (`[api] schemas`, pinned by `src/platform/site/supabase-config.test.ts`), so no Data API call —
-- with any key — can see `toi_identity`. ADR-0002 established the pattern (a least-privilege login
-- over a Hyperdrive binding, with its own threat model), and W45 records that even `inquiry_writer`
-- and its Hyperdrive are not provisioned yet. So:
--   * no role is created by this migration, and nothing is granted to a role;
--   * every function below is owner-only until #75 names the caller, because a grant to a role that
--     does not exist yet is a decision dressed as plumbing;
--   * the Worker half therefore stays `unresolvedSessionStore()` in
--     `src/platform/identity/adapters.ts`, which refuses to issue or read a session, and sign-in
--     answers "unavailable" rather than falling back to a self-contained cookie.
-- The role creation, the connection config, its binding and the `SESSION_TOKEN_KEY` secret are
-- §20.8 human steps whoever wins that decision.
--
-- The rules below are in SQL on purpose, so they hold even if a future caller gets them wrong:
--   * a revoked session does not authenticate (`revoked_at`, checked before anything else);
--   * a session issued on company1 does not authenticate on company2 (`host` is compared, and it is
--     the stored host, never a claim the cookie carries);
--   * the token columns hold an encryption envelope, never the token: a plaintext Supabase JWT cannot
--     be written into this table at all.

-- ---------------------------------------------------------------- the schema
-- Not in `[api] schemas`, so PostgREST never sees it. Follows `intake` (ADR-0002, decision 2).
create schema if not exists toi_identity;
comment on schema toi_identity is
  'Server-side sign-in sessions (#37 option b). Never exposed to the Data API; reached only by the session code path (#75 decides how).';

-- ---------------------------------------------------------------- the table
create table toi_identity.sessions (
  -- base64url(SHA-256("terraoi:session-key:v1:" || <cookie value>)), computed in the Worker.
  -- The cookie holds the id; this is a one-way digest of it, so a leaked table is not a leak of
  -- replayable credentials, and no query in the app ever uses the cookie value directly.
  session_key text primary key check (session_key ~ '^[A-Za-z0-9_-]{43}$'),

  -- The identity the provider verified for this browser. Cascading on delete means a deleted user
  -- takes their sessions with them rather than leaving an orphaned credential pair behind.
  user_id uuid not null references auth.users (id) on delete cascade,

  -- The host the session was issued on, normalized exactly as `tenant_domains.host` and
  -- `NormalizedHost` do (20261105060000_tenancy_core.sql). This is what makes cross-host replay
  -- fail in SQL and not only in the Worker.
  host text not null check (
    host = lower(btrim(host))
    and host ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9]))+$'
    and (length(host) - length(replace(host, '.', ''))) <= 2
  ),

  created_at timestamptz not null default now(),
  -- 8 hours by policy (the Worker mints it); the column, not the code, is the authority: a row is
  -- never authenticable past this instant.
  expires_at timestamptz not null,
  -- Sign-out and revocation set this (#37: "a stolen cookie stops working immediately instead of at
  -- expiry"). It is a timestamp, not a boolean, so a support review can see when it happened.
  revoked_at timestamptz,

  -- Which keyring version sealed the pair. Rotation must keep reading old rows, and dropping a
  -- version from the keyring makes them undecryptable rather than silently readable (ADR-0003).
  key_version text not null check (key_version ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  -- `<key_version>.<12-byte IV>.<AES-256-GCM ciphertext>` — sealed in the Worker under the
  -- `SESSION_TOKEN_KEY` secret. No plaintext token can satisfy this shape, so "encrypted at rest" is
  -- a column constraint and not only a code review note.
  access_token_ciphertext text not null check (
    access_token_ciphertext ~ '^[a-z0-9][a-z0-9._-]{0,31}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$'
  ),
  refresh_token_ciphertext text not null check (
    refresh_token_ciphertext ~ '^[a-z0-9][a-z0-9._-]{0,31}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$'
  ),
  -- The access token's own expiry (Supabase `expires_in`), which drives the refresh rule in
  -- ADR-0003; distinct from `expires_at`, which is the session's lifetime.
  token_expires_at timestamptz not null,

  check (expires_at > created_at),
  check (token_expires_at > created_at),
  check (revoked_at is null or revoked_at >= created_at)
);

comment on table toi_identity.sessions is
  'Opaque-id session rows (#37). Keyed by a hash of the cookie value; holds the user, the issuing host, the lifetime, revocation, and the token pair encrypted at rest.';
comment on column toi_identity.sessions.access_token_ciphertext is
  'Sealed under the SESSION_TOKEN_KEY Worker secret. Never decryptable by SQL, never sent to the browser.';
comment on column toi_identity.sessions.refresh_token_ciphertext is
  'Sealed under the SESSION_TOKEN_KEY Worker secret. Rotated on use: the old value is overwritten, never kept.';

-- Retention: rows die logically at 8 h and must be deleted; prune scans this.
create index sessions_expires_at_idx on toi_identity.sessions (expires_at);

-- ---------------------------------------------------------------- RLS
-- Enabled with no policies, exactly like `intake.pilot_inquiries`: the table is readable by nobody
-- through RLS, and the functions below are the only statements that touch it.
alter table toi_identity.sessions enable row level security;

-- ---------------------------------------------------------------- the session code path's statements
-- SECURITY DEFINER with a pinned search_path, matching the intake precedent
-- (20261105080000_pilot_inquiries.sql, guardrail 000, ADR-0002 decision 3). `p_now` is passed in
-- rather than read from the clock so the Worker's decision and the database's cannot drift, and so
-- the pgTAP cases are deterministic.

-- The one that answers "does this cookie authenticate?". A revoked, expired or foreign-host row
-- returns **no row**: the caller cannot tell which, so the surface cannot be probed.
create or replace function toi_identity.authenticate_session_v1(
  p_session_key text,
  p_host text,
  p_now timestamptz
) returns table (
  user_id uuid,
  session_expires_at timestamptz,
  key_version text,
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  token_expires_at timestamptz
)
language sql stable security definer set search_path = toi_identity, pg_temp as $$
  select s.user_id, s.expires_at, s.key_version,
         s.access_token_ciphertext, s.refresh_token_ciphertext, s.token_expires_at
    from toi_identity.sessions s
   where s.session_key = p_session_key
     and s.host = p_host
     -- Revocation is checked in the same predicate as the key match, so it cannot be forgotten by a
     -- caller that "just looks the row up first".
     and s.revoked_at is null
     and s.created_at <= p_now
     and s.expires_at > p_now;
$$;

-- Sign-out (#37): idempotent, and it never touches a row that is already revoked.
create or replace function toi_identity.revoke_session_v1(p_session_key text, p_now timestamptz)
returns boolean language sql security definer set search_path = toi_identity, pg_temp as $$
  update toi_identity.sessions
     set revoked_at = p_now
   where session_key = p_session_key
     and revoked_at is null
   returning true;
$$;

-- The sign-in write. Kept as a function so the eventual caller needs `execute` only — never
-- `insert` — the way `intake.submit_pilot_inquiry_v1` works.
create or replace function toi_identity.insert_session_v1(
  p_session_key text,
  p_user_id uuid,
  p_host text,
  p_created_at timestamptz,
  p_expires_at timestamptz,
  p_key_version text,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_token_expires_at timestamptz
) returns void language sql security definer set search_path = toi_identity, pg_temp as $$
  insert into toi_identity.sessions (
    session_key, user_id, host, created_at, expires_at, revoked_at,
    key_version, access_token_ciphertext, refresh_token_ciphertext, token_expires_at
  ) values (
    p_session_key, p_user_id, p_host, p_created_at, p_expires_at, null,
    p_key_version, p_access_token_ciphertext, p_refresh_token_ciphertext, p_token_expires_at
  );
$$;

-- Token rotation. It writes only into a row that is still live, and reports whether it did, so a
-- rotation that loses a race with a sign-out is reported as a failure rather than resurrecting a
-- revoked session.
create or replace function toi_identity.rotate_session_tokens_v1(
  p_session_key text,
  p_key_version text,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text,
  p_token_expires_at timestamptz,
  p_now timestamptz
) returns boolean language sql security definer set search_path = toi_identity, pg_temp as $$
  update toi_identity.sessions
     set key_version = p_key_version,
         access_token_ciphertext = p_access_token_ciphertext,
         refresh_token_ciphertext = p_refresh_token_ciphertext,
         token_expires_at = p_token_expires_at
   where session_key = p_session_key
     and revoked_at is null
     and expires_at > p_now
   returning true;
$$;

-- Retention (ADR-0003): expired or revoked-and-aged rows are deleted, never left to accumulate.
-- Owner-only for now; wiring it to pg_cron is a §20.8 human step, the same shape as
-- `intake.prune_pilot_inquiries()`.
create or replace function toi_identity.prune_expired_sessions_v1(p_now timestamptz, p_grace_interval interval default interval '7 days')
returns integer language sql security definer set search_path = toi_identity, pg_temp as $$
  with deleted as (
    delete from toi_identity.sessions
     where expires_at < p_now - p_grace_interval
        or (revoked_at is not null and revoked_at < p_now - p_grace_interval)
    returning 1
  )
  select count(*)::integer from deleted;
$$;

-- ---------------------------------------------------------------- grants
-- Nothing to the API-facing roles. `usage` on the schema is what makes the difference between
-- "permission denied" and "table does not exist", so it is revoked explicitly rather than left to
-- Postgres's default of granting nothing: an accidental `grant usage on schema toi_identity to …`
-- in a later migration would otherwise become readable the moment a table grant followed.
revoke all on schema toi_identity from public, anon, authenticated, service_role;
revoke all on all tables in schema toi_identity from public, anon, authenticated, service_role;
revoke all on all functions in schema toi_identity from public, anon, authenticated, service_role;

-- Functions in a schema are executable by PUBLIC unless something says so, and a per-schema default
-- privilege cannot undo that for functions created later — the same trap recorded for `intake`
-- (20261105210000_intake_service_role.sql) and issue #60. Each new function here is revoked by name.
revoke execute on function
  toi_identity.authenticate_session_v1(text, text, timestamptz),
  toi_identity.revoke_session_v1(text, timestamptz),
  toi_identity.insert_session_v1(text, uuid, text, timestamptz, timestamptz, text, text, text, timestamptz),
  toi_identity.rotate_session_tokens_v1(text, text, text, text, timestamptz, timestamptz),
  toi_identity.prune_expired_sessions_v1(timestamptz, interval)
  from public, anon, authenticated, service_role;
