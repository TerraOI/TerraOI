-- T-102h / #75: the Worker reaches toi_identity over Hyperdrive as toi_session_worker.
--
-- Supervisor answer (#75, 2026-11-08): Hyperdrive binding SESSION_DB; login user IN ROLE
-- toi_session_worker; USAGE on schema toi_identity; EXECUTE on the five *_session_v1 functions;
-- no table grants; no privilege on public or tenant tables. Threat model: a leaked SESSION_DB
-- credential can authenticate/revoke/rotate sessions but cannot read tenant data; token plaintext
-- stays sealed under the separate SESSION_TOKEN_KEY Worker secret.
--
-- Also extends authenticate_session_v1 to return session_created_at so the Hyperdrive adapter can
-- rebuild StoredSession.issuedAt without a table SELECT.

-- ---------------------------------------------------------------- role
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'toi_session_worker') then
    create role toi_session_worker nologin;
  end if;
end
$$;

comment on role toi_session_worker is
  'NOLOGIN role for the web Worker session path over SESSION_DB Hyperdrive (#75). Login user and password are §20.8 human steps.';

grant usage on schema toi_identity to toi_session_worker;

-- No table grants: the functions are security definer with a pinned search_path.
revoke all on table toi_identity.sessions from public, anon, authenticated, service_role, toi_session_worker;

-- ---------------------------------------------------------------- authenticate return shape
-- DROP + recreate: adding an OUT column changes the function type.
drop function if exists toi_identity.authenticate_session_v1(text, text, timestamptz);

create function toi_identity.authenticate_session_v1(
  p_session_key text,
  p_host text,
  p_now timestamptz
) returns table (
  user_id uuid,
  session_created_at timestamptz,
  session_expires_at timestamptz,
  key_version text,
  access_token_ciphertext text,
  refresh_token_ciphertext text,
  token_expires_at timestamptz
)
language sql stable security definer set search_path = toi_identity, pg_temp as $$
  select s.user_id, s.created_at, s.expires_at, s.key_version,
         s.access_token_ciphertext, s.refresh_token_ciphertext, s.token_expires_at
    from toi_identity.sessions s
   where s.session_key = p_session_key
     and s.host = p_host
     and s.revoked_at is null
     and s.created_at <= p_now
     and s.expires_at > p_now;
$$;

-- ---------------------------------------------------------------- grants (by full signature)
revoke execute on function
  toi_identity.authenticate_session_v1(text, text, timestamptz),
  toi_identity.revoke_session_v1(text, timestamptz),
  toi_identity.insert_session_v1(text, uuid, text, timestamptz, timestamptz, text, text, text, timestamptz),
  toi_identity.rotate_session_tokens_v1(text, text, text, text, timestamptz, timestamptz),
  toi_identity.prune_expired_sessions_v1(timestamptz, interval)
  from public, anon, authenticated, service_role;

grant execute on function
  toi_identity.authenticate_session_v1(text, text, timestamptz),
  toi_identity.revoke_session_v1(text, timestamptz),
  toi_identity.insert_session_v1(text, uuid, text, timestamptz, timestamptz, text, text, text, timestamptz),
  toi_identity.rotate_session_tokens_v1(text, text, text, text, timestamptz, timestamptz),
  toi_identity.prune_expired_sessions_v1(timestamptz, interval)
  to toi_session_worker;

-- The role must not be able to touch public tenant tables through this credential.
revoke all on schema public from toi_session_worker;
