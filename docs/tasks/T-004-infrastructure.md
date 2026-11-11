# T-004 Staging infrastructure (human-only)

Lane: n/a · Week: 0 · Protected: n/a · Depends on: none · Status: ready
Plan refs: §4.1, §13, §17.2, §20.8

Agents must not perform these steps; they need account access and secrets.

## Supervisor rulings to apply (2026-11-09)
These supersede anything below that disagrees.
- **Owed staging runs** ([#92](https://github.com/TerraOI/TerraOI/issues/92), [#94](https://github.com/TerraOI/TerraOI/issues/94)): T-115's external-mock probe on the staging Worker (with T-314's box-offline drill); T-102's sign-in demo after T-105 and the `SESSION_DB` step above. Each is recorded in `docs/status/` when run.
- **Server-path database roles** ([#134](https://github.com/TerraOI/TerraOI/issues/134)): one `NOLOGIN` role per server path, each granted `IN ROLE` to its own login user and reached through its own Hyperdrive binding (staging first): `toi_job_api` over **`JOB_DB`** (T-211) and `toi_gateway_config` over **`CONFIG_DB`** (T-116). The owner creates each login user and password, the Hyperdrive config and its `wrangler.jsonc` binding.
- **Worker credentials** ([#134](https://github.com/TerraOI/TerraOI/issues/134)): one per executor (each box, and the cloud worker). The owner issues each token through T-211's reviewed owner script, which stores only the hash; the box token goes on the box, the cloud token in a `wrangler secret`. Never in the repository.
- **Storage signing key** ([#146](https://github.com/TerraOI/TerraOI/issues/146)): the owner sets the Supabase service-role key as a `wrangler secret` on the `workers/` (job API) deployment only — never on the app Worker, in `.dev.vars` of the app, or in CI — and rotates it on any suspected leak.
- **`workers/` deployment** ([#152](https://github.com/TerraOI/TerraOI/issues/152)): the owner creates the second Worker (staging first), deploys it from T-211's wrangler config, and adds the service binding from the app Worker to it. The signing key above goes on this Worker only.

## Steps
- [x] Supabase **staging** project; note its project ref (TerraOI-Staging, separate from production; W45 register)
- [ ] Cloudflare: proxied DNS for staging tenant hosts; add staging `routes` to `wrangler.jsonc` `env.staging` in a PR (no secrets)
- [x] Cloudflare API token (Workers deploy only) and account id (W45 register)
- [x] GitHub → Settings → Environments → `staging`: add secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_STAGING_PROJECT_REF`, `SUPABASE_STAGING_DB_PASSWORD`; restrict the environment to `main`
- [ ] Local box: Cloudflare Tunnel + Access service token (staging), recorded in a password manager, not the repo
- [ ] Entra (Microsoft) app registration for staging callbacks
- [ ] Branch protection on `main`: **needs GitHub Team** (private repos on Free cannot use it). Then create ruleset `protect-main`: require PR, 1 approval, code-owner review, dismiss stale approvals, status checks `verify`, `database`, `lanes`, `migrations`, `provisional`, `secrets` (`repo-hygiene` is scheduled, not a PR check), block force-push and deletion. After it is active, remove `.github/workflows/main-guard.yml` and the provenance step in `deploy-staging.yml`
- [x] Disconnect Cloudflare Workers Builds from this repo (owner, 2026-11-04); one deploy path only (plan §13, §17.2)
- [x] Before merging PR #1: Settings → Secrets and variables → Actions → **Variables** → `SUPERVISOR_LOGINS` = `wyu610` (set 2026-11-05; comma-separated). Without it, the supervisor's own merges have no second approver and are flagged as violations
- [ ] Check environment support: protected environments (and environment secrets) for **private** repos need a paid plan. On GitHub Free, staging secrets may have to be **repository** secrets, which any workflow on any branch can read, including one edited in a PR. Treat that as one more reason for GitHub Team before real staging credentials are added

- [ ] Session store ([#75](https://github.com/TerraOI/TerraOI/issues/75), ADR-0003 amendment): login role `IN ROLE toi_session_worker` with its password set in the dashboard, Hyperdrive config `SESSION_DB` bound in `wrangler.jsonc` `env.staging`, and the session-encryption Worker secret
- [ ] Pilot inquiry writer (ADR-0002): login role `IN ROLE inquiry_writer`, Hyperdrive config `INQUIRY_DB`, Turnstile keys and `INQUIRY_IP_HMAC_KEY` as Worker secrets
- [ ] Email transport ([#64](https://github.com/TerraOI/TerraOI/issues/64), T-105): choose the provider, verify the sending domain, publish SPF, DKIM and DMARC records, and set the API key as a Worker secret (staging first)
- [ ] Claude verifier ([#46](https://github.com/TerraOI/TerraOI/issues/46), T-115f): Anthropic account with a spend limit, and the API key as a Worker secret (staging first)

## Done evidence
`docs/status/` entry listing what exists (no secret values) and a successful `Deploy staging` run.
