# TOI-013 Worker publish honours T-213's publication rule

Source: plan §7.2 steps 7-9 ("review → publish"), §15.0 In-M1 ingestion row, T-113 note ("skeleton auto-publish; T-213 owns review policy later"), T-213 `publish_knowledge_version_v1`. Status: **VERIFY** (supervisor review of protected paths owed: `supabase/migrations/`, `workers/`).

## Defect (cross-PR, invisible to each PR's CI)
With #219/#285 (T-113 worker publish) and #267 (T-213 review) both merged, `job_api.publish_version_v1` published every fully indexed version from `indexing` with no review decision, so the T-213 queue was bypassed — including `client_confidential` uploads whose collections require independent review.

## Fix
- `supabase/migrations/20261125120000_publish_respects_review.sql`: the original body is renamed `job_api.publish_version_core_v1` (executable by its owner only); a new `publish_version_v1` with the same signature applies T-213's rule (approve decision, or `auto_publish` + note + public|internal, or already published) and otherwise finishes the job under the same lease compare and parks the version in `awaiting_review` (outcome `awaiting_review`, no pointer move).
- `workers/job-db.ts` / `publish-pull.ts`: new `awaiting_review` outcome → `held_for_review` action (not an abort, not a publication).
- `036_chunk_publish.test.sql`: fixture versions get an approve decision so its publication-mechanics assertions keep testing what they were written for.

## Evidence
- pgTAP `049_publish_respects_review.test.sql` 14/14: unreviewed upload parked (state, pointer, job finished, replay idempotent); auto-publish note publishes; client_confidential parked; reviewer approve + employee publish works; approved version publishes via worker; core body unreachable.
- `workers/publish-review-gate.test.ts` 2/2; workers suite 112 pass. Full pgTAP see state.
