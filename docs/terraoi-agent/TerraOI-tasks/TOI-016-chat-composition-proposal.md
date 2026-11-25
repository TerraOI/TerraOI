# TOI-016 Proposal: production chat composition root (BLOCKED — needs a supervisor-assigned packet)

Source: plan §15.1 TOI-05 exit evidence ("end-to-end employee question returns audited verified evidence/refusal"), §20.3 week-1 demo target, T-104 `adapters.ts` header (three recorded absences). Backlog Q-11.

## Why it is the largest remaining M1 gap
On `terraoi/build` every piece a chat turn needs exists and is tested — scoped persistence (T-104), hybrid search client + exact lookup + condensation (T-114/T-216), expert registry + `list_authorized_experts_v1` (T-311), gateway with clearance, chains, circuits, verifier pass 1/2 and five adapters (T-115/T-215/T-314), budget meter over BUDGET_DB (T-313), run audit (T-313) — but `src/platform/chat/adapters.ts` still wires `NOT_WIRED_CATALOG`, `NOT_WIRED_SEARCH` and a `null` gateway bundle, so **production refuses every question at the expert gate**.

## Why the agent did not build it
Each missing seam is a protected-path decision, not wiring:
1. **Expert definitions on the server path.** `model_chains` are deliberately withheld from members (#143 B8, #221 N1), so the Worker cannot read them with the user's token; a `gateway_config` read for `toi_gateway_config` over CONFIG_DB is a new privileged RPC (schema + grant decision).
2. **Gateway configuration source.** No server-path read of `model_providers`/`provider_routes`/`tenant_provider_policy` exists (`tenant_provider_policy_v1` is revoked from all roles per #143 B5). Same CONFIG_DB decision.
3. **Provider adapters from secrets.** Binding names for the local box (URL + Access token), Workers AI (`AI`), Claude, DeepSeek, OpenRouter, and their `wrangler.jsonc` entries — `wrangler.jsonc` is CODEOWNERS-protected and secrets are §20.8 owner steps.
4. **Query embedding route.** Hybrid search needs a query vector through the gateway under E1/E2 (Company1 approval pending, §12.4); lexical-only is the labelled fallback.

## Proposed packet (for the supervisor to assign; one Lane 2 owner)
- PR-a (SQL, protected): `gateway_config.load_gateway_configuration_v1()` and `gateway_config.load_expert_release_v1(p_org, p_expert_key)` for `toi_gateway_config`, no table grants; pgTAP slot.
- PR-b (gateway, protected): `createProductionGatewayBundle(env)` — config from CONFIG_DB, adapters from named secret bindings (absent binding → adapter absent, never a fallback), `CircuitBook`, `createProductionMeterPort(env)`.
- PR-c (chat): replace the three `NOT_WIRED_*` defaults with the registry-backed catalog (user token for grants, CONFIG_DB for the definition), `createSearchCorpusClient` + `planCorpusQuery` (lexical-only until an embedding route is approved), and PR-b's bundle; expert picker on `/chat` from the same catalog (closes T-203's picker, TOI-007).
- Unblock: supervisor rulings on 1-3, owner secrets (Q-06), Company1 E1/E2 (§12.4).
