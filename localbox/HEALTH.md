# Local-box health probe shape (T-314 notes)

T-314 may edit **notes only** under `localbox/` (packet Owns). The OCR pull client stays T-211's. This file documents the health-endpoint shape F37 probes so a scheduled check can mark the box offline within one `checkIntervalMs` without opening a user-visible call timeout.

## Probe contract

| Item | Rule |
|---|---|
| Who calls | Platform gateway F37 (`runScheduledHealthChecks`), outbound from the Worker toward the box (or a tunnel fronting it) |
| What the box exposes | A cheap health URL the owner configures on the gateway endpoint row — **not** committed here (§4.6: no credentials, no real tunnel host in the repo) |
| Success | HTTP 2xx within the probe timeout → `healthy: true` |
| Auth failure | Non-2xx / TLS / connect error / timeout → offline (`unhealthy`), same as a dead process |
| Secrets | Probe auth material lives in Worker secrets / `.dev.vars`, never in this tree |
| Employee copy | Health snapshots name providers for audit only; they never feed chat progress text |

## Relation to OCR

- Inference health (`local_box` as a **compose/verify** provider) is F37 + circuit state.
- OCR extract jobs use the job API poll path (`ocr-pull.ts`). An offline box simply stops leasing; jobs wait. There is **no** re-route from this client to a third-party OCR executor.

When the owner runs the week-3 drill, follow [docs/runbooks/box-offline-drill.md](../docs/runbooks/box-offline-drill.md).
