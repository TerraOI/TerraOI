# ADR-0003 The session and the identity carrier (#37, T-102)

Status: proposed (awaiting supervisor approval — protected path, and this ADR records a supervisor decision rather than making one) · Date: 2026-11-06 · Amended: 2026-11-12 (#75) · Deciders: supervisor ([#37](https://github.com/TerraOI/TerraOI/issues/37), comment `6693315053`, 2026-11-06T19:17:09Z; [#75](https://github.com/TerraOI/TerraOI/issues/75), 2026-11-08T23:16:53Z); Lane 1 authored
Plan refs: §4.1 (host resolution), §4.2 (authn, cookies, CSRF, cross-host replay), §4.3 (RLS and scoped access), §6.1 (identity/access), §20.8 (human steps); F02, F05; TOI-ADR-15
Depends on: ADR-0001 (contracts), ADR-0002 (the unexposed-schema + least-privilege-login precedent)
Amendment: [#75](https://github.com/TerraOI/TerraOI/issues/75) — **how the Worker reaches the session row** (answered: Hyperdrive + `toi_session_worker`; see §3a)

## Context

T-102 must put a sign-in cookie on a tenant origin, and every RLS-protected write in M1 needs a verified
identity that reaches Postgres. Those two questions are coupled — the reason a self-signed cookie is cheap
is precisely that nothing has to be stored — and the two lanes had hardened in different directions. The
supervisor decided ([#37](https://github.com/TerraOI/TerraOI/issues/37)): **option (b), "the verified user's
own Supabase token stays on the server, behind an opaque session."**

What that decision changes, in the supervisor's words: *"T-102b (#50): `session.ts` moves from the
self-contained signed record to an opaque ID plus a session store. The signed-token envelope from #30 stays
for CSRF and login state."* And it imposes one condition that is not negotiable: *"Supabase tokens are
**never sent to the browser** … `register_source_version_v1` trusts the hash and size the Worker passes
after verifying the bytes; a browser holding a user token could call it directly and skip that check."*

This ADR records the decision and the rules that follow from it — lifetime, revocation, token refresh and
rotation, the encryption key and its lifetime — so the next agent does not have to re-read a 6 KB issue to
know why a cookie holds 43 meaningless characters.

## Decision

### 1. The cookie

`__Host-toi_session`, value = **an opaque random id**: 32 bytes from `crypto.getRandomValues`, base64url
unpadded (43 characters). It carries **no claims** — no `sub`, no host, no expiry, no tenant, nothing that
means anything on its own. Cookie rules are unchanged from T-102a and stay fail-closed: no `Domain=` ever
(structural: `CookieSpec` has no `domain` field), `__Host-` requires `Secure` and `Path=/`, `SameSite=None`
is refused, and dropping the prefix is bound to `isDevelopmentRuntime()`, never to a caller's argument
(PR #18 N1). Lifetime 8 hours, matching the row.

The `signed-token.ts` envelope from #30 stays, and is used only for the **CSRF token** and the **login
state** (which also carries the PKCE `code_verifier`). A session can never be replayed as either, or the
reverse: each artifact carries a `typ` claim and the session value is not a signed token at all.

### 2. The row

`toi_identity.sessions` (`supabase/migrations/20261107024000_session_store.sql`), keyed by
**`base64url(SHA-256("terraoi:session-key:v1:" || id))`** — never by the id. Columns:

| | |
|---|---|
| `user_id` | the identity the provider verified; FK to `auth.users`, `on delete cascade` |
| `host` | the host it was **issued on**, normalized exactly as `tenant_domains.host` and `NormalizedHost` |
| `created_at` / `expires_at` (8 h) / `revoked_at` | lifetime and revocation, all timestamps |
| `key_version` | which keyring version sealed the pair |
| `access_token_ciphertext` / `refresh_token_ciphertext` | the user's Supabase pair, **encrypted at rest** |
| `token_expires_at` | the access token's own expiry, which drives the refresh rule |

The ciphertext columns carry a CHECK on the envelope shape (`<version>.<12-byte IV>.<GCM ciphertext>`), so a
plaintext Supabase JWT cannot be written into the table at all — "encrypted at rest" is a column rule, not a
review comment. pgTAP proves it, including the teeth: drop the CHECK inside a savepoint and the JWT writes,
then roll back (`supabase/tests/database/014_identity_session.test.sql`, slot **014**: 040 is taken by the
merged knowledge-uploads suite and 050 by T-213; 014 sits with the identity block).

The three cases the decision named are enforced **in SQL**, not only in the Worker: `anon` and
`authenticated` cannot read the table (grants and runtime `42501`); a revoked session does not authenticate;
a session issued on company1 does not authenticate on company2. `authenticate_session_v1` puts revocation in
the same predicate as the key match, so a caller cannot "look the row up first" and forget it.

### 3. The schema is not exposed to the Data API

`toi_identity` is not in `[api] schemas` (`supabase/config.toml` lists `public` and `graphql_public` — the
same choice ADR-0002 made for `intake`), and the migration revokes `usage` and every privilege from `public`,
`anon`, `authenticated` **and `service_role`**, RLS is enabled with no policies, and each function is revoked
by name (a per-schema default privilege does not cover functions added later — the trap recorded for `intake`
in `20261105210000_intake_service_role.sql` and [#60](https://github.com/TerraOI/TerraOI/issues/60)).

### 3a. How the Worker reaches it (#75 amendment)

**Decided ([#75](https://github.com/TerraOI/TerraOI/issues/75), 2026-11-08):** Hyperdrive plus a
dedicated role, following the ADR-0002 precedent.

- **Connection:** Hyperdrive binding `SESSION_DB`. The Worker connects as a login user that is
  `IN ROLE toi_session_worker`.
- **Grants:** `USAGE` on schema `toi_identity`, plus `EXECUTE` on the five `toi_identity.*_session_v1`
  functions only. **No table grants.** The role has no privilege on `public` or any tenant table.
- **Threat model:** a leaked `SESSION_DB` credential can authenticate, revoke and rotate sessions,
  but cannot read tenant data. Token material stays encrypted with the separate `SESSION_TOKEN_KEY`
  Worker secret, so the database credential alone cannot recover tokens.
- **Code:** `src/platform/identity/session-db.ts` implements `SessionStore` over that binding;
  `buildIdentityPorts` returns `null` from `sessionStore()` when `SESSION_DB` is unbound (honest
  unavailable), never a self-contained cookie.
- **Human steps (§20.8), owner:** create the login user `IN ROLE toi_session_worker` and its
  password, the Hyperdrive config, the `wrangler.jsonc` `SESSION_DB` binding under `env.staging`,
  and the `SESSION_TOKEN_KEY` secret. Recorded on [T-004](../tasks/T-004-infrastructure.md).

### 4. Revocation and sign-out

`POST /auth/sign-out` sets `revoked_at = now()` and clears the browser's cookies. A copied or restored cookie
authenticates nowhere from that instant — this is the property the self-signed cookie could not have, and it
is why the row exists. Revocation is host-scoped (a company1 cookie cannot revoke a company2 row) and
idempotent. If the store write fails the browser still gets its cookies cleared, but the server logs a fixed
`session_store` marker: an operator is never told a revocation happened that did not.

### 5. Token refresh and rotation

- The access token is used while live; inside a 60-second skew before `token_expires_at` the Worker refreshes
  it with the stored refresh token (`grant_type=refresh_token`, anon/publishable key only).
- Supabase rotates the refresh token on use, so the new pair **overwrites** the old one in the same row
  (`rotate_session_tokens_v1` updates only a row that is still live and returns whether it did). The session
  id, the row key and the cookie never change, so a live browser is not signed out by a rotation.
- A rotation that loses a race with a sign-out is reported as revoked and is not written back.
- The session's own lifetime is fixed at issue: refreshing tokens does **not** extend `expires_at`. 8 hours is
  the theft window; a longer stay means a new sign-in, not a sliding cookie.
- Retention: expired rows and rows revoked more than the grace interval ago are deleted by
  `prune_expired_sessions_v1`; wiring it to `pg_cron` is a §20.8 human step, mirroring
  `intake.prune_pilot_inquiries()`.

### 6. The encryption key: binding and lifetime

`SESSION_TOKEN_KEY` — a Worker secret (`wrangler secret put SESSION_TOKEN_KEY`), a **different** secret from
`IDENTITY_SESSION_KEY`, which signs the CSRF and login-state envelopes. One key doing both would make a bug in
either a total compromise. AES-256-GCM, key derived by HKDF-SHA-256 with the info string
`terraoi:session-token-cipher:v1:<version>` and the version as additional authenticated data: the derived key
is bound to this purpose, so the secret cannot double as an HMAC key, and a row cannot be reinterpreted under
another version. A fresh 12-byte IV per seal, so two rows holding the same token never look alike.

Lifetime and rotation: `SESSION_TOKEN_KEY` is rotated by binding the new value and moving the old one to
`SESSION_TOKEN_KEY_PREVIOUS`, which advances the keyring label `v1` → `v2`. Rows keep the label they were
sealed with, so old rows stay readable through the window; **unbinding the previous key makes those rows
undecryptable** — which is a feature: retiring a key is also a way to destroy the credentials it protected.
Suggested cadence: with the session lifetime (8 h), any rotation window longer than 24 h is unnecessary;
`rotate_session_tokens_v1` re-seals on every refresh, so a row's ciphertext ages at most as long as the
session. No key value may enter the repo, a log, a snapshot or an agent chat (AGENTS.md §4.6).

### 7. What the session is not

The session proves **who signed in on this host**. It is never a membership claim: every request re-resolves
the organization from the routed host and the current `organisation_memberships` row through T-101's
`resolveTenantContext`, so a removed or suspended member loses access on the next request however fresh the
cookie is, and `TenantContext` is still built only from server-side facts (AGENTS.md §4.1). Server-side calls
use the **user's own access token** against the Data API/PostgREST, so `auth.uid()`, RLS and the
`authenticated` grants behave exactly as written — Lane 2's capture RPCs in #32 are correct as built — and
there is **no service-role key in the Worker for this path**, and no `set local role` over a privileged
connection.

### 8. The hard condition, pinned by a test

No Set-Cookie value, no redirect target, no response body and no login-surface data contains a
Supabase-shaped JWT (`eyJ…`.`eyJ…`.`…`). In this PR that is pinned in two places. `session.ts`
issues a 32-byte opaque id and nothing else, and `src/platform/identity/session.test.ts` runs a
`eyJ….….…` pattern over the cookie value, its serialized `Set-Cookie` header, the stored row
(`JSON.stringify(row)`) and the rotation result — with the provider stub handing it real-shaped
tokens. The migration then makes a plaintext JWT **unwritable** in the token columns, and pgTAP
assertions 40–41 in the slot-014 suite prove that CHECK has teeth: drop it, and the same JWT writes
cleanly.

What is **not in this PR**: `http-response.ts`, which refuses to emit a JWT-shaped cookie value or
path so the rule is structural at the only sign-in response path, and
`src/platform/identity/browser-leak.test.ts`, which scans every byte of a *successful* sign-in plus
the view a tenant page would render. Both of those layers, and the "put the token in the cookie
value and 23 named tests fail across 6 files" property, belong to `t-102g-flow-and-routes` — the
flow-and-routes branch, which has no PR yet. Landing this migration without them is safe, because a
plaintext JWT cannot enter the table at all; that second layer is defence in depth for the HTTP
surface, and it arrives with that PR.

### 9. #38, the upload credential — the claim does not fully hold, so #38 must come back

The decision says: *"mint the signed upload URL **with the user's token** under a Storage rule limited to the
server-issued object key, so there's no service-role key there either,"* and asks this ADR to confirm it
against Supabase's Storage documentation. Checked on 2026-11-06:

- **What holds.** Uploads authorize through RLS on `storage.objects`, and *"the only RLS policy required for
  uploading objects is to grant the `INSERT` permission"*
  ([Storage Access Control](https://supabase.com/docs/guides/storage/security/access-control)). Policies can
  pin the bucket and the path with the helper functions `storage.foldername(name)`, `storage.filename(name)`
  and `storage.extension(name)` — the documented example is
  `for insert to authenticated with check ((storage.foldername(name))[1] = 'private')`
  ([Storage Helper Functions](https://supabase.com/docs/guides/storage/schema/helper-functions)). So a Storage
  rule **can** be limited to the object key the server issued, and an upload can be authorized by the user's
  own token: no service-role key is needed for that step.
- **What I could not confirm.** The signed-upload-URL half. The current Storage docs' Uploads section lists
  only Standard, Resumable (TUS) and S3 uploads
  ([Standard Uploads](https://supabase.com/docs/guides/storage/uploads/standard-uploads), updated 2026-11-05);
  the signed-upload guide URLs return 404 and the JavaScript reference page did not render for retrieval, so I
  cannot cite a current statement that a **user's** token may mint an upload token, nor that such a token is
  bound to exactly one path. Building on an unreadable page is exactly the hidden assumption AGENTS.md §7
  forbids.
- **Therefore: #38 comes back, as the decision allowed.** The question to answer there is narrower than the
  original: given that the Worker holds the user's access token (this ADR) and that a Storage INSERT policy
  restricted to a server-issued path is sufficient (verified above), which upload mechanism does TerraOI use —
  (i) the Worker proxies the bytes with the user's token, which also lets it verify size and hash before
  anything is stored (the property `register_source_version_v1` already assumes), (ii) a resumable/TUS upload
  authorized by policy, or (iii) a signed upload URL if the supervisor can cite the current contract for (a)
  and (b)? T-112's storage adapter stays unblocked on the RPC half (#32's RPCs are correct as built) and waits
  on this answer.

## Consequences

- T-102b/c/d are changed, not finished: `session.ts` is an opaque id plus a store port
  (`src/platform/identity/session.ts`, `session-store.ts`), the callback writes a row, sign-out revokes one,
  and the Supabase PKCE exchange now returns the token pair it used to discard.
-   **Sign-in needs `SESSION_DB` provisioned (T-004)** and the code says so when it is not:
  `issueSession()` throws when the session store or the token cipher is missing, and
  `buildLoginView` treats "no store wired" as "nobody is signed in" — both asserted, in
  `session.test.ts` and `login-view.test.ts`. `unresolvedSessionStore()` and
  `unresolvedTenancyStore()`, and the adapters that would install them, are on
  `t-102g-flow-and-routes` and are not part of this PR. Green unit suites here mean the guards are
  right, not that a user can sign in. The lead's daily sync should treat #75 as the critical path.
- Two Worker secrets instead of one (`IDENTITY_SESSION_KEY`, `SESSION_TOKEN_KEY`), both §20.8 human steps.
  More bindings to mint is the cost of storing credentials at all; the benefit is that a leaked signing key no
  longer yields user tokens.
- A leaked `toi_identity.sessions` table yields nothing directly replayable: cookie values are not in it, the
  keys are digests, and the pair is sealed under a secret that is not in the database. It is still a serious
  leak, which is why the retention prune and the key-retirement rule are part of the decision, not follow-ups.
- The 8-hour session and the per-request membership re-read together mean "revoked" has two meanings: revoked
  session (immediate) and revoked membership (next request). Both are needed and neither is a substitute.
-   pgTAP cannot run on the builder machines (no Docker), so CI's `database` job is the authority
  for the SQL in this ADR. The suite is written in the established 010/011/030 idiom and pins 44
  assertions, including a count of the `SECURITY DEFINER` functions so the `search_path` check
  cannot pass by there being none.

## Alternatives considered

- **(a) A privileged connection plus `set local role authenticated; set local request.jwt.claim.sub = …`.**
  Rejected by the supervisor: it puts a service-role key in the Worker (AGENTS.md §4.2 would need an ADR for
  it) and depends on the pooled-connection path that is still open in T-004.
- **(c) `SECURITY DEFINER` RPCs taking the user id as an argument.** Rejected: it changes SQL already in review
  in #32, and turns the user id into a caller-supplied value the function must prove it may act for.
- **The self-contained signed cookie (T-102's original design).** Rejected: no revocation before expiry, and no
  way to carry the user's token to Postgres without one of (a) or (c). It is the option this ADR supersedes.
- **Storing sessions in a Workers KV namespace.** Not chosen: the row's lifetime and revocation semantics are
  the point, and the credentials need the same at-rest protection wherever they live; nothing in the decision
  puts session state in KV, and inventing a second store here would be a new security surface.
- **Encrypting with the same key that signs the cookies.** Rejected outright (see §6): key reuse across signing
  and credential encryption makes one mistake total.
- **Hashing the session id with HMAC under `SESSION_TOKEN_KEY` instead of a plain SHA-256 digest.** Considered:
  marginally stronger against an attacker who has the table but not the secret. Not chosen, because the id is
  128-bit random (a dictionary attack is not available) and the tokens in the row are sealed regardless; this
  is a one-line change in `sessionStoreKey` if the supervisor prefers it, and the row key has a CHECK on its
  shape either way.

## Open questions

1. **#75** — **answered** (see §3a). Owner still owes the T-004 human steps (`SESSION_DB` login user,
   Hyperdrive config, binding, `SESSION_TOKEN_KEY`).
2. **#38** — the upload mechanism, narrowed as described in §9 (**answered** on the issue; wiring is a later packet).
3. Whether `#30`'s `hasUsableSecret` should be widened into a shared "deployment binding" helper now that two
   secrets follow the same fail-closed rule; left as a follow-up so this ADR does not touch a file under review.
4. Session concurrency: a user signing in on two devices gets two rows; nothing yet limits rows per user, and no
   admin-facing "sign out everywhere" exists. Out of scope for T-102, worth a packet.
