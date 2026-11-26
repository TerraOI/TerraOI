# ADR-0012 The control-plane role (`toi_control_plane`) (#193 E1, T-304)

Status: **accepted** · Date: 2026-11-18 · Deciders: wyu610 ([#193](https://github.com/TerraOI/TerraOI/pull/193) E1)
Plan refs: §4.1 (line 212), §6.1, §11 F05, §15.0, §20.8; FAQ-0010; ADR-0003 §3a (#75)
Depends on: ADR-0002 (unexposed schema + least-privilege login), ADR-0003 §3a (session carrier is a different credential)

## Context

T-304 adds a privileged path that can suspend any tenant, resume it, flip expert and provider
switches, and provision tenants by script. That path needs a database role. ADR-0003 §3a already
records how the Worker reaches the session store (`toi_session_worker` over `SESSION_DB`); this
role is not that carrier and must not ride the same binding. Round 1 on [#193](https://github.com/TerraOI/TerraOI/pull/193)
escalated the credential shape as E1; this ADR is the ruling. ADR-0009 is reserved for the
refusal vocabulary (#97 / #137 / #151); ADR-0010 for T-312; ADR-0011 for #149 — this record is
0012.

## Decision

### 1. Role and grants

`toi_control_plane` is a **NOLOGIN** group role. It receives:

- `USAGE` on the non-exposed schema `toi_control` (not listed in `supabase/config.toml` `[api] schemas`)
- `EXECUTE`, by full signature, on the six lifecycle / provisioning functions suite 52 counts
  (`set_lifecycle_switch_v1`, `lifecycle_switch_state_v1`, `lifecycle_switch_history_v1`,
  `suspend_tenant_v1`, `resume_tenant_v1`, `provision_tenant_v1`) plus the T-311 entitlement definer
  added per `#193 E3`:
  `toi_control.entitle_tenant_service_v1(uuid, text, text, text, uuid[], text, text)`

It receives **no table grants**, no privilege on `public` tables, and no special `USAGE` on `public`
beyond what every role already has. `require_control_plane()` stays an internal helper (revoked from
request roles; not granted to `toi_control_plane`). The #199 provider read
`provider_switch_state_v1` is granted to `toi_gateway_config` when that role exists, not to
`toi_control_plane`.

### 2. Who connects

Only the operator-run script [`scripts/provision-tenant.mjs`](../../scripts/provision-tenant.mjs),
from the owner's machine, via a login user that is `IN ROLE toi_control_plane` and whose DSN is
supplied as the env var `CONTROL_PLANE_DB`.

**No Worker binding, no Hyperdrive config, no `wrangler.jsonc` entry and no CI secret.** M1 has no
control-plane UI (plan §15.0), so nothing deployed needs this credential.
`pnpm check:structure` refuses a `CONTROL_PLANE_DB` binding (or the literal name) in
`wrangler.jsonc`.

### 3. Threat model

A leaked control-plane credential can:

- create tenants
- suspend or resume any tenant
- flip expert and provider switches
- entitle tenants to services and approved expert versions (`toi_control.entitle_tenant_service_v1`, T-311 / #193 E3)

It **cannot** read documents, chats, memberships or any tenant row, and it **cannot** grant a
membership (F05; suite 59). Both halves belong in this record so a later change that adds a table
grant or a membership seed is a deliberate ADR amendment, not a quiet script edit.

### 4. Credential handling

One login per environment (staging and production never share one). The password lives in the
owner's password manager only, with SSL required, and is rotated after each provisioning session in
the pilot. Creating the login is a §20.8 human step on T-004 — the same split as #75 for
`toi_session_worker`.

### 5. Audit

Flip and provision rows record `actor_role = session_user` (the database login the session saw) and
the unverified `requested_by` string the operator typed. Until T-313's ledger exists, "who" on this
path means "which login", not a verified human identity.

## Consequences

- T-304's migration and pgTAP suite 50 / 52 are the living grant list; changing it updates this ADR
  in the same PR.
- T-311's migration (`20261120218000_experts_and_prompts.sql`) grants `toi_control.entitle_tenant_service_v1`
  to `toi_control_plane` and adds it to suite 50 and this ADR (#193 E3); a follow-up T-304 slice
  will call it from `scripts/provision-tenant.mjs` without writing T-311's tables directly.

## Alternatives considered

- **Amend ADR-0003 §3a.** Rejected: §3a is the session carrier; folding a second privileged path
  into it blurs the "Worker never holds this credential" rule.
- **Hyperdrive / Worker binding for M1.** Rejected: no control-plane UI in M1; a leaked Worker
  secret would be a permanent production foothold for tenant create/suspend.
- **Grant `toi_control_plane` table SELECT for provision read-back.** Rejected: B2 / FAQ-0010 —
  read-back returns from `provision_tenant_v1` so the role needs no table privilege.
