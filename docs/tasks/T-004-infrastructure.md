# T-004 Staging infrastructure (human-only)

Lane: n/a · Week: 0 · Protected: n/a · Depends on: none · Status: ready
Plan refs: §4.1, §13, §17.2, §20.8

Agents must not perform these steps; they need account access and secrets.

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
