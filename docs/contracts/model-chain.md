# Model chain, clearance and pinned embeddings

Schemas: [`provider-route.ts`](../../src/contracts/provider-route.ts),
[`expert-definition.ts`](../../src/contracts/expert-definition.ts) ·
Plan §12.3–§12.4, §5.2 · Functions F19–F22, F31, F37, F38 · ADRs TOI-ADR-12/13

## Shape vs behavior

This PR fixes the **shape** of chain configuration and the pure clearance arithmetic. Provider
selection, health, circuits and retries (F31, F37, F38) are implemented in
`src/platform/gateway/` (T-115, T-215, T-314). The gateway is the only place a provider SDK is
called (AGENTS.md §4.3).

`DEFAULT_PLATFORM_CHAIN` is the cost order of TOI-ADR-12:
`local_box → workers_ai → claude → deepseek → openrouter`. Real model names, capability tiers and
cost ranks are rows in `model_providers` (`PlatformProvider`), not code constants, so an expert
release can change them without a code change — and never past the data policy.

## Per-task chain orders (plan §12.4 "Per-task chains")

One flat cost list is not the rule: §12.4 gives each task class its own default order, so
`DEFAULT_TASK_CHAIN_ORDER` holds four of them, and `ExpertDefinition` checks **each chain against
its own task's order** (issue #16 N1 — the helper used to exist without being called, so
`compose: ["openrouter", "local_box"]` parsed):

| Task | Default order |
|---|---|
| `route`, `condense` | `local_box → workers_ai → deepseek → openrouter` |
| `compose` | the full cost order |
| `verify` | `local_box → claude → workers_ai → deepseek → openrouter` |

An expert may drop entries (and in M1 starts `verify` at Claude, per issue #9, until an F35
evaluation shows a local-box model is a different and adequate verifier) but may not reorder what
is left. Providers the plan marks "public only" for a task stay in the order — the data class is
enforced by the clearance matrix at call time, so the order does not double as a policy list.
Requirement (e) of chain walking ("the verifier is not the composer") stays the gateway's job.

## Default clearance (plan §12.4)

| Data class | local_box | workers_ai | claude | deepseek | openrouter |
|---|---|---|---|---|---|
| `public` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `internal` | ✓ | ✓ | ✓ | – | – |
| `client_confidential` | ✓ | tenant decision | ✓ | – | – |
| `restricted` | ✓ | – | – | – | – |

`PLATFORM_DEFAULT_CLEARANCE` encodes exactly that. `narrowClearance(tenantPolicy)` **only
intersects**: a tenant list may remove providers and keeps the platform cost order in the result;
a tenant entry the platform does not allow is dropped rather than merged; an omitted class keeps
the platform default. There is deliberately no widening parameter — widening needs a recorded
tenant decision and a provider-terms review (§12.4), which is a supervisor decision
([COORDINATION.md §6](../COORDINATION.md)). Unknown class keys throw rather than being ignored.

**Where the `platform` argument comes from (issue #16 N4).** `narrowClearance`'s second parameter
exists so the gateway can pass the tenant's own reviewed platform baseline (staging differs from
production); it is not a widening hook. That matrix is **reviewed configuration**: it is assembled
in `src/platform/gateway/` from the `model_providers` and clearance rows a human recorded, and the
supervisor's review of that configuration is what makes it authoritative (AGENTS.md §4.3). No code
in this repository may build it from a request, a model output, a tenant-editable setting or an
application default. Every widening — E1, Workers AI embedding `client_confidential` (issue #6),
is the standing example — lands as an ADR or a recorded tenant decision **before** it appears in
that argument, and the gateway writes the matrix revision it used into the run audit (F40).

Chain helpers: `chainFollowsPlatformOrder(chain, platformOrder)` is the §5.2 rule that an expert
may shorten its chain but never reorder it — pass `DEFAULT_TASK_CHAIN_ORDER[task]`, not the flat
cost order; `isIngestibleInM1` is §12.4's "restricted content is not ingested in M1 at all", used
by ingestion payloads and form templates.

## Pinned embeddings

`EmbeddingIndex` names one provider, model, dimension, metric and generation, with a `status` of
`building | active | retired` and no fallback field. Vectors from different models are
incomparable, so:

- outage → ingestion waits and queries take the labeled `lexical_only` lane (§8.1);
- model change → a shadow generation is built, evaluated, then the pointer switches atomically
  (§8.3) — never a runtime fallback;
- embedding sends full chunk text, so `clearedFor` must cover every class in the index.
  **E1 is decided for every tenant** (#6, [ADR-0007](../decisions/0007-e1-embedding-clearance.md)):
  each Workers AI index is `cleared_for = {public, internal, client_confidential}`. This is
  embedding clearance only; the chat matrix above is unchanged.

## Cost control (F19)

Every billable phase reserves against the tenant budget before the call, per chain attempt, and
an ambiguous timeout counts as potentially billed (§12.3). Free tiers (local box, Workers AI
allowance) are metered in units so exhaustion is predicted rather than discovered by a 429.
Reservations, actual usage and which tier answered go to the run audit — never into `Answer`.
