# ADR-0001 Core runtime contracts (T-002)

Status: proposed (awaiting supervisor approval) · Date: 2026-11-04 · Deciders: Lane 1, Lane 2 (proposed); supervisor approves (protected path)
Plan refs: §4.1–§4.3, §5.2, §6.2, §7.2, §7.6, §9.2–§9.4, §10.1, §12.1, §12.3–§12.4, §20.2; F01–F05, F07, F17, F20–F23, F29–F31, F33

## Context

Two builders work in parallel and their agents share no memory (plan §20.1, §20.2). Their work
has to meet at typed interfaces instead of at shared files, and the security-relevant rules —
where the organization comes from, what may be streamed, which provider may see which class —
have to be impossible to express wrongly, not merely documented.

## Decision

Add one set of Zod schemas in [`src/contracts/`](../../src/contracts/), each with a test that
both accepts a documented example and rejects unknown keys:

1. **`TenantContext`** — server-built and **deep-frozen** by `createTenantContext`. Strict, so an
   organization/tenant/user/role/host field arriving from a client is a parse error rather than
   an ignored key. `membershipStatus` is the literal `"active"` only: a suspended tenant or
   removed member never produces a value of this type.
2. **`NormalizedHost`** in `keys.ts` — lowercase, bare, at most one subdomain level below the
   zone. Format hygiene only; recognition stays in the domain registry (F01).
3. **`DataClass` + `maxDataClass()`** — §6.2 propagation as a function, not a convention. It
   **throws on an empty dependency list**: treating "unknown" as `public` is the failure mode
   behind "client data reaches an uncleared provider" (§18.2).
4. **`ExpertDefinition`** — plan §5.2 including the v1.3 fields. Prompt bodies are referenced by
   id + version, never inlined; chains reject duplicates; `minVerifierTier` is mandatory, and an
   `operational`/`commercial` expert cannot set `small`.
5. **`ChatRequest`** — the logical §9.2 contract, no tenant/user field, bounded opaque ids, and
   a single user message object so a forged assistant/system turn cannot be posted as history.
6. **`ProgressEvent`** — discriminated union over the five §9.3 event types, no textual payload
   that could carry answer content, SQL, record ids or provider names; `tier_changed` carries
   chain positions plus a bounded note.
7. **`Answer` / `Claim` / `EvidenceRef`** — non-inference claims require evidence; an unevidenced
   `inference` requires a stated limitation; `answered` requires ≥1 claim; `unknowns` and
   `dataClass` are mandatory. Evidence rows are typed and contain no URL, so durable signed
   access is unrepresentable (F24 re-mints it).
8. **`PlatformProvider`, `TaskClass`, `CapabilityTier`, `ClearanceMatrix`,
   `PLATFORM_DEFAULT_CLEARANCE`, `narrowClearance()`** — §12.4 defaults plus **intersection-only**
   tenant narrowing. There is no widening parameter at all: widening is a recorded tenant
   decision, i.e. a supervisor decision.
9. **`chainFollowsPlatformOrder()`** — §5.2 "shorten, never reorder" as a pure helper the gateway
   (F31) and expert release (F36) call against the configured platform chain.
10. **`EmbeddingIndex`** — one pinned model/dimension/metric/generation per index, **no fallback
    field**, because incomparable vectors would silently corrupt retrieval (TOI-ADR-13).
11. **`IngestionJobPayload`** — strict, no object URLs or credentials; `executor: local_box` is
    legal only for `extract`; `restricted` cannot be enqueued in M1 (`isIngestibleInM1`).
12. **`FormTemplate` + `containsUnsafeFormContent()`** — whitelisted UI hints and a rejection of
    handler keys, `$ref`, script/style/html markers and remote/data URLs.

Chains, provider names, spend ceilings and embedding models stay **data** (`model_providers`,
`tenant_provider_policy`, `embedding_indexes`), per plan §6.1 and §12.4; the only values fixed
in code are the five platform provider keys and the §12.4 default matrix.

## Consequences

- Both lanes import these types; a schema change now needs this ADR's successors, which is the
  intended friction (AGENTS.md §6).
- Fail-closed choices will occasionally reject convenient-looking payloads (empty
  `maxDataClass`, a tenant listing an uncleared provider, a form field whose name is `script`).
  That is the point; each has a test naming the plan rule.
- Contract-level guards do not implement behavior: F31 selection, health/circuits, budgets,
  verification and RLS still need their packets (T-111, T-115, T-215, T-313).
- Open items in plan §18.3 (Company1's clearance-matrix approval, embedding E1/E2, spend ceilings,
  local-box models) remain configuration; nothing here pre-empts them.

## Alternatives considered

- **Shared TypeScript interfaces instead of Zod.** Rejected: no runtime boundary validation, so a
  forged or malformed body would only fail in production (plan §3.1 "Zod at boundaries").
- **Non-strict objects that ignore unknown keys.** Rejected: a client-supplied `organisationId`
  would then parse successfully and be silently dropped at one call site and honored at another.
- **Let tenants widen the clearance matrix with a flag.** Rejected: §12.4 makes widening a
  recorded decision; a parameter invites an agent to use it under schedule pressure (§18.2).
- **Hard-code per-task chains in the expert definitions.** Rejected: chains are provider-policy
  configuration and change without a release; experts may only shorten them.
- **One `contracts.ts` file.** Rejected: lane ownership, review size (≤ ~400 lines, §20.1) and
  `check:migrations`-style focused reviews all favor one file per contract group.
