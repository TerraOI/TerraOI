# T-002 Core runtime contracts

Lane: shared · Week: 0 · Protected: yes · Depends on: T-000 · Status: ready
Plan refs: §4.1, §5.2, §6.2, §9.2, §9.3, §12.1, §12.4, §7.6; F01, F07, F20–F23, F31, F33

## Goal
Zod schemas in `src/contracts/` that both lanes build against, so their work meets at typed interfaces instead of shared files.

## Owns
`src/contracts/*.ts` (+ tests), `docs/contracts/`, ADR `docs/decisions/0001-core-contracts.md`

## Contract (to define)
`TenantContext` (immutable; org, host, user, membership, roles, permitted services/projects, policy revision) ·
`DataClass` enum (`public` | `internal` | `client_confidential` | `restricted`) with a `maxDataClass()` helper ·
`ExpertDefinition` (plan §5.2 incl. v1.3 fields) · `ChatRequest` (logical, §9.2) · `ProgressEvent` (routing | searching | reading_records | verifying | tier_changed) ·
`Answer` (§12.1) · `ProviderRoute` / `ClearanceMatrix` (§12.4) · `IngestionJobPayload` · `FormTemplate`

## Acceptance tests (write first)
- [ ] each schema parses a valid example and rejects unknown keys
- [ ] `maxDataClass` returns the highest class; a derived object can never be lower than any input
- [ ] `ChatRequest` has no organisation/tenant field (test asserts the key is rejected)
- [ ] `Answer` rejects a claim without evidence unless type is `inference` with a limitation

## Out of scope
Implementations of any function; database schema (T-003).
