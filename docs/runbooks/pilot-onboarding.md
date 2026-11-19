# Pilot onboarding (plan §20.3 week 4, §20.8)

**Status of this runbook: prepared; never executed against a real person or a production tenant.** Every `OWNER` line below needs a Company1 roster, a provisioned tenant, a verified sender, or a production write — plan §20.8 and AGENTS §6 bar an agent from those. Every `AGENT` line either names a command or packet path that already exists, or names the open PR that will create it. The staging rehearsal this runbook describes is **owed**, not waived ([COORDINATION §6a](../COORDINATION.md)): [#177](https://github.com/TerraOI/TerraOI/issues/177) still blocks `deploy-staging.yml`, and several steps have no surface on `main` yet.

**Data rule:** no pilot user's name, email, role list, client project code or document title appears in this file. Synthetic seed identities only (`owner1@company1.test`, `field2@company1.test`, `owner2@company2.test` in [supabase/seed.sql](../../supabase/seed.sql)). Real roster ids stay outside git as opaque `P-01`… mappings (AGENTS §4.7; [T-406](../tasks/T-406-pilot-onboarding.md) Assumed).

Placeholders are `<LIKE_THIS>`. Binding names yes; credentials and connection strings no (AGENTS §4.6).

## What this runbook never does

- Invite a real user, create a real membership, or provision a production tenant.
- Invent a second invite path, a second provisioning script, or hand-run SQL that creates memberships ([T-406](../tasks/T-406-pilot-onboarding.md) Must not edit; plan §13: one durable mechanism per workflow).
- Grant a platform admin operational access to a tenant (F05).

## End-to-end sequence

| # | Step | Who | Precondition (packet / T-004 / open PR) | Today |
|---|---|---|---|---|
| 1 | Decide the synthetic rehearsal hosts and add them **together** to DNS and `wrangler.jsonc` `env.staging.routes` | `OWNER` (DNS) + `AGENT` (config PR) | [T-004](../tasks/T-004-infrastructure.md) DNS + routes pairing; proposed host `company3-staging.terraoi.app` | **Planned** — staging deploy blocked by [#177](https://github.com/TerraOI/TerraOI/issues/177) |
| 2 | Run `provision_tenant_v1` for the third synthetic tenant (roles, domains, entitlements) | `AGENT` prepares the call; `OWNER` runs it against staging | [T-304](../tasks/T-304-kill-switch-provisioning.md) ([#193](https://github.com/TerraOI/TerraOI/pull/193)) | **Planned** — #193 awaiting Round-2 |
| 3 | Brand + shell: load brand rows, land the invited user on the tenant chrome | `AGENT` | [T-103](../tasks/T-103-tenant-shell-brand.md): brand [#150](https://github.com/TerraOI/TerraOI/pull/150) **merged**; shell [#173](https://github.com/TerraOI/TerraOI/pull/173) **APPROVED**, merge owed; **no `src/app/(tenant)/` on `main` yet** | **Planned** — shell merge + `(tenant)` routes |
| 4 | Create one project and one collection the pilot corpus will attach to | `AGENT` via T-202 RPCs once they exist | [T-202](../tasks/T-202-tenant-admin.md) ([#179](https://github.com/TerraOI/TerraOI/pull/179)); U-16/U-17 in [BACKLOG.md](https://github.com/TerraOI/TerraOI/pull/190) (draft #190) | **Planned** — #179 not merged; no admin read path on `main` |
| 5 | Invite both synthetic users through T-201's path (never a new one) | `AGENT` | [T-201](../tasks/T-201-auth-methods.md) ([#181](https://github.com/TerraOI/TerraOI/pull/181)/[#186](https://github.com/TerraOI/TerraOI/pull/186)); email transport [T-105](../tasks/T-105-email-transport.md) ([#139](https://github.com/TerraOI/TerraOI/pull/139)) + T-004 sender domain | **Planned** — invites + verified sender |
| 6 | First sign-in on the **exact** rehearsal host | `AGENT` observes; `OWNER` holds no real roster here | [T-102](../tasks/T-102-magic-link-signin.md) on `main` (login [#172](https://github.com/TerraOI/TerraOI/pull/172) merged); staging evidence still owed | **Planned** — staging evidence |
| 7 | Corpus visibility: the tenant answers from its own collection and refuses the other tenant's | `AGENT` | Upload path U-1 (`upload-adapters.ts:19` still `null`); [T-114](../tasks/T-114-search-corpus.md) [#160](https://github.com/TerraOI/TerraOI/pull/160)/[#162](https://github.com/TerraOI/TerraOI/pull/162); chat [#178](https://github.com/TerraOI/TerraOI/pull/178) | **Planned** — retrieval/job/chat chain |
| 8 | Reviewer accounts for [T-303](../tasks/T-303-eval-review-view.md) | `OWNER` names UAV/GPR reviewers (D-6); `AGENT` does not invent people | §18.3 · §20.8 row 7 · D-6 in [BACKLOG.md](https://github.com/TerraOI/TerraOI/pull/190) | **Planned** — owner roster |

## Owner-step table (named blockers)

| Owner step | Blocker id | What "done" looks like |
|---|---|---|
| Company1 pilot roster + initial projects | D-6 | Opaque `P-01`… list held outside git; project codes never committed |
| Named UAV / GPR eval reviewers | D-6 | Accounts exist on the rehearsal tenant; T-303 can grant without inventing names |
| Real invites only after M1-PILOT sign-off | D-11 | Gate row in `docs/status/`; no soft pre-gate unless recorded as a deviation |
| Verified sender + SPF/DKIM/DMARC | D-9 / T-004 | T-105 can send; bounce path is observable |
| Staging deploy usable again | [#177](https://github.com/TerraOI/TerraOI/issues/177) | `deploy-staging.yml` not refused by an open `policy-violation` |
| Production tenant (never this rehearsal) | D-9 | Out of this runbook's scope; listed so nobody confuses the two |

## Stop conditions

- Any step would require a real email address, person name or client document title in the repository → **stop** (AGENTS §4.7).
- `provision_tenant_v1` is being aimed at production → **stop** (AGENTS §6).
- The invited membership is `invited` or `removed` and the surface shows anything other than the generic no-access page → file against T-102/T-201; do not weaken the check.
- The platform admin who provisioned the tenant resolves a tenant context → file against T-304; that is the F05 regression this sequence exists to catch.

## What is still missing before this runbook is executable

1. Merge (or equivalent) of T-304 / T-201 / T-202 / T-103 `(tenant)` shell, and a green staging deploy.
2. U-1 storage wiring so step 7 has a corpus.
3. Owner answers on D-6 and D-11 before any non-synthetic invite is contemplated.
