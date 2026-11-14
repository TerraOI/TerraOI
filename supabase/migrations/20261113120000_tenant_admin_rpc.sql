-- T-202 PR-1 (database half) — the tenant-admin scoped RPCs and the #98 `policy_revision` writer.
-- Packet: docs/tasks/T-202-tenant-admin.md with its 2026-11-09 supervisor rulings, which supersede the
-- packet body. The controller's PR split keeps this migration database-only: the admin pages,
-- `src/components/admin/`, the collection UI and the brand-fallback banner are T-202 PR-2, and the
-- collection writes are T-111b's RPCs in `20261110120000_collection_admin.sql`, not anything here
-- (FAQ-0004: this packet writes no knowledge table).
--
-- Acceptance tests: `supabase/tests/database/013_tenant_admin.test.sql` (slot 013, claimed in
-- docs/COORDINATION.md §6b). The pgTAP is the venue that proves every branch below; `pnpm db:test`
-- needs Docker, which no builder machine has (FAQ-0009), so CI's `database` job runs it.
--
-- What this file adds:
--   0. one line undoing a broken merged trigger (ruling 5) — see that section;
--   1. seven tenant-admin write RPCs, all in the FAQ-0011 shape;
--   2. `public.bump_policy_revision()` and fifteen triggers (#98);
--   3. the replacement for the stale `organisations` table/column comments at
--      `20261105060000_tenancy_core.sql:33-34`, which the merged file may not be edited to change;
--   4. a **withheld** #39 seed, kept visible as a commented section with its cost named.
--
-- FAQ-0011 / #163 shape, unchanged from `20261110120000_collection_admin.sql`: every RPC takes
-- `p_organisation_id uuid` **first** and its **first statement** is
-- `perform public.set_tenant_scope(p_organisation_id);`, in the same transaction as the write
-- (plan §4.3:245-247). That makes each one `volatile`, which 013 pins from `pg_proc.provolatile`
-- rather than from this text. The argument confers nothing: `set_tenant_scope` refuses unless
-- `auth.uid()` is an active member of that organisation (`tenancy_core.sql:203-220`), so it only ever
-- selects among tenants the caller already belongs to. `auth.uid()` reads the request's claims, not the
-- executing role, so `security definer` does not move the identity either (#163 rule 5). The caller is
-- `withTenantRpc` (T-101c), which injects the argument from `TenantContext` and dials as the signed-in
-- user; no page or component passes an organisation id (#163, packet ruling).
--
-- SECURITY DEFINER, and the reason is the same one #156 settled for the collection writes:
-- `tenancy_core.sql:335` grants `authenticated` **select** on the tenancy tables and nothing else, so an
-- invoker body could not write them, and the only way to honour the packet body's "security invoker"
-- literally is to hand every signed-in member a direct write on `organisation_memberships`,
-- `membership_roles`, `projects` and `project_memberships` — exactly the widening FAQ-0004 and the
-- `:333-334` comment forbid. Every merged write-path scoped RPC in this repository is definer for that
-- reason. Because a definer body bypasses RLS (these tables are `enable`d, never `force`d —
-- `tenancy_core.sql:251-256`), the `organisation_id = v_organisation` predicate in every statement
-- below is **load-bearing**, not cosmetic. 013 pins the clause on every definer statement, and pins in
-- its privilege family that no direct write door came with it.
--
-- Cross-tenant ids are refused by the composite foreign keys, not by a filter (the packet's negative
-- box, "never silently ignored"): every write carries `organisation_id = v_organisation` **from the
-- scope** alongside the foreign id **as the caller passed it**, so a company2 `project_id` or `role_id`
-- has no matching parent and raises `23503` (`tenancy_core.sql:103,115-118,146-148`). The RPCs do not
-- pre-check those ids — that would turn an impossible reference into a filter and hide the case. Where
-- no FK can speak (a DELETE, or a target row addressed by id), the tenant-bounded existence check
-- carries the same rule and answers inside the `42501` family.
--
-- Error codes, one family per refusal class and no existence oracle (#13(2)):
--   22023 a malformed argument (a null tenant from the scope helper, a null target id, a bad key, name,
--         visibility or address shape) — always before any write;
--   28000 no session identity, or not an active member of the tenant named — always from
--         `set_tenant_scope`, which runs before anything else in the body;
--   42501 the permission gate ("no `*.admin` at `admin` here") and "no such row in this tenant" are one
--         family on purpose, so probing an RPC cannot enumerate another tenant's ids or learn whether an
--         address has an identity record (ruling 3: creating an identity is GoTrue's and T-201's, and an
--         unknown address must not get its own code);
--   23503 a reference into another tenant (or into no tenant at all), from the composite FK;
--   23505 a unique key (a duplicate project key).
--
-- Idempotency, because an admin form is re-submitted: the invite, the role grant and the project
-- membership all write `on conflict do nothing` against their existing unique keys, and activating an
-- already-active membership writes the same values. None of them resurrects a `suspended` or `removed`
-- row, and none of them moves `policy_revision` when nothing changed — the same property #98 asks the
-- writer for, enforced in two places by design.
--
-- This migration deliberately does NOT do:
--   * no email, no notification (invite **sign-in** is T-201, email is T-105);
--   * no read RPCs and no widening of any read policy: there is still no admin read path for the member
--     and role lists (`memberships_read_own`, `tenancy_core.sql:290-292` bounds
--     `organisation_memberships` to the caller's own row). Ruling 6 keeps PR-1 write-only and puts
--     `list_*_v1` on PR-2's tab; 013 pins the ceiling instead of pretending it is covered;
--   * no `admin`-level self-lockout rule: a tenant can currently demote its own last admin, and 013
--     records that fact rather than inventing a guard the packet never asked for (ruling 4);
--   * no knowledge table, no collection write, no page (FAQ-0004, the PR split);
--   * no new column and no table shape change anywhere (the `projects` fix drops a trigger, it does not
--     add an `updated_at`).
--
-- #60 / FAQ-0010: every function created here — all seven RPCs and the trigger function — is revoked
-- from `public, anon, authenticated` **and** `service_role` by full signature inside this file, matching
-- the newest house style (`20261113010000_scoped_identity_reads.sql:60-63`,
-- `20261112234000_session_worker_role.sql:58-64`), and the seven are granted back to `authenticated`
-- only. All seven signatures go onto `001_function_privileges.test.sql`'s rule-32 allow-list in this
-- same PR; the trigger function is granted to nobody, because PostgreSQL fires a table's trigger without
-- the invoking role holding EXECUTE (001 tests 23-30).

-- ---------------------------------------------------------------- 0. a broken merged trigger, undone
-- `20261105060000_tenancy_core.sql:162-163` creates
--   create trigger projects_touch_updated before update on public.projects
--     for each row execute function public.touch_updated_at();
-- and `touch_updated_at()` (`:152-158`) assigns `new.updated_at` — but `projects` (`:122-134`) has no
-- `updated_at` column. So **every** `UPDATE` on `public.projects` raises `42703` ("column updated_at of
-- relation new does not exist") on any database where these migrations have been applied. The merged
-- migration may not be edited (AGENTS.md §6), so the minimal fix is to drop the trigger here. Not
-- adding an `updated_at` column is deliberate: that would change the table's shape with no ruling
-- (controller ruling 5). A latent defect found, not a feature — flagged for the PR body. `organisations`
-- keeps its own `organisations_touch_updated`, which is fine: that table really does have `updated_at`
-- (`:31`). Pinned in 013: the trigger is gone, and an `UPDATE` on a project row now runs.
drop trigger if exists projects_touch_updated on public.projects;

-- ---------------------------------------------------------------- 1a. membership and role admin (members.admin)
create or replace function public.invite_member_v1(
  p_organisation_id uuid,
  p_email text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_actor uuid;
  v_email text;
  v_target uuid;
  v_membership uuid;
begin
  -- FAQ-0011 rule 2, first statement: the RPC establishes its own scope, in the same transaction as
  -- the write. Nothing above it runs, so there is no window in which this body could address an
  -- unscoped or a different tenant.
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required to invite a member' using errcode = '28000';
  end if;
  if not public.is_active_member(v_organisation) then
    raise exception 'not an active member of this organization' using errcode = '28000';
  end if;
  -- The gate is a permission area at a level, not a hard-coded role key (packet Contract, plan §5.2):
  -- nothing in the seed grants `members.admin` to a plain member, and 013 shows the same person
  -- passing it the moment the role is assigned.
  if not exists (
    select 1
      from public.organisation_memberships m
      join public.membership_roles mr on mr.membership_id = m.id
      join public.role_permissions rp
        on rp.role_id = mr.role_id
       and rp.organisation_id = m.organisation_id
       and rp.area = 'members.admin'
       and rp.level = 'admin'
     where m.organisation_id = v_organisation
       and m.user_id = v_actor
       and m.status = 'active'
  ) then
    raise exception 'not permitted to administer members' using errcode = '42501';
  end if;
  -- Shape first, so a probe never reaches the profile table and never learns which addresses exist.
  -- `profiles.email` stores the canonical form (`tenancy_core.sql:59`), so the lookup normalizes the
  -- same way and a case or space variant is the same invite, not a second one (#42).
  if p_email is null or btrim(p_email) = '' then
    raise exception 'an address is required to invite a member' using errcode = '22023';
  end if;
  v_email := lower(btrim(p_email));
  if v_email !~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$' then
    raise exception 'address is not a valid email address' using errcode = '22023';
  end if;

  -- An address with no identity record - or one held by more than one profile, which the schema does
  -- not forbid - answers inside the 42501 family with the same wording as any other refusal
  -- (ruling 3): creating an identity is GoTrue's and T-201's job, and a distinct code would hand over
  -- an account-existence oracle (#13(2)). `having count(*) = 1` is why an ambiguous address is
  -- refused rather than guessed at.
  select min(pr.id) into v_target
    from public.profiles pr
   where pr.email = v_email
   having count(*) = 1;
  if v_target is null then
    raise exception 'no such member in this organization' using errcode = '42501';
  end if;

  -- Idempotency, against the existing unique (organisation_id, user_id) key rather than by looking
  -- first: `do nothing` means a second invite of the same address writes no row at all, so the AFTER
  -- statement writer sees an empty transition table and moves no `policy_revision` (#98 asks the writer
  -- for exactly that; enforcing it here too is deliberate, in two places by design). A write-then-read
  -- rather than a read-then-write also closes the race between two admins inviting the same address.
  insert into public.organisation_memberships (organisation_id, user_id, status)
  values (v_organisation, v_target, 'invited')
  on conflict (organisation_id, user_id) do nothing
  returning id into v_membership;

  if v_membership is null then
    -- There is already a row for this address in this tenant. Only `invited` and `active` may be
    -- re-invited: a `suspended` or `removed` row is not resurrected by an invite (nothing in this
    -- migration resurrects it either — reinstating a departed member is not a T-202 PR-1 act, and the
    -- status column is the record that it happened). Same code, same wording as every other refusal.
    select m.id into v_membership
      from public.organisation_memberships m
     where m.organisation_id = v_organisation
       and m.user_id = v_target
       and m.status in ('invited', 'active');
    if v_membership is null then
      raise exception 'no such member in this organization' using errcode = '42501';
    end if;
  end if;

  return v_membership;
end;
$$;

comment on function public.invite_member_v1(uuid, text) is
  'Scoped RPC (FAQ-0011): p_organisation_id first, set_tenant_scope as the first statement. Idempotent against the unique (organisation_id, user_id) key — a duplicate invite leaves one row, still invited, and moves no policy_revision. Address normalized as profiles.email is. An address with no identity record, or with more than one, is refused inside the 42501 family: creating an identity is GoTrue''s and T-201''s, and a distinct code would be an account-existence oracle (#13(2)). Suspended and removed rows are not resurrected. No email, no notification (T-105).';

-- ---------------------------------------------------------------- 1b. activate a membership (members.admin)
-- Ruling 2: **this is the only RPC that activates anything.** An `invited` person claiming their own
-- membership cannot be a FAQ-0011-scoped RPC at all, because `set_tenant_scope` raises 28000 unless
-- `is_active_member` is already true (`tenancy_core.sql:214`) — which is why the pre-activation read had
-- to be a named carve-out in ADR-0003 §3b, and packet line 66 puts invite sign-in in T-201. So what
-- lives here is the admin completing the step: the actor is a tenant admin, the target is a user id, and
-- no invitee ever calls this RPC.
create or replace function public.activate_membership_v1(
  p_organisation_id uuid,
  p_user_id uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_actor uuid;
  v_membership uuid;
  v_status text;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required to activate a membership' using errcode = '28000';
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
       and rp.area = 'members.admin'
       and rp.level = 'admin'
     where m.organisation_id = v_organisation
       and m.user_id = v_actor
       and m.status = 'active'
  ) then
    raise exception 'not permitted to administer members' using errcode = '42501';
  end if;
  if p_user_id is null then
    raise exception 'a user id is required to activate a membership' using errcode = '22023';
  end if;

  -- id **and** tenant in one predicate: a membership of another tenant is not found, with the same code
  -- and wording as one that does not exist, so the attempt learns nothing about ids elsewhere (#13(2)).
  -- Load-bearing because a definer body bypasses RLS.
  select m.id, m.status into v_membership, v_status
    from public.organisation_memberships m
   where m.organisation_id = v_organisation
     and m.user_id = p_user_id;
  if v_membership is null then
    raise exception 'no such member in this organization' using errcode = '42501';
  end if;
  if v_status not in ('invited', 'active') then
    -- suspended / removed: refused, not resurrected (see invite_member_v1 above).
    raise exception 'no such member in this organization' using errcode = '42501';
  end if;
  if v_status = 'active' then
    -- Already active: **write nothing.** A re-submit that wrote `status = status, joined_at = now()`
    -- would be a real write, would move policy_revision, and would overwrite the hour someone actually
    -- joined. Returning the id with no write keeps "a no-op does not move the revision" true even if the
    -- writer were broken.
    return v_membership;
  end if;

  update public.organisation_memberships
     set status = 'active',
         joined_at = coalesce(joined_at, now())
   where id = v_membership
     and organisation_id = v_organisation;

  return v_membership;
end;
$$;

comment on function public.activate_membership_v1(uuid, uuid) is
  'Scoped RPC (FAQ-0011): the admin completing an invite, not the invitee claiming it — set_tenant_scope refuses a caller whose own membership is invited, so an invitee-side redemption is ADR-0003 §3b and T-201, never this function (ruling 2). invited -> active; already-active writes nothing and moves no policy_revision; suspended and removed are refused inside the 42501 family rather than resurrected.';

-- ---------------------------------------------------------------- 1c. grant and revoke a role (members.admin)
-- The demotion path is what makes "removal bites on the next request" true, so grant and revoke are the
-- security-relevant pair: a permission row is what the gate above reads, and it is re-read on every
-- request because there is no cached decision anywhere in this schema.
create or replace function public.grant_membership_role_v1(
  p_organisation_id uuid,
  p_user_id uuid,
  p_role_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_actor uuid;
  v_membership uuid;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required to grant a role' using errcode = '28000';
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
       and rp.area = 'members.admin'
       and rp.level = 'admin'
     where m.organisation_id = v_organisation
       and m.user_id = v_actor
       and m.status = 'active'
  ) then
    raise exception 'not permitted to administer members' using errcode = '42501';
  end if;
  if p_user_id is null or p_role_id is null then
    raise exception 'a user id and a role id are required to grant a role' using errcode = '22023';
  end if;

  -- The **membership** row is found tenant-bounded: it is addressed by user id, which is exactly the
  -- case the header says the existence check carries (no FK can speak for it). A membership in another
  -- tenant is not found at all. A **suspended or removed** membership is not found either: a role grant
  -- is a widening, and AGENTS.md §4.2 and the packet's "a suspended membership's admin call fails" box
  -- both require a deactivated member not to gain permissions — nothing in this migration reinstates a
  -- member, so a grant to one would sit there waiting to bite on reinstatement. Same code, same wording
  -- as every other missing row. (The **revoke** path below keeps no status filter on purpose: removing a
  -- role from a departed member narrows, and narrowing must always be possible.)
  select m.id into v_membership
    from public.organisation_memberships m
   where m.organisation_id = v_organisation
     and m.user_id = p_user_id
     and m.status in ('invited', 'active');
  if v_membership is null then
    raise exception 'no such member in this organization' using errcode = '42501';
  end if;

  -- The **role** id is deliberately NOT pre-checked: the composite FK
  -- `membership_roles (role_id, organisation_id) -> organisation_roles (id, organisation_id)`
  -- (`tenancy_core.sql:117-118`) is what refuses a role belonging to another tenant, with 23503, and
  -- filtering it here instead would turn an impossible reference into a silent ignore — the exact thing
  -- the packet''s negative box forbids. `organisation_id = v_organisation` in the VALUES list is what
  -- makes the FK unmatchable for a foreign role, and that value comes from the scope, never from the
  -- caller.
  insert into public.membership_roles (organisation_id, membership_id, role_id)
  values (v_organisation, v_membership, p_role_id)
  on conflict (membership_id, role_id) do nothing;
end;
$$;

comment on function public.grant_membership_role_v1(uuid, uuid, uuid) is
  'Scoped RPC (FAQ-0011): idempotent on the unique (membership_id, role_id) key, so a replay writes nothing and moves no policy_revision. A role_id from another tenant is refused by the composite FK to organisation_roles with 23503, never filtered — the packet''s negative box requires the FK to speak. The membership is addressed tenant-bounded **and live**: another tenant''s member, or one who is suspended or removed, is simply not found (42501) — a grant is a widening, so it does not reach a member the tenant has cut off.';

create or replace function public.revoke_membership_role_v1(
  p_organisation_id uuid,
  p_user_id uuid,
  p_role_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_actor uuid;
  v_membership uuid;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required to revoke a role' using errcode = '28000';
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
       and rp.area = 'members.admin'
       and rp.level = 'admin'
     where m.organisation_id = v_organisation
       and m.user_id = v_actor
       and m.status = 'active'
  ) then
    raise exception 'not permitted to administer members' using errcode = '42501';
  end if;
  if p_user_id is null or p_role_id is null then
    raise exception 'a user id and a role id are required to revoke a role' using errcode = '22023';
  end if;

  select m.id into v_membership
    from public.organisation_memberships m
   where m.organisation_id = v_organisation
     and m.user_id = p_user_id;
  if v_membership is null then
    raise exception 'no such member in this organization' using errcode = '42501';
  end if;

  -- A DELETE has no FK to make the tenant check for it, so `organisation_id = v_organisation` in the
  -- predicate is the whole of the tenant bound here, and it is the reason a role id from another tenant
  -- matches nothing instead of deleting that tenant''s assignment. Not-found answers inside the same
  -- 42501 family as the permission gate.
  delete from public.membership_roles
   where membership_id = v_membership
     and role_id = p_role_id
     and organisation_id = v_organisation;

  if not found then
    raise exception 'no such role assignment in this organization' using errcode = '42501';
  end if;
end;
$$;

comment on function public.revoke_membership_role_v1(uuid, uuid, uuid) is
  'Scoped RPC (FAQ-0011): the demotion path. organisation_id is in the DELETE predicate because a DELETE has no composite FK to enforce the tenant bound — without it a foreign role_id could match. Effect is immediate: the permission gate is re-read from these tables on every request, so there is no cached decision to invalidate (policy_revision is for runs, per #98, not for this).';

-- ---------------------------------------------------------------- 1d. project admin (projects.admin)
create or replace function public.create_project_v1(
  p_organisation_id uuid,
  p_key text,
  p_name text,
  p_visibility text
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_actor uuid;
  v_id uuid;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required to create a project' using errcode = '28000';
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
       and rp.area = 'projects.admin'
       and rp.level = 'admin'
     where m.organisation_id = v_organisation
       and m.user_id = v_actor
       and m.status = 'active'
  ) then
    raise exception 'not permitted to administer projects' using errcode = '42501';
  end if;

  -- Shape before the table, so a malformed request never reaches a constraint and never echoes a
  -- constraint name. The CHECKs at `tenancy_core.sql:125-128` remain the enforcement — these tests only
  -- give a better code, they do not replace the constraint.
  if p_key is null or p_key !~ '^[a-z0-9][a-z0-9-]{0,62}$' then
    raise exception 'project key must be 1-63 lowercase letters, digits and hyphens' using errcode = '22023';
  end if;
  if p_name is null or char_length(btrim(p_name)) < 1 or char_length(p_name) > 200 then
    raise exception 'project name must be between 1 and 200 characters' using errcode = '22023';
  end if;
  -- `status` has no parameter on purpose: archiving is not part of this PR''s ruled scope, and a
  -- parameter that is accepted and then ignored is worse than one that does not exist (compare #154).
  if p_visibility is null or p_visibility not in ('organisation', 'project') then
    raise exception 'visibility must be organisation or project' using errcode = '22023';
  end if;

  -- Not idempotent by key, unlike the three membership writes: two different projects with the same key
  -- is an admin mistake, not a retry, and the unique (organisation_id, key) key says so as 23505
  -- (the header lists 23505 precisely for this). `status` and `created_at` take their table defaults,
  -- and `organisation_id` comes from the scope.
  insert into public.projects (organisation_id, key, name, visibility)
  values (v_organisation, p_key, p_name, p_visibility)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.create_project_v1(uuid, text, text, text) is
  'Scoped RPC (FAQ-0011). No p_status parameter: archiving is outside this PR and an accepted-then-ignored parameter is worse than an absent one (#154). A duplicate key is 23505 from the unique (organisation_id, key) key rather than a silent no-op, because a key collision is an admin mistake and not a re-submission. An UPDATE on projects only runs at all because this migration drops the broken projects_touch_updated trigger.';

create or replace function public.add_project_member_v1(
  p_organisation_id uuid,
  p_project_id uuid,
  p_user_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_actor uuid;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required to add a project member' using errcode = '28000';
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
       and rp.area = 'projects.admin'
       and rp.level = 'admin'
     where m.organisation_id = v_organisation
       and m.user_id = v_actor
       and m.status = 'active'
  ) then
    raise exception 'not permitted to administer projects' using errcode = '42501';
  end if;
  if p_project_id is null or p_user_id is null then
    raise exception 'a project id and a user id are required to add a project member' using errcode = '22023';
  end if;

  -- The target must hold a **live** membership of this tenant — `invited` or `active`. A project is an
  -- information boundary inside a tenant, so a project-membership row for someone who belongs to no
  -- tenant at all is a row that grants nothing and misleads the next reader; and a row for a
  -- **suspended** or **removed** member is worse than misleading, it is an audience held open for a
  -- person the tenant has already cut off (AGENTS.md §4.2's deactivated-member case, and the packet's
  -- "a suspended membership's admin call fails" box). `invited` is included so an admin can put someone
  -- on a project at the same moment they invite them. Refused inside the 42501 family, with the same
  -- wording as every other missing row. The **removal** path below keeps no status filter: narrowing an
  -- audience must always be possible, including for someone who has already left.
  if not exists (
    select 1
      from public.organisation_memberships m
     where m.organisation_id = v_organisation
       and m.user_id = p_user_id
       and m.status in ('invited', 'active')
  ) then
    raise exception 'no such member in this organization' using errcode = '42501';
  end if;

  -- The project id is **not** pre-checked, for the same reason as the role id above: the composite FK
  -- `project_memberships (project_id, organisation_id) -> projects (id, organisation_id)`
  -- (`tenancy_core.sql:146-148`) is what refuses another tenant''s project, with 23503. The packet names
  -- this case in its negative box ("a company2 project_id raises 23503, never ignored"), and a filter
  -- here would answer 42501 and hide it.
  insert into public.project_memberships (organisation_id, project_id, user_id)
  values (v_organisation, p_project_id, p_user_id)
  on conflict (project_id, user_id) do nothing;
end;
$$;

comment on function public.add_project_member_v1(uuid, uuid, uuid) is
  'Scoped RPC (FAQ-0011): idempotent on the unique (project_id, user_id) key. Target must hold a **live** membership of this tenant (`invited` or `active`), so inviting and assigning can happen together; a suspended or removed membership is not found, because a project audience held open for a member the tenant cut off is a widening (§4.2, the packet''s suspended box). A project_id from another tenant is refused by the composite FK to projects with 23503 — never filtered — because the packet''s negative box requires the FK to speak.';

create or replace function public.remove_project_member_v1(
  p_organisation_id uuid,
  p_project_id uuid,
  p_user_id uuid
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_organisation uuid;
  v_actor uuid;
begin
  perform public.set_tenant_scope(p_organisation_id);
  v_organisation := public.current_organisation_id();
  v_actor := auth.uid();
  if v_actor is null then
    raise exception 'no authenticated user' using errcode = '28000';
  end if;
  if v_organisation is null then
    raise exception 'tenant scope is required to remove a project member' using errcode = '28000';
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
       and rp.area = 'projects.admin'
       and rp.level = 'admin'
     where m.organisation_id = v_organisation
       and m.user_id = v_actor
       and m.status = 'active'
  ) then
    raise exception 'not permitted to administer projects' using errcode = '42501';
  end if;
  if p_project_id is null or p_user_id is null then
    raise exception 'a project id and a user id are required to remove a project member' using errcode = '22023';
  end if;

  delete from public.project_memberships
   where project_id = p_project_id
     and user_id = p_user_id
     and organisation_id = v_organisation;

  if not found then
    raise exception 'no such project membership in this organization' using errcode = '42501';
  end if;
end;
$$;

comment on function public.remove_project_member_v1(uuid, uuid, uuid) is
  'Scoped RPC (FAQ-0011): the narrowing that makes "removal bites on the next request" testable. organisation_id is in the DELETE predicate because a DELETE has no composite FK to carry the tenant bound; without it another tenant''s row could match by id. Removal is not silently idempotent: a second removal answers 42501 like any other missing row, so a mistargeted removal is reported rather than swallowed.';

-- ---------------------------------------------------------------- 2. #98: the policy_revision writer
-- One function, fifteen triggers: `AFTER INSERT`, `AFTER UPDATE`, `AFTER DELETE`, each `FOR EACH
-- STATEMENT`, on each of the five tables #98 names. Statement-level rather than row-level on purpose: a
-- per-row writer would add one UPDATE of the `organisations` row for every permission row a single
-- statement touches, and #98 asks for the revision to move once per change, not once per row. (One event
-- per trigger, not `INSERT OR UPDATE`: the docs forbid combining events when transition relations are
-- requested.)
--
-- Why the writer is `security definer` with EXECUTE revoked from every request role: it must write
-- `organisations.policy_revision` from inside a trigger on any of five tables, and it is fired by a
-- statement whose invoking role is `authenticated` — a role that holds no write on `organisations` at
-- all (`tenancy_core.sql:335,343-347`). PostgreSQL does not require the invoking role to hold EXECUTE on
-- a table''s trigger function, so nothing is granted to anybody: `001_function_privileges.test.sql`
-- tests 23-30 are the precedent for a revoked trigger function, and 013 pins all four roles here.
--
-- No-op resistance, the half #98 actually asks for. A statement-level AFTER trigger fires even when the
-- statement affected zero rows, and it fires for an UPDATE that wrote identical values, so the
-- transition tables are what tell the difference:
--   * INSERT / DELETE: any row in the transition table is a real change; an empty one means nothing
--     happened — which is how every `on conflict do nothing` replay above costs nothing.
--   * UPDATE: old and new are joined on `id` and compared as jsonb **minus** the columns that are not
--     policy: `created_at`, `updated_at` (which `organisations_touch_updated` stamps on every update of
--     that table) and `policy_revision` itself. So `set status = status` moves nothing, and the writer''s
--     own UPDATE of `organisations` is invisible to the AFTER UPDATE trigger it fires on
--     `organisations` — that comparison is the whole recursion guard, and 013 pins it by requiring the
--     revision to move by exactly one.
-- `organisations` carries the tenant in its own `id`, the other four in `organisation_id`. The branch is
-- by `tg_table_name` rather than by a jsonb key lookup so that a reviewer can read the tenant bound
-- directly instead of trusting a string that must match a column.
create or replace function public.bump_policy_revision()
returns trigger
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if tg_table_name = 'organisations' then
      update public.organisations o
         set policy_revision = o.policy_revision + 1
       where o.id in (select distinct n.id from new_rows n);
    else
      update public.organisations o
         set policy_revision = o.policy_revision + 1
       where o.id in (select distinct n.organisation_id from new_rows n);
    end if;
  elsif tg_op = 'DELETE' then
    if tg_table_name = 'organisations' then
      update public.organisations o
         set policy_revision = o.policy_revision + 1
       where o.id in (select distinct d.id from old_rows d);
    else
      update public.organisations o
         set policy_revision = o.policy_revision + 1
       where o.id in (select distinct d.organisation_id from old_rows d);
    end if;
  else
    if tg_table_name = 'organisations' then
      update public.organisations o
         set policy_revision = o.policy_revision + 1
       where o.id in (
         select n.id
           from new_rows n
           join old_rows d on d.id = n.id
          where (to_jsonb(n) - 'created_at' - 'updated_at' - 'policy_revision')
             is distinct from (to_jsonb(d) - 'created_at' - 'updated_at' - 'policy_revision')
       );
    else
      update public.organisations o
         set policy_revision = o.policy_revision + 1
       where o.id in (
         select n.organisation_id
           from new_rows n
           join old_rows d on d.id = n.id
          where (to_jsonb(n) - 'created_at' - 'updated_at' - 'policy_revision')
             is distinct from (to_jsonb(d) - 'created_at' - 'updated_at' - 'policy_revision')
       );
    end if;
  end if;
  -- A statement-level trigger''s return value is ignored. `null` also carries the honest answer for every
  -- empty transition table and every identical UPDATE: this statement changed no policy, so nothing moves.
  return null;
end;
$$;

comment on function public.bump_policy_revision() is
  '#98: the only writer of organisations.policy_revision. AFTER INSERT / AFTER UPDATE / AFTER DELETE, FOR EACH STATEMENT, on organisation_memberships, membership_roles, role_permissions, project_memberships and organisations. security definer with EXECUTE revoked from public, anon, authenticated and service_role and granted to nobody, because a table''s trigger fires without the invoking role holding EXECUTE. No-op resistant through the transition tables: an UPDATE compares the row as jsonb minus created_at, updated_at and policy_revision, joined on id, so a replay or an identical write moves nothing and the writer''s own UPDATE of organisations does not recurse into a second bump.';

-- The fifteen. Two transition-table shapes: INSERT names only a NEW TABLE, DELETE only an OLD TABLE,
-- UPDATE both (`sql-createtrigger`: OLD TABLE only for UPDATE or DELETE, NEW TABLE only for UPDATE or
-- INSERT). Names are `new_rows` / `old_rows` everywhere so the function body above has one vocabulary.
create trigger organisation_memberships_bump_policy_rev_insert
  after insert on public.organisation_memberships
  referencing new table as new_rows
  for each statement execute function public.bump_policy_revision();
create trigger organisation_memberships_bump_policy_rev_update
  after update on public.organisation_memberships
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.bump_policy_revision();
create trigger organisation_memberships_bump_policy_rev_delete
  after delete on public.organisation_memberships
  referencing old table as old_rows
  for each statement execute function public.bump_policy_revision();

create trigger membership_roles_bump_policy_rev_insert
  after insert on public.membership_roles
  referencing new table as new_rows
  for each statement execute function public.bump_policy_revision();
create trigger membership_roles_bump_policy_rev_update
  after update on public.membership_roles
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.bump_policy_revision();
create trigger membership_roles_bump_policy_rev_delete
  after delete on public.membership_roles
  referencing old table as old_rows
  for each statement execute function public.bump_policy_revision();

create trigger role_permissions_bump_policy_rev_insert
  after insert on public.role_permissions
  referencing new table as new_rows
  for each statement execute function public.bump_policy_revision();
create trigger role_permissions_bump_policy_rev_update
  after update on public.role_permissions
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.bump_policy_revision();
create trigger role_permissions_bump_policy_rev_delete
  after delete on public.role_permissions
  referencing old table as old_rows
  for each statement execute function public.bump_policy_revision();

create trigger project_memberships_bump_policy_rev_insert
  after insert on public.project_memberships
  referencing new table as new_rows
  for each statement execute function public.bump_policy_revision();
create trigger project_memberships_bump_policy_rev_update
  after update on public.project_memberships
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.bump_policy_revision();
create trigger project_memberships_bump_policy_rev_delete
  after delete on public.project_memberships
  referencing old table as old_rows
  for each statement execute function public.bump_policy_revision();

create trigger organisations_bump_policy_rev_insert
  after insert on public.organisations
  referencing new table as new_rows
  for each statement execute function public.bump_policy_revision();
create trigger organisations_bump_policy_rev_update
  after update on public.organisations
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.bump_policy_revision();
create trigger organisations_bump_policy_rev_delete
  after delete on public.organisations
  referencing old table as old_rows
  for each statement execute function public.bump_policy_revision();

-- ---------------------------------------------------------------- 3. the stale comments, replaced from here
-- What the merged file actually says, quoted rather than paraphrased: the **catalog** comment at
-- `20261105060000_tenancy_core.sql:33-34` is `'Tenant root. Status and policy_revision are authoritative
-- for every access decision.'`, and the claim that the column is "Bumped on any tenancy, membership,
-- role or data-policy change" is a **source** comment at `:27-28` — `policy_revision` never had a catalog
-- column comment at all, so the second statement below creates one rather than replacing one. Both were
-- written when nothing bumped it: `policy_revision` had **no writer at all** until this function existed,
-- so the column silently sat at its default of 1 through every migration and every seed write (#98 was
-- opened for exactly that). The merged file may not be edited (AGENTS.md §6), so the correction is a
-- `comment on` here, and 013 pins the replaced table comment by name — not by a phrase it never
-- contained. Worth flagging upward: the ruling in [T-202](../../docs/tasks/T-202-tenant-admin.md) line 11
-- quotes `tenancy_core.sql:34` as "a monotonic stamp … recorded for audit and used as a cache key;
-- access is always re-derived", and **no such string exists anywhere in `supabase/migrations/`** — the
-- closest thing is the two lines quoted above. Implemented against the real file, not the paraphrase.
comment on table public.organisations is
  'Tenant root. Status is authoritative for every access decision. policy_revision is maintained by public.bump_policy_revision() (AFTER ... FOR EACH STATEMENT on organisation_memberships, membership_roles, role_permissions, project_memberships and organisations) and is how a run is re-checked against the state it was authorized under (#98, plan §9.4).';

comment on column public.organisations.policy_revision is
  'Bumped by public.bump_policy_revision() on any real change to tenancy, membership, role or project-membership state; a no-op write does not move it. Read on purpose through current_policy_revision_v1(uuid) rather than by selecting the column (#171, ADR-0003 §3b). Never assigned by hand.';

-- ---------------------------------------------------------------- 4. #39 seed: WITHHELD by this PR — needs a ruling
-- The packet asks for a permanent `contributor` role holding `knowledge.write`, its permission row and a
-- membership grant. **It is not landed here, and that is a builder decision, not a ruling.** The only
-- recorded supervisor word on this is the opposite — #39 (2026-11-09): "your rule is confirmed, and
-- `knowledge.write` becomes a real, seeded permission" — repeated in the packet's own 2026-11-09 rulings.
-- No supervisor decision to withhold it exists on GitHub or in any project file, so nothing here claims
-- one; what exists is this PR's author declining to land it, for one concrete reason, and asking:
-- a permanent company1 contributor changes counts that merged assertions in **three other slots' files**
-- pin, and FAQ-0007 does not let this PR re-pin files it does not own. Filed as a question for the
-- supervisor, who can either land the seed (with the four re-pins, in one PR that may touch those slots)
-- or defer it to a packet that owns them:
--   * `010_tenancy.test.sql` test 44 — exactly 2 company1 role definitions, which become 3;
--   * `010_tenancy.test.sql` test 45 — exactly 10 company1 rows across role_permissions +
--     membership_roles, which become 12;
--   * `017_scoped_identity_reads.test.sql` test 10 — exactly 4 company1 memberships, which become 5;
--   * `040_knowledge_uploads.test.sql` test 17 — its subject is the member whose only knowledge
--     permission is `knowledge.read`, and a second role on that membership changes what that test means.
--     Weakening it is forbidden.
-- `025_collection_admin.test.sql:18-22` documents the same trap and works around it transaction-locally,
-- which is what `040_knowledge_uploads.test.sql` now does for the fixture this ruling authorized (fresh
-- id, `on conflict do nothing`, granted to a subject no existing assertion counts).
--
-- The three INSERTs, kept here so the next agent sees the shape and the cost together. They are inert as
-- comments; to land one, also re-pin the four assertions above in the same PR:
--   insert into public.organisation_roles (id, organisation_id, key, name) values
--     ('31000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111',
--      'contributor', 'Contributor')
--   on conflict (organisation_id, key) do nothing;
--   insert into public.role_permissions (organisation_id, role_id, area, level) values
--     ('11111111-1111-4111-8111-111111111111', '31000000-0000-4000-8000-000000000003',
--      'knowledge.write', 'write')
--   on conflict (role_id, area) do nothing;
--   insert into public.membership_roles (organisation_id, membership_id, role_id)
--   select m.organisation_id, m.id, '31000000-0000-4000-8000-000000000003'
--     from public.organisation_memberships m
--    where m.organisation_id = '11111111-1111-4111-8111-111111111111'
--      and m.user_id = '00000000-0000-4000-8000-0000000000a2'
--   on conflict (membership_id, role_id) do nothing;
-- Id id landmine, recorded because it is the reason the fixture in 040 uses `...004`: **040 already
-- inserts a company1 role with id `31000000-0000-4000-8000-000000000003`**, and 025 uses that same id for
-- its own transaction-local `contributor`. A permanent seed cannot take that id without colliding with
-- both, and 013 must not reuse it either.
-- Cost if this PR's decision is wrong: the pilot eventually needs a permanent contributor, which is one
-- small migration plus the four re-pins named above, done by a PR that is authorized to touch those
-- three slots — visible and reversible, which is why withholding it here is the cheap direction.

-- ---------------------------------------------------------------- 5. privileges (#60, FAQ-0010)
-- PostgreSQL hands EXECUTE on every new function in `public` to PUBLIC and a migration cannot close that
-- default (FAQ-0010, #142), so each signature is revoked **in the file that creates it** — the standing
-- rule, not decoration. Four grantees are revoked, not three: FAQ-0010 names `public, anon,
-- authenticated`, but the two newest merged migrations revoke `service_role` too
-- (`20261113010000_scoped_identity_reads.sql:60-63`, `20261112234000_session_worker_role.sql:58-64`) and
-- `017` asserts it, so this file matches the house rather than the older wording. Closing `service_role`
-- costs nothing here because nothing in PR-1 is called by a worker or the intake path.
--
-- All seven are granted back to `authenticated`, because all seven are the tenant-admin page''s write
-- path and nothing else: the gate that decides is inside the function (`members.admin` /
-- `projects.admin` at `admin`), the scope helper has already refused anyone who is not an active member
-- of the named tenant, and `anon` gets nothing because tenancy administration is behind sign-in. Each
-- signature below is also a row in `001_function_privileges.test.sql`''s rule-32 allow-list in this same
-- PR (FAQ-0010), and `013` re-pins the grants and the four revokes. `PR-1 calls these only through
-- withTenantRpc (T-101c), which injects p_organisation_id from TenantContext; no page passes one.`
-- `bump_policy_revision()` is revoked from all four and granted to nobody: PostgreSQL fires a table''s
-- trigger without the invoking role holding EXECUTE on its function, and 001 tests 23-30 already accept
-- that shape for the merged trigger functions.
revoke execute on function
  public.invite_member_v1(uuid, text),
  public.activate_membership_v1(uuid, uuid),
  public.grant_membership_role_v1(uuid, uuid, uuid),
  public.revoke_membership_role_v1(uuid, uuid, uuid),
  public.create_project_v1(uuid, text, text, text),
  public.add_project_member_v1(uuid, uuid, uuid),
  public.remove_project_member_v1(uuid, uuid, uuid),
  public.bump_policy_revision()
  from public, anon, authenticated, service_role;

grant execute on function
  public.invite_member_v1(uuid, text),
  public.activate_membership_v1(uuid, uuid),
  public.grant_membership_role_v1(uuid, uuid, uuid),
  public.revoke_membership_role_v1(uuid, uuid, uuid),
  public.create_project_v1(uuid, text, text, text),
  public.add_project_member_v1(uuid, uuid, uuid),
  public.remove_project_member_v1(uuid, uuid, uuid)
  to authenticated;