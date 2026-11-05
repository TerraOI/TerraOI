# Contracts

Prose contracts that complement the executable schemas in [`src/contracts/`](../../src/contracts/).
The schemas are the authority for shape; these files record the rules a shape cannot express —
who builds a value, what must be re-checked before use, and which plan section owns the decision.

| File | Covers | Functions |
|---|---|---|
| [tenancy-and-context.md](tenancy-and-context.md) | `TenantContext`, host normalization, the scoped-RPC and RLS predicate | F01–F05, F28 |
| [chat-protocol.md](chat-protocol.md) | Chat request, progress events, idempotency, verified-only delivery | F17, F21–F24, F29 |
| [model-chain.md](model-chain.md) | Cost-ordered chain, data-class clearance, pinned embeddings | F19–F22, F31, F37, F38 |
| [knowledge-and-jobs.md](knowledge-and-jobs.md) | Source lifecycle states, job payloads, parse leases, form templates | F08–F16, F32, F33 |

Rules of use (plan §20.1, [COORDINATION.md §2–§3](../COORDINATION.md)):

1. A contract change is an ADR PR in [`docs/decisions/`](../decisions/) **plus** the schema
   change, approved by the supervisor. One contract change per PR.
2. The other lane asks for a change through a `needs-contract` issue; nobody edits files outside
   their lane to unblock themselves.
3. Anything here marked **proposed** becomes binding only when the schema and its tests merge.
