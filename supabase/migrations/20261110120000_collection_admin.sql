-- T-111b — the collection admin write path: `create_collection_v1`, `update_collection_v1`.
-- Decided in #41 (a dedicated packet, because no packet owned the RPC that T-202 and T-213 both
-- need). Plan §4.3 (writes go through scoped RPCs), §6.1-§6.2 (one place for the class and audience
-- rules), FAQ-0004 (the owning lane writes its own table; the other lane only calls it).
--
-- Tenant scope, per #163 / FAQ-0011 (the standing rule issued after the first version of this file
-- went green): both RPCs take `p_organisation_id uuid` as their **first** parameter and their **first
-- statement** is `perform public.set_tenant_scope(p_organisation_id);`, in the same transaction as the
-- write (plan §4.3:245-247). That makes them `volatile`, which `025` pins from `pg_proc.provolatile`
-- rather than assuming from this text (#163 rule 4). The argument confers nothing: `set_tenant_scope`
-- refuses unless `auth.uid()` is an active member of that organisation (tenancy_core.sql:203-220), so
-- a caller can only ever pick one of the tenants they already belong to, and the merged membership
-- check is what decides. `security definer` does not change that — `auth.uid()` reads the request's
-- claims, not the executing role (#163 rule 5). This updates #156's answer the way #163 says it does:
-- the tenant still comes from the scope; the scope now comes from that argument plus the membership
-- check. Because this migration is not merged, the parameter is added **here** rather than by a new
-- migration, and no `drop function` of the earlier signature is needed: no environment has ever
-- applied this file, so the shape `create_collection_v1(text, text, text, uuid, text)` never existed
-- anywhere a revoke would have to reach.
--
-- What this migration does NOT do, deliberately:
--   * It never changes a collection's `data_class`, `project_id` or `organisation_id`. Raising a
--     class is `review_reclass_v1` in T-213, the one place that cascades (#21, closed as ruled), and
--     the merged guard trigger already refuses an audience or tenant change on this table
--     (`knowledge_core.sql:504-526`). `update_collection_v1` has **no parameter** for any of them,
--     which is what `025_collection_admin.test.sql` test 2 pins: a later "convenience" parameter
--     turns the suite red instead of passing review. The `p_organisation_id` argument selects the
--     tenant the statement runs in; it is never written to the row.
--   * It adds no column. #41 names a `p_description` for the rename, but `knowledge_collections` has
--     no description column (`knowledge_core.sql:77-110`) and no packet specifies one — so the RPC
--     takes a name only, rather than accepting a value and dropping it. Raised as #154, answered: the
--     RPC keeps the name-only signature and `025` test 3 pins that no column appeared.
--   * It grants no table write to any request role. `authenticated` keeps SELECT only on the
--     knowledge tables (`knowledge_core.sql:884-901`, "SELECT only, on purpose (B1)"), and tests 6-7
--     of `025` assert that stays true after this file runs.
--
-- SECURITY DEFINER, not SECURITY INVOKER, and the reason is on the record as #156: #41's wording says
-- invoker, but an invoker body runs as `authenticated`, which cannot write this table; the only way
-- to honour the clause literally is to grant INSERT/UPDATE on a knowledge table to every signed-in
-- member, which is the widening FAQ-0004 and the `:896-901` comment forbid. Every merged write-path
-- scoped RPC in this repository is definer for the same reason — `begin_upload_session_v1`,
-- `register_source_version_v1`, `record_upload_outcome_v1` (`20261106100000_knowledge_uploads.sql:126,
-- 214, 333, 525`) — as is #21's ruling for `review_reclass_v1`. Because a definer body bypasses RLS
-- (these tables are `enable row level security`, not `force`d — `tenancy_core.sql:251-256`), the
-- `organisation_id = v_organisation` predicate in the statements below is load-bearing, not cosmetic.
--
-- Identity, in both functions: the tenant arrives as `p_organisation_id` and is **verified**, not
-- trusted — `set_tenant_scope` sets the scope only for a tenant `auth.uid()` actively belongs to; the
-- actor is `auth.uid()` and has no parameter at all. There is no user, actor or role argument to forge
-- (§4.1, F09, FAQ-0011).
--
-- #60 / FAQ-0010: both functions are revoked from `public, anon, authenticated` by full signature in
-- this same migration, then granted to `authenticated` only, and both signatures are added to
-- `001_function_privileges.test.sql`'s rule-32 allow-list in the same PR. The revoke is not optional
-- decoration: PostgreSQL hands EXECUTE on a new function to PUBLIC, and a migration cannot close that
-- default (FAQ-0010, #142).
--
-- Safe error codes, one per refusal class, with no existence signal (#13(2)): a collection that does
-- not exist, a collection in another tenant and a caller who lacks the permission all answer `42501`,
-- so probing the RPC cannot enumerate another tenant's corpora. `28000` means "no session identity or
-- no active membership in the tenant that was named" — it comes from `set_tenant_scope`, which runs
-- before anything else here — and `22023` means a malformed argument, including a null tenant id,
-- before anything is written.
--
-- Acceptance tests: `supabase/tests/database/025_collection_admin.test.sql` (slot 025, claimed in
-- docs/COORDINATION.md §6b), written first and pushed as the red run at `66301c6`. Every branch that
-- depends on `auth.uid()` — member vs admin, suspended membership, the membership check behind the
-- `28000` — is asserted only in CI's `database` job, which runs the real Supabase `auth` schema; the
-- local parse-only harness does not model it and nothing here is faked to make it look covered.

-- ---------------------------------------------------------------- create
create or replace function public.create_collection_v1(
  p_organisation_id uuid,
  p_key text,
  p_name text,
  p_service text,
  p_project_id uuid,
  p_data_class text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_user uuid;
  v_id uuid;
begin
  -- FAQ-0011 / #163 rule 2, as the first statement: the RPC establishes its own tenant scope, in the
  -- same transaction as the write. Nothing before this line runs, so there is no window in which the
  -- body could address an unscoped or a different tenant. Membership is verified inside this call
  -- (tenancy_core.sql:203-220): a null `auth.uid()` answers 28000, a null tenant 22023, and a tenant
  -- the caller does not actively belong to answers 28000 — so this argument selects among the
  -- caller's own tenants and never grants anything.
  perform public.set_tenant_scope(p_organisation_id);

  -- Read the scope back instead of reusing the argument: every statement below addresses the tenant
  -- the scope now holds, and because a definer body bypasses RLS that value — not a policy — is what
  -- keeps the write inside one tenant.
  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
  if v_user is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required to create a collection' using errcode = '28000';
  end if;
  -- Restates the invariant set_tenant_scope already checked, in the body that depends on it (§4.2):
  -- same predicate, same 28000, so a change to that helper cannot quietly widen this write path.
  if not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;

  -- #41: the admin gate is a permission on an area at a level, not a hard-coded role key. The seed
  -- grants `knowledge.admin` at `admin` to a tenant admin; nothing grants it to a member, and a
  -- contributor's `knowledge.write` (#39, FAQ-0006) is the capture predicate, not this one — that
  -- lives in user_may_publish_into(uuid), which this packet deliberately does not touch.
  if not exists (
    select 1
      from public.organisation_memberships m
      join public.membership_roles mr on mr.membership_id = m.id
      join public.role_permissions rp
        on rp.role_id = mr.role_id
       and rp.organisation_id = m.organisation_id
       and rp.area = 'knowledge.admin'
       and rp.level = 'admin'
      where m.organisation_id = v_organisation
        and m.user_id = v_user
        and m.status = 'active'
  ) then
    raise exception 'not permitted to administer collections' using errcode = '42501';
  end if;

  -- Shape first, so a malformed request never reaches the table and never leaks a constraint name.
  if p_key is null or p_key !~ '^[a-z0-9][a-z0-9-]{0,62}$' then
    raise exception 'collection key must be 1-63 lowercase letters, digits and hyphens' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) < 1 or char_length(p_name) > 200 then
    raise exception 'collection name must be between 1 and 200 characters' using errcode = '22023';
  end if;
  if p_service is null or p_service !~ '^[a-z0-9][a-z0-9-]{0,63}$' then
    raise exception 'service key must be 1-64 lowercase letters, digits and hyphens' using errcode = '22023';
  end if;

  -- A project of another tenant is refused here, with the same code as every other permission
  -- failure, rather than as a raw composite-FK violation naming the other tenant's row. The FK at
  -- knowledge_collections_project_fk stays as the backstop it has always been.
  if p_project_id is not null and not exists (
    select 1
      from public.projects pr
     where pr.id = p_project_id
       and pr.organisation_id = v_organisation
  ) then
    raise exception 'no such project in this organization' using errcode = '42501';
  end if;

  -- #153 ruled (A): no project-membership check here. Deciding which project a corpus belongs to is
  -- the administrative act `knowledge.admin` is for, and creating discloses nothing because the read
  -- path keeps requiring project membership (`collection_is_readable`, knowledge_core.sql:434-444).
  -- `025` pins both halves: an admin who is not a member of the project creates the collection (49)
  -- and then reads zero rows of it through the ordinary policies (50).
  --
  -- The class rules are not re-implemented here: the merged CHECKs are the enforcement, and letting
  -- them speak keeps one definition of "ingestible in M1" and of "client_confidential needs a project"
  -- (knowledge_core.sql:100-106). A tenant-wide client_confidential collection and a restricted one
  -- both come back 23514, which is what the packet's acceptance list says they should.
  insert into public.knowledge_collections (
    organisation_id, key, service_key, project_id, name, data_class
  ) values (
    v_organisation, p_key, p_service, p_project_id, p_name, p_data_class
  )
  returning id into v_id;

  -- #153 point 3: the id, and nothing else — the caller is not handed the row it just wrote.
  return v_id;
end;
$$;

comment on function public.create_collection_v1(uuid, text, text, text, uuid, text) is
  'Scoped RPC: p_organisation_id first, scope established by set_tenant_scope as the first statement (FAQ-0011, #163), knowledge.admin at admin required, project must belong to the scoped tenant, class rules enforced by the merged CHECKs. No user, actor or role parameter exists to forge, and the tenant argument is verified by the membership check rather than trusted (#41, §4.1, §4.3, §6.2).';

-- ---------------------------------------------------------------- rename
create or replace function public.update_collection_v1(
  p_organisation_id uuid,
  p_collection_id uuid,
  p_name text
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_user uuid;
begin
  -- Same rule, same position: scope first, from the argument, membership verified inside it (#163).
  perform public.set_tenant_scope(p_organisation_id);

  v_organisation := public.current_organisation_id();
  v_user := auth.uid();
  if v_user is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required to rename a collection' using errcode = '28000';
  end if;
  if not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  if not exists (
    select 1
      from public.organisation_memberships m
      join public.membership_roles mr on mr.membership_id = m.id
      join public.role_permissions rp
        on rp.role_id = mr.role_id
       and rp.organisation_id = m.organisation_id
       and rp.area = 'knowledge.admin'
       and rp.level = 'admin'
      where m.organisation_id = v_organisation
        and m.user_id = v_user
        and m.status = 'active'
  ) then
    raise exception 'not permitted to administer collections' using errcode = '42501';
  end if;
  if p_name is null or char_length(btrim(p_name)) < 1 or char_length(p_name) > 200 then
    raise exception 'collection name must be between 1 and 200 characters' using errcode = '22023';
  end if;

  -- `name` only, and id **and** tenant in one predicate: a collection belonging to another tenant is
  -- not found, with the same code as a collection that does not exist, so the attempt learns nothing
  -- about whether the id exists anywhere else (#13(2), #156). The predicate is load-bearing precisely
  -- because this body is a definer and RLS will not narrow the row set for it. The guard trigger
  -- (knowledge_core.sql:504-526) still stands behind this: even a hand-written UPDATE cannot move a
  -- collection's tenant or audience, or lower its class.
  update public.knowledge_collections
     set name = p_name
   where id = p_collection_id
     and organisation_id = v_organisation;

  if not found then
    raise exception 'collection not found in this organization' using errcode = '42501';
  end if;
end;
$$;

comment on function public.update_collection_v1(uuid, uuid, text) is
  'Scoped rename: name only. It cannot touch data_class, project_id or organisation_id (no parameter for any of them), because raising a class is review_reclass_v1 in T-213 and an audience change is a new collection (#21, #41, §6.2). Scope established by set_tenant_scope as the first statement (FAQ-0011, #163); row found by id and tenant in one predicate (#156).';

-- ---------------------------------------------------------------- privileges (#60, FAQ-0010)
-- Revoke the PUBLIC default by full signature in the migration that creates the function, then grant
-- it back to the one request role that needs it. `anon` gets nothing: knowledge is behind sign-in.
-- The signatures below are the #163 shapes; `001`'s rule-32 allow-list carries the same two.
revoke execute on function
  public.create_collection_v1(uuid, text, text, text, uuid, text),
  public.update_collection_v1(uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function
  public.create_collection_v1(uuid, text, text, text, uuid, text),
  public.update_collection_v1(uuid, uuid, text)
  to authenticated;
