# T-130 Platform landing page and pilot-inquiry form

Lane: 1 (plus shared `supabase/` and new platform module `site`) · Week: 2 · Protected: yes (`supabase/migrations/`, `docs/decisions/`, new module) · Depends on: T-002, T-101 (with the `requestHost` fix from the #5 review)
Status: in progress (wyu610)
Plan refs: §1.1, §3.2, §4.1 (domain map, front-door intake row), §4.3, §5.1, §6.2, §20.8; F01

## Goal
`terraoi.app` (and `www.terraoi.app`) shows a TerraOI-branded landing page. It explains the product in the brand voice, sends people to their workspace without revealing which workspaces exist, and lets a prospective customer submit a pilot inquiry. Submissions are stored in Supabase through a write path anonymous visitors can't reach, and they're deleted after 12 months. Tenant hosts and unknown hosts never see the landing page.

Mockup: approved by the supervisor on 2026-11-05: nav, hero with the core tagline and workspace finder, Observe/Plan/Act cards, trust strip and footer, using the brand kit's palette, symbol and contour art.

## Owns (may edit)
- `src/app/page.tsx` (replaces the scaffold placeholder), `src/app/privacy/page.tsx`
- tokens copied from `brand/terraoi-brand-kit/02-system/tokens.json` into `src/components/site/site.module.css` (no import from `brand/`, FAQ-0001; no edit to T-103's `src/app/layout.tsx` or `public/`)
- `src/components/site/` (hero, workspace finder, Observe/Plan/Act, trust strip, footer, `pilot-form.tsx`)
- `src/app/api/pilot-inquiry/route.ts`
- `src/platform/site/` (new module: inquiry schema, request checks, rate limit, IP hashing, DB adapter) and its tests; add `site` to `PLATFORM_MODULES` in `scripts/structure.mjs` and to the module list in `docs/REPO-STRUCTURE.md`
- one migration `supabase/migrations/YYYYMMDDHHMMSS_pilot_inquiries.sql`, timestamp later than everything on `main` at the time the PR opens; `supabase/tests/database/030_pilot_inquiries.test.sql`
- `docs/decisions/0002-pilot-inquiry-intake.md`
- `wrangler.jsonc`: Turnstile site key var, rate-limit binding and Hyperdrive binding names only (no secrets)
- `package.json`: the Postgres driver for Hyperdrive (named in the PR with a reason)

## Must not edit
`src/contracts/` (no contract change needed), `src/platform/tenancy/` (T-101 owns host parsing and middleware; this packet *calls* `parseHost`), `src/platform/identity/`, `src/platform/branding/` (T-103), `src/app/(tenant)/`, `brand/`, Lane 2 paths, merged migrations.

## Contract

**Host gating.** Platform hosts (`terraoi.app`, `www.terraoi.app`) render the landing page. Every other host gets the generic "This address is not recognized." page (`SAFE_FAILURE_MESSAGE`, T-101). The host comes only from T-101's fixed `requestHost` (the trusted request URL, never `X-Forwarded-Host`) and `parseHost` (§4.1 step 1). When T-101's middleware routes by host class, it takes over this gate; the page-level check stays as a second layer.

**Workspace finder.** The input accepts a slug of 1–63 characters from `a-z`, `0-9` and `-`, not starting or ending with `-` (one DNS label). On submit it navigates to `https://<slug>.terraoi.app/`. It does **no lookup** and shows no "workspace not found" message, so it can't be used to discover which companies use TerraOI (§4.1 step 3). An invalid slug gets an inline format error only.

**Pilot inquiry fields** (`src/platform/site/pilot-inquiry.ts`, strict Zod):

| Field | Rule |
|---|---|
| `name` | required, trimmed, 1–120 |
| `email` | required, email format, ≤254, stored lowercase |
| `company` | required, 1–160 |
| `role` | optional, ≤120 |
| `services` | non-empty subset of `uav`, `gpr`, `other` |
| `message` | optional, ≤2000 |
| `privacyAcknowledged` | must be `true` |
| `website` | honeypot: must be empty or absent |
| `turnstileToken` | required, 1–2048 |

**`POST /api/pilot-inquiry`**, checks in this order (cheapest first):
1. Host is a platform host, else `404`. `Origin` exactly equals `https://<that host>`, else `403`.
2. `Content-Type: application/json` and body ≤ 8 KB, else `415` / `413`.
3. Strict schema parse, else `400` with field-level messages only.
4. Turnstile `siteverify` with `TURNSTILE_SECRET`, else `400` "Verification failed. Try again."
5. Workers rate-limit binding, key = HMAC-SHA256(`INQUIRY_IP_HMAC_KEY`, `CF-Connecting-IP`), limit 3 per 60 seconds (the binding only supports 10 s or 60 s periods; verify against the current Cloudflare docs when implementing), else `429` "Too many requests. Try again later."
6. Call `intake.submit_pilot_inquiry_v1(...)` over the Hyperdrive binding as `inquiry_writer`. Any failure → `503` "The service is temporarily unavailable. Try again later." Nothing internal is echoed back.
7. `201` `{ "status": "received" }`. The UI shows "Thanks. We'll reply by email."

The raw IP is never stored or logged. Only the HMAC goes to the database.

**Database** (one migration):
- Schema `intake`, **not** in the Supabase API's exposed schemas. `revoke all on schema intake from public, anon, authenticated`.
- Table `intake.pilot_inquiries`: `id uuid pk`, `created_at timestamptz`, `name`, `email`, `company`, `role`, `services text[]`, `message`, `ip_hash text` (64-hex), `status text check in ('new','contacted','closed') default 'new'`. CHECK constraints mirror the field rules. RLS enabled, no policies.
- Function `intake.submit_pilot_inquiry_v1(p_name, p_email, p_company, p_role, p_services, p_message, p_ip_hash) returns void`: `SECURITY DEFINER`, `set search_path = intake, pg_temp`, insert-only, re-validates lengths and formats (`23514` on violation). `revoke execute from public`; `grant execute to inquiry_writer`.
- Role `inquiry_writer` created `NOLOGIN` with no other grants. Its login user is created by hand (see Human steps). **No password or connection string in the repo.**
- Retention: function `intake.prune_pilot_inquiries() returns integer` (deletes rows with `created_at < now() - interval '12 months'`, returns the count; `execute` granted to nobody but the owner), scheduled daily by `pg_cron`. Tests call the function directly.
- Reading inquiries in M1: supervisor via the Supabase dashboard. An admin UI is out of scope.

**ADR-0002** records: why storage was chosen over email, no anonymous database path, a least-privilege role over Hyperdrive rather than the service-role key (which bypasses RLS on every tenant table and would sit in the public web Worker), IP HMAC, and 12-month retention.

## Acceptance tests (write first)
- [ ] positive: a valid inquiry parses; the route returns `201` and calls the DB adapter exactly once with an `ip_hash` of 64 hex chars and no raw IP anywhere in the arguments
- [ ] positive: the landing page renders on `terraoi.app` and `www.terraoi.app`; the workspace finder turns `company1` into `https://company1.terraoi.app/`
- [ ] negative: the landing page on `company1.terraoi.app`, `admin.terraoi.app` or an unknown host renders the generic not-recognized page; the route on those hosts returns `404`
- [ ] negative: wrong `Origin` → `403`; body over 8 KB → `413`; unknown key, over-length field, bad email, empty `services`, unacknowledged privacy, filled honeypot → `400` each
- [ ] negative: the workspace finder rejects `Company1`, `a.b`, `-x` and a 64-char slug, and never issues a network request
- [ ] failure: Turnstile rejects → `400`; rate limit exceeded → `429`; DB adapter throws → `503` with the generic message and no error detail in the body
- [ ] SQL: as `anon` and as `authenticated`, `select` / `insert` on `intake.pilot_inquiries` and `execute` on the function are all denied
- [ ] SQL: as `inquiry_writer`, `execute` succeeds; `select`, `update` and `delete` on the table are denied; an over-length name or a bad email is refused by the function (`23514`)
- [ ] SQL: `intake.prune_pilot_inquiries()` deletes a row dated 13 months ago, keeps one dated 11 months ago and returns `1`; the `pg_cron` job exists and calls it
- [ ] SQL: RLS is enabled on the table, and `000_guardrails.test.sql` still passes (the function pins `search_path`)

## Done evidence
`pnpm verify`; `pnpm db:test` (from CI if no local Docker); the failing run before the code exists; screenshots of the landing page and the form's success and error states from `next dev`; a staging check that `terraoi.app` shows the landing page and `company1-staging.terraoi.app` doesn't.

## Human steps (§20.8). Owner only; nothing goes into the repo or an agent chat
1. Cloudflare Turnstile site for `terraoi.app`. The site key goes into `wrangler.jsonc` vars; set `wrangler secret put TURNSTILE_SECRET`.
2. In Supabase staging, create `inquiry_writer_login` with a generated password, `IN ROLE inquiry_writer`.
3. Cloudflare Hyperdrive config using that user's connection string; bind it in `wrangler.jsonc`.
4. `wrangler secret put INQUIRY_IP_HMAC_KEY` (32 random bytes).
5. Approve the privacy notice text on `/privacy` (what's stored, why, 12-month deletion, how to request deletion).

## Out of scope
Email alerts for new inquiries; an admin page for reading or triaging inquiries; analytics or tracking scripts; production rollout (staging until M1-PILOT); tenant sign-in (T-131 and Lane 1's T-102/T-201/T-204).
