# T-105 Outbound email transport

Lane: 1 · Week: 2 · Protected: no · Depends on: T-002, T-101 (must be merged before claiming)
Status: in progress (wyuinline)
Plan refs: §4.1 step 6, §4.2, §5.1, §16 white-label email row, §20.5, §20.8; decision [#64](https://github.com/TerraOI/TerraOI/issues/64)

## Goal
The app can send a transactional email (magic link, invite, password reset, knowledge notification) through one port in `src/platform/notifications/`, from one verified TerraOI sending domain, with the tenant's display name as the sender name. Links in the email are built by the tenant host resolver, never from a global site URL. When the transport is not configured, callers get a typed `unavailable` result and never a fake "email sent".

## Owns (may edit)
- `src/platform/notifications/` (new files: the email port, one provider adapter, an in-memory fake for tests)
- `docs/tasks/T-105-email-transport.md` (status line only)

## Must not edit
- `src/platform/identity/` (T-102 and T-201 call the port; they wire it in their own PRs)
- `src/contracts/` (if a shared `EmailMessage` type is needed, request it with `needs-contract` and an ADR)
- `src/components/` email templates (T-204 owns them)
- `wrangler.jsonc` and secrets (human step, T-004)

## Contract
- `sendEmail(message, transport) → { status: "sent", providerMessageId } | { status: "unavailable" } | { status: "rejected", reason }`, where `reason` is a safe code with no provider text.
- `message` carries `to`, `subject`, `text`, optional `html`, `senderDisplayName`, optional `replyTo`. The From address is fixed by configuration and never taken from the caller or the tenant.
- The provider credential is read per call from a Worker secret (pattern: the gateway's Workers AI token, `4dd0501`), never at module load and never logged.
- The provider choice is recorded in this PR's description, with the reason and the dependency it adds (AGENTS.md §6).

## Acceptance tests (write first)
- [ ] positive: a well-formed message goes to the fake transport with the configured From address and the tenant display name
- [ ] negative: a caller-supplied From address or a sender domain other than the configured one is refused
- [ ] negative: a link whose host is not the resolved tenant host (another tenant, a `workers.dev` alias, the apex) is refused before sending
- [ ] negative: header injection (CR/LF in subject, display name or recipient) is refused
- [ ] failure: missing credential → `unavailable`, and no network call is made
- [ ] failure: provider 5xx or timeout → `unavailable`; provider 4xx → `rejected` with a safe code; neither leaks provider text or the credential
- [ ] the credential never appears in a thrown error, a log line or a returned value

## Done evidence
`pnpm verify` output. Staging check once T-004's email steps are done: one magic-link email for a synthetic address on `company1-staging.terraoi.app`, showing the From, display name and link host (headers only, no secrets).

## Out of scope
- Per-tenant sending domains and custom DKIM (post-M1)
- Template content and branding (T-204)
- Wiring into sign-in (T-102), invites and resets (T-201)
