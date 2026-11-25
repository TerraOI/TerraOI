# TOI-017 Follow-ups after the final report (all proposals, none recorded as approvals)

The owner's "go ahead" followed a report whose first request was to push the bundle; it is **not** recorded as a ruling on any Q/R item. Everything below is an agent proposal on `terraoi/build`.

| Item | Change | Evidence |
|---|---|---|
| Q-10 citation open (proposal) | `20261125140000_citation_open.sql` (`cite_source_object_v1`, reader Storage policy, explicit-org read predicate), `src/platform/chat/citation.ts`, `src/app/api/evidence/[id]/route.ts`, "Open source" link in the evidence panel | pgTAP 038 (17; 5 Storage assertions todo on R-4), `citation.test.ts` 7 (sandboxed headers, HTML never inline, no key/URL to the browser, one 404 for forged/revoked) |
| R-2 lease token (proposal) | `20261125150000_lease_token_column_privilege.sql` | pgTAP 110 #22 passes (todo removed) |
| R-3 evidence fence (hardening) | per-call random fence in `compose.ts` | `compose-fence.test.ts`; agents/gateway/chat suites pass |
| R-4 (new finding) | none (Lane 2 decision) | shim: 42501 on any authenticated `storage.objects` access |
| R-5 PostgREST base (bug fix) | `tenancy-data-api.ts`, `chatPostgrestBase` in `chat/adapters.ts`, routes/pages | identity loopback now asserts `/rest/v1/rpc/...` over a socket |
| TOI-016 chat composition | not started: still BLOCKED (rulings + secrets; `model_providers` has 0 rows) | - |
