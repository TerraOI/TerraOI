# ADR-0002 Pilot inquiry intake on terraoi.app (T-130)

Status: proposed (awaiting supervisor approval) · Date: 2026-11-05 · Deciders: supervisor (chose storage and the least-privilege role in the T-130 design review), Lane 1
Plan refs: §4.1 step 3, §4.3, §6.2, §20.8; TOI-ADR-15

## Context

The public landing page at `terraoi.app` needs a way for prospective companies to ask about a pilot. It is the only form on the platform that anyone on the internet can submit without an account. That makes it the easiest place to:

- spam the platform;
- reach the database anonymously;
- leak data, either personal data about the people asking or a privileged key from the public web Worker.

The tenant tables are protected by RLS on `public`. Nothing on this path may weaken that.

## Decision

1. **Store inquiries in the database instead of emailing them.** They go into `intake.pilot_inquiries`, and the supervisor reads them in the Supabase dashboard during M1. There's no admin UI yet.
2. **There is no anonymous database path.**
   - The `intake` schema is not in the Supabase API's exposed schemas (`supabase/config.toml` `[api] schemas = ["public", "graphql_public"]`, pinned by `src/platform/site/supabase-config.test.ts`).
   - `public`, `anon` and `authenticated` get no privileges on the schema, the table or the functions. RLS is on, with no policies.
3. **A least-privilege writer reaches the database over Hyperdrive.**
   - The web Worker connects through the `INQUIRY_DB` Hyperdrive binding as a login user that is `IN ROLE inquiry_writer`.
   - `inquiry_writer` is `NOLOGIN`. Its only grants are `usage` on `intake` and `execute` on `intake.submit_pilot_inquiry_v1`, which is an insert-only `SECURITY DEFINER` function with `search_path = intake, pg_temp`.
   - The table's CHECK constraints repeat every field rule from the Zod schema, so a malformed row is refused (`23514`) even if the application layer is bypassed.
4. **The IP is stored only as an HMAC.** The rate-limit key and the stored `ip_hash` are HMAC-SHA256(`INQUIRY_IP_HMAC_KEY`, `CF-Connecting-IP`). The raw IP is never stored, logged or sent to the database.
5. **Abuse controls run before any database call:** Turnstile `siteverify`, then the Workers rate-limit binding `INQUIRY_RATE_LIMITER` (3 requests per 60 s per IP hash), plus an 8 KB body cap, a strict schema and an exact `Origin` check.
6. **Retention is 12 months.** `intake.prune_pilot_inquiries()` (owner only) deletes older rows, and `pg_cron` runs it daily at 03:17 UTC.

## Consequences

- A leaked Hyperdrive credential can insert inquiries, within the CHECK limits, and do nothing else. It can't read inquiries or touch any tenant table.
- **Human steps are required before the form works** (T-130 packet, §20.8). None of these goes into the repo or an agent chat.
  1. Create the Turnstile site, and set the site key and the `TURNSTILE_SECRET` secret.
  2. Create `inquiry_writer_login` in Supabase with a generated password.
  3. Create the Hyperdrive config and bind it as `INQUIRY_DB`.
  4. Set the `INQUIRY_IP_HMAC_KEY` secret.
  5. Approve the privacy notice text.

  Until then the API returns the generic 503 and the page still renders.
- **The hosted project's API settings must match the config file.** The repo test only covers `supabase/config.toml`, so the supervisor checks in the dashboard that `intake` is not an exposed schema.
- Rotating `INQUIRY_IP_HMAC_KEY` makes earlier hashes unlinkable to later ones. That's acceptable, because the hashes are only used for abuse limits.
- New write paths into `intake` must go through new `*_v2` functions with the same pattern, never through table grants.

## Alternatives considered

- **Email each inquiry** (rejected). It puts personal data into mailboxes with no retention control. It also needs an email provider key in the public Worker, and the inquiries aren't queryable.
- **Use the service-role key from the Worker** (rejected). It bypasses RLS on every tenant table, and it would sit in the most exposed component on the platform. One leak would expose every tenant.
- **Anonymous RPC through the Supabase API (`anon` + `security definer` in `public`)** (rejected). It needs no new infrastructure, but it opens an anonymous database path whose only throttles are in front of the API, not on this endpoint. It also places intake objects in `public`, next to tenant data.
- **A third-party form service** (rejected). It sends prospect data to another processor and doesn't fit the cleared-provider policy.
