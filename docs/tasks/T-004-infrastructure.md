# T-004 Staging infrastructure (human-only)

Lane: n/a · Week: 0 · Protected: n/a · Depends on: none · Status: ready
Plan refs: §4.1, §13, §17.2, §20.8

Agents must not perform these steps; they need account access and secrets.

## Steps
- [ ] Supabase **staging** project; note its project ref
- [ ] Cloudflare: proxied DNS for staging tenant hosts; add staging `routes` to `wrangler.jsonc` `env.staging` in a PR (no secrets)
- [ ] Cloudflare API token (Workers deploy only) and account id
- [ ] GitHub → Settings → Environments → `staging`: add secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_STAGING_PROJECT_REF`, `SUPABASE_STAGING_DB_PASSWORD`; restrict the environment to `main`
- [ ] Local box: Cloudflare Tunnel + Access service token (staging), recorded in a password manager, not the repo
- [ ] Entra (Microsoft) app registration for staging callbacks
- [ ] Branch protection on `main`: **needs GitHub Team** (private repos on Free cannot use it). Then create ruleset `protect-main`: require PR, 1 approval, code-owner review, dismiss stale approvals, status checks `verify`, `database`, `lanes`, `secrets` (not the Cloudflare check), block force-push and deletion. After it is active, remove `.github/workflows/main-guard.yml` and the provenance step in `deploy-staging.yml`
- [ ] Disconnect Cloudflare Workers Builds from this repo (or adopt it and remove `deploy-staging.yml`); one deploy path only (plan §13, §17.2)

## Done evidence
`docs/status/` entry listing what exists (no secret values) and a successful `Deploy staging` run.
