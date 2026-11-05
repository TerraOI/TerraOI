## Task
Packet: `docs/tasks/T-xxx-….md`  ·  Lane: 1 / 2 / shared  ·  Protected paths touched: yes / no
Provisional on: none   <!-- or #<question issue>; also add the `provisional` label (COORDINATION.md §6) -->

## What changed and why
<!-- 2–5 sentences. Link plan sections (§…) and functions (F…). -->

## Evidence
<!-- Paste real output. "Tests pass" without output is not evidence. -->
```
pnpm verify
…
pnpm db:test   # if SQL changed
…
```
Staging check (if relevant):

## Self-review (AGENTS.md §4–6, plan §20.4)
- [ ] Only files in my packet's "Owns" list (or shared) changed; `cross-lane` label + reason if both lanes
- [ ] Acceptance tests were written first; removing the key guard makes a test fail
- [ ] Types come from `src/contracts/`; contract changes have an ADR
- [ ] Tenant comes only from `TenantContext`; no org/tenant id from body, header, model or client
- [ ] New tables: RLS enabled + policies + negative tests (other tenant, other project, deactivated member)
- [ ] Model calls only via the gateway; data class propagates to derived rows
- [ ] No secrets, `.env`, keys or real client data in the diff
- [ ] Errors are safe (no hidden-record or provider leakage); retries are idempotent
- [ ] New dependencies listed below with reasons

## New dependencies
<!-- name@version — why -->

## Out of scope / follow-ups
