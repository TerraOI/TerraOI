-- #60 — close the function EXECUTE hole in `public`, and close the default at the source.
-- Supervisor ruling 2026-11-09 (option A, two additions), executed on the lead's instruction.
-- Revoke-and-grant only: no table, no policy, no function signature changes, so
-- `src/contracts/database.types.ts` is not regenerated (#122) — CI checks that rather than
-- trusting it, and the PR body reports what the `database` job actually showed.
--
-- Why the hole existed. PostgreSQL grants EXECUTE to PUBLIC on every new function.
-- 20261105070000_knowledge_core.sql revoked privileges per *table* (:884-888) and granted EXECUTE
-- back to `authenticated` on 7 functions (:903-911), but never revoked the 15 it created. The
-- blanket `revoke execute on all functions in schema public` at
-- 20261105060000_tenancy_core.sql:341 reached only the functions that already existed then, which
-- is precisely why 20261105210000_intake_service_role.sql:10-11 made per-function revoke-and-grant
-- the standing rule: every migration that adds a function revokes and grants it by name.
-- 000_guardrails.test.sql checks table RLS and definer `search_path`, never function privileges,
-- so no existing assertion noticed. supabase/tests/database/001_function_privileges.test.sql (slot
-- 001, docs/COORDINATION.md §6b) pins all of the below, including the two generic allow-list rules
-- that make the next function a review decision instead of an accident.

-- 1. The 15 functions knowledge_core.sql created, by full signature, from PUBLIC and both request
--    roles. Eight of them are trigger functions; PostgreSQL fires a table's triggers without the
--    invoking role holding EXECUTE on the function, so revoking them costs nothing and removes
--    eight REST-reachable endpoints. They are not granted back.
revoke execute on function
  public.data_class_is_valid(text),
  public.data_class_rank(text),
  public.data_class_is_ingestible_in_m1(text),
  public.collection_is_readable(uuid),
  public.source_is_readable(uuid),
  public.source_version_is_readable(uuid),
  public.chunk_is_readable(uuid),
  public.knowledge_collections_guard(),
  public.source_versions_collection_guard(),
  public.source_versions_immutable(),
  public.source_versions_no_resurrection(),
  public.knowledge_sources_guard(),
  public.knowledge_chunks_guard(),
  public.chunk_embeddings_guard(),
  public.source_versions_outbox()
  from public, anon, authenticated;

-- 2. The same defect one migration later, flagged rather than left open.
-- 20261106100000_knowledge_uploads.sql revoked four of its new functions by name (:601-606) and
-- missed this one, so public.knowledge_upload_sessions_guard() — created at :129, attached as a
-- trigger at :153-154 — has been executable by PUBLIC, anon and authenticated since #32 merged.
-- It is a trigger function, it is not on the allow-list the ruling names, and the ruling's generic
-- rule for `authenticated` cannot pass while it stays open. (#96 owns this guard's *behaviour*
-- work — expires_at and closed states, slot 041 — not its privileges; #96 item 5 records that the
-- function-EXECUTE gap is #60's. A later revoke of the same function is a no-op, so this line is
-- safe whichever order they merge in.)
revoke execute on function public.knowledge_upload_sessions_guard()
  from public, anon, authenticated;

-- 3. Grant back exactly the 7 that knowledge_core.sql:903-911 granted, to `authenticated` only.
--    They are evaluated as the querying role by RLS policies and CHECK constraints
--    (knowledge_core.sql:101, :103, :209, :211, :267, :269, :386, :388, :827, :831), so revoking
--    them would break the read path rather than harden it. Nothing is granted to `anon`: knowledge
--    is behind sign-in (knowledge_core.sql:880-883).
grant execute on function
  public.data_class_is_valid(text),
  public.data_class_rank(text),
  public.data_class_is_ingestible_in_m1(text),
  public.collection_is_readable(uuid),
  public.source_is_readable(uuid),
  public.source_version_is_readable(uuid),
  public.chunk_is_readable(uuid)
  to authenticated;

-- 4. Ruling addition 1: close the default at the source, for the role that runs these migrations,
--    so the next function anyone adds starts closed and the per-function rule above is enforced by
--    the database rather than by memory. `postgres` is the role that owns the migrated functions;
--    001_function_privileges.test.sql asserts that fact by name (test 34), the pg_default_acl row
--    (test 35-36) and the behaviour for a function created afterwards (test 37-38). If a hosted
--    environment runs migrations as a different role, test 34 says which one and this statement is
--    retargeted or dropped, exactly as the ruling instructs.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;
