# Box-offline staging drill (T-314 / [#74](https://github.com/TerraOI/TerraOI/issues/74))

**Status of this runbook: prepared; the live stop-the-box half is `OWNER` and has not been executed from this PR.** Plan §20.3 week-3 note and §17.1 require the local box offline within one F37 check interval. Stopping owner hardware is never an agent action. Record the result as a row in the current week's [`docs/status/`](../status/) file when the owner runs it.

Automated proofs that do **not** need the real box live in `src/platform/gateway/box-offline-drill.test.ts` (and the F37 suite in `health.test.ts` / `call.test.ts`).

## What this drill proves

| # | Proof | Who / where |
|---|---|---|
| 1 | Box detected offline within one `checkIntervalMs` | Agent: scheduled F37 pass; Owner: staging clock |
| 2 | `client_confidential` advances to Claude; zero DeepSeek/OpenRouter calls | Agent tests + Owner staging probe |
| 3 | `restricted` returns `unavailable` (no cloud fall-through) | Agent tests + Owner staging probe |
| 4 | Scanned-PDF `extract` stays queued for OCR; never re-routed to a third-party OCR | Owner + T-211 job surface; see OCR half below |
| 5 | Result written in `docs/status/` | Owner (or agent after Owner paste) |

## Preconditions

- Staging Worker is deployable (today blocked while any `policy-violation` issue is open — see current status register).
- F37 scheduled health is wired (`runScheduledHealthChecks` + `checkIntervalMs` from gateway config).
- DeepSeek/OpenRouter adapters are present and still `maxClearedClass: public` (T-314 PR-1).
- Local-box health probe shape: [localbox/HEALTH.md](../../localbox/HEALTH.md).
- Owner can stop the box process **or** point the tunnel at nothing. Do not paste Access tokens or tunnel credentials into chat, PRs or this file (AGENTS.md §4.6).

## Procedure · `OWNER`

1. **Baseline (box up).** Note the current `checkIntervalMs` from staging gateway config (do not commit the value if it is environment-specific). Confirm one scheduled health observation for `local_box` reads healthy.
2. **Stop the box** (or break the tunnel). Timestamp `T_stop`.
3. **Wait at most one check interval.** At `T_stop + checkIntervalMs`, confirm F37 has marked `local_box` unhealthy / circuit path skips it — without a user-visible compose timeout waiting on the box.
4. **Compose probe A — `client_confidential`.** Ask a synthetic internal question as a Company1 member cleared for that class. Expect: answer (or progress) from Claude's chain position; audit / observation shows **zero** DeepSeek and OpenRouter attempts. Employee-visible text must not name a provider ([`TierChangeReason`](../../src/contracts/chat.ts)).
5. **Compose probe B — `restricted`.** Same path with a restricted payload. Expect: `unavailable` / no eligible provider; **zero** cloud provider calls.
6. **OCR half — scanned PDF.** With the box still down, ensure a `local_box` `extract` job for a scan stays waiting (queued for OCR wording on the knowledge surface once T-211 ships it). Confirm no re-route to a third-party OCR executor. The box client itself has no re-route path ([`localbox/ocr-pull.ts`](../../localbox/ocr-pull.ts)); the cloud must not invent one during this drill.
7. **Restore.** Bring the box or tunnel back. After cooldown **and** a successful health check, confirm the circuit closes and a `public` compose can use `local_box` again.
8. **Record.** Append one row to the current `docs/status/YYYY-Www.md` with: stop/restore timestamps, interval used, probe A/B outcomes (pass/fail), OCR wait confirmation, and the CI/unit suite that already covers the agent half (`pnpm exec vitest run src/platform/gateway/box-offline-drill.test.ts`).

## Agent half (no owner hardware)

```text
pnpm exec vitest run src/platform/gateway/box-offline-drill.test.ts
```

That suite pins proofs 1–3 against mocks. It does **not** substitute for the staging row in proof 5.

## OCR half (T-211 boundary)

T-314 may not edit `workers/` or `localbox/` **code**. The drill's OCR proof is therefore:

- **Contract:** a `local_box` extract job waits while the box is offline; it is never handed to a third-party OCR service (#74, #58 note).
- **Box client:** outbound poll only; no executor rewrite ([HEALTH.md](../../localbox/HEALTH.md) + `ocr-pull.ts` threat model).
- **Evidence on staging:** owner pastes the job id / stage / executor from the job API into the status row. Until T-211's queue surface is on the deployed Worker, mark the OCR cell `not_available` and name the missing PR — never invent a shadow status.

## What must never appear

- Provider or model names in employee-visible copy.
- Secrets, Access tokens, tunnel URLs with credentials, or real client document text in the status row or this runbook.
- A "temporary" clearance widen so `restricted` can reach the cloud while the box is down.
