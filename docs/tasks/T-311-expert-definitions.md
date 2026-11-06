# T-311 UAV and GPR expert definitions v1, prompt registry, `routeExpert` (F29)

Lane: 2 · Week: 3 · Protected: yes (`supabase/migrations/`; `src/platform/gateway/` if chain config lands here) · Depends on: T-111 (merged), T-115 (a merged as #31; b/c/d open as #53/#56/#58), T-114 (unclaimed), T-104 (unclaimed), T-312 (same week: F36 publication needs a passing run) · Status: ready
Gated by decisions: [#6](https://github.com/TerraOI/TerraOI/issues/6) (pin decided; Company1's `client_confidential` embedding half open), [#45](https://github.com/TerraOI/TerraOI/issues/45) (provider configuration), [#41](https://github.com/TerraOI/TerraOI/issues/41) (`create_collection_v1`, which binds a collection to a service)
Plan refs: §5.2, §10.1 (M1 routing), §10.2, §10.3, §6.1 (Services + Prompt registry groups), §12.4 (per-task chains), §16 (Chat/Model chain rows); F29, F07 (F31/F36 boundary)

## Goal
The two pilot experts stop being configuration in somebody's head: a **UAV document expert** and a
**GPR knowledge expert** v1, each an immutable `ExpertDefinition` with its own chains, limits, refusal
templates and `minVerifierTier`, resolved from a **prompt registry** where bodies are versioned and
hashed rather than inlined, plus F29 `routeExpert` so Auto mode can suggest one expert with a
confidence — across only the experts this employee may use.

## Owns (may edit)
- `src/platform/agents/route-expert.ts` (F29), `src/platform/agents/registry.ts` (expert resolution and
  the immutable-version read used by every run), `src/platform/agents/*.test.ts`
- one migration `supabase/migrations/YYYYMMDDHHMMSS_experts_and_prompts.sql`: `prompt_templates`,
  `expert_definitions`, `tenant_services` and `tenant_experts` per plan §6.1, with the v1 rows for both
  experts and their prompt versions — timestamp agreed in the daily sync; merged migrations are never
  edited
- `supabase/tests/database/075_experts_and_prompts.test.sql`
- `src/platform/gateway/` **only** for the `route`-class chain wiring, and only if #45 assigns provider
  configuration to this packet

## Must not edit
`src/contracts/` — [`ExpertDefinition`](../../src/contracts/expert-definition.ts) and
[`ProgressEvent`](../../src/contracts/chat.ts) are merged and any change needs an ADR;
`src/platform/chat/` (Lane 1 renders the `routing` event, [T-203](./T-203-chat-ux.md));
`src/platform/retrieval/` beyond passing the scope it is given; merged migrations; no real prompt text
containing client data (§4.7).

## Contract
[`ExpertDefinition`](../../src/contracts/expert-definition.ts) as merged: `promptTemplateRef`
(id + version, never an inline body), per-task `modelChains` validated against
[`DEFAULT_TASK_CHAIN_ORDER`](../../src/contracts/provider-route.ts) for **that** task, `limits`,
`clarificationPolicy`, three `refusalTemplates`, `minVerifierTier`, and a pinned `embeddingIndexKey`.
`verify` starts at **Claude** (issue #9) and drop ≠ reorder. F29 returns one `expertKey` plus a
confidence into the `routing` progress event ([`chat.ts`](../../src/contracts/chat.ts)), and its
acceptance line is the rule: it cannot return an expert outside the list, below the threshold the UI
asks the employee, and the employee's explicit pick always wins (§10.1). The authorized list is
`TenantContext.permittedServiceKeys` ([`tenant-context.ts`](../../src/contracts/tenant-context.ts));
today that array is an **input** to `resolveTenantContext`
([`resolve-tenant-context.ts:33`](../../src/platform/tenancy/resolve-tenant-context.ts)) with no
registry behind it, which is what this packet's tables supply. Behavior rules:
[docs/contracts/model-chain.md](../../docs/contracts/model-chain.md).
**Assumed, decisions owed:** (1) §6.1's `service_definitions` / `expert_definitions` / `tenant_services`
/ `tenant_experts` have no owning packet — the same class of gap as
[#45](https://github.com/TerraOI/TerraOI/issues/45) and
[#41](https://github.com/TerraOI/TerraOI/issues/41); this packet assumes it creates them in one
migration and the supervisor confirms that scope. (2) `embeddingIndexKey` cannot name a real pin until
[#6](https://github.com/TerraOI/TerraOI/issues/6) is answered, so v1 rows carry the seeded candidate
generation and no client collection is bound past `public`. (3) `evaluationSetVersion` names a set that
only [T-312](./T-312-eval-harness.md) can score: **v1 is registered here, not published** — F36 refuses
publication without a passing run.

## Acceptance tests (write first)
- [ ] positive: `supabase/tests/database/075_experts_and_prompts.test.sql` — the two v1 definitions parse,
      each chain is a subsequence of its own task order, `verify` starts at Claude, and each prompt row
      stores a body hash, an owner and a status
- [ ] positive: `src/platform/agents/route-expert.test.ts` — with the authorized list from
      `TenantContext`, a UAV question suggests `uav-compliance` with a confidence and a GPR field-setup
      question suggests `gpr`; below the threshold the result is "ask the employee" and no retrieval ran
- [ ] positive: routing uses the `route` chain (no Claude in that order) and the run records which
      provider answered, or that keyword rules routed
- [ ] negative: `routeExpert` never returns an expert outside the list it was given — a forged
      `expertKey` is refused, and a service the tenant has not enabled is not even a candidate (no
      hidden-service enumeration, §8.1)
- [ ] negative: another tenant's `tenant_experts` row never resolves for this organization, and a
      suspended membership resolves no expert at all
- [ ] negative: an `ExpertDefinition` insert whose chain reorders its task's order, whose
      `minVerifierTier` is below what its `riskClass` allows, or whose `promptTemplateRef` points at a
      draft prompt is refused
- [ ] negative: a tenant override touches vocabulary and style only — it cannot widen collection
      bindings, lower clearance or change `minVerifierTier` (§5.2, §12.4)
- [ ] failure: no cleared, healthy `route` provider → keyword rules or an explicit question to the
      employee, never a silent guess; the run records the fallback
- [ ] failure: editing a published prompt is impossible (a new version or nothing); a run that names a
      withdrawn expert version is refused rather than quietly using the newest

## Done evidence
`pnpm verify`; `pnpm db:test` for the registry (CI `database` job here); staging: ask one UAV-worded and
one GPR-worded question in **Auto** and capture the two `routing` frames (expertKey + confidence), then
override the suggestion manually and show the employee's pick is what ran, and show the same expert list
on the company2 host suggests nothing.

## Out of scope
Publishing an expert version (F36, T-312's gate), the eval harness and case sets (T-312/T-315), Auto
running two experts or any cross-expert coordinator (§10.1, §15.0 deferred), read tools (`toolKeys`
stays empty in M1: TOI-07/TOI-10 deferred), drafts and actions (F25/F26), UAV operational truth and the
C0 domain gate (§10.2, §20.5 "Domain: none"), and the provider configuration tables (#45 decides).
