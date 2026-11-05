# TerraOI — Project Plan v1.1

**Updated:** 2026-11-04 · **Status:** revised delivery plan; implementation not re-verified  
**Project:** UAV/RPAS operations and compliance records for Inline Group, with a later GPR expansion  
**Application repository reported by v1:** `https://github.com/Wei-Inline/IGI-UAV.git`  
**Previous version:** [TerraOI-plan-v1.md](TerraOI-plan-v1.md)

## 0. Read this first

The first release increment is **reliable UAV records plus one read-only assistance workflow for a limited pilot group**. Complete the record corrections, database security verification, and operational safeguards before enabling assistance. Drafts, GPR operations, and cross-domain answers follow separate release gates.

This revision turns the v1 review into an execution plan. It preserves the existing architecture direction and task identifiers while tightening sequencing, permissions, staging, acceptance criteria, and ownership. Requirements introduced here describe work to do; they do not indicate that code, infrastructure, or tests have changed.

**Evidence boundary:** this workspace contains the v1 plan and brand assets, but no application source, migration directory, package manifest, CI logs, or supporting design documents. The original repository audit, regulatory statements, dependency versions, costs, and platform limits are inherited reports. They have not been independently verified for v1.1.

**Document authority:** use this file for the revised release gates and immediate execution order. Use v1 for historical architecture detail and reported findings. In the application repository, reconcile this revision with `proj-plan.md` and record changes to its decision log before implementation; this file does not silently rewrite unavailable documents. Applied SQL and deployed configuration must be inspected to establish actual state.

### What changed from v1

| Review finding | v1.1 change |
|---|---|
| Immediate priorities omit C0 and bury credential exposure | Credential containment first; explicit record-truth and citation gate |
| Unit tests do not verify the database security model | Database integration and browser checks become release gates |
| Preview can connect to production | Isolated staging, migration rehearsal, restore evidence, separate recovery paths |
| Tenant membership alone does not protect restricted corpus data | Source permissions apply to chunks, tools, queues, history, and audit views |
| Citation binding and semantic correctness are conflated | Separate deterministic validation, semantic verification, and evaluation measures |
| Search and queue contracts are incomplete | Explicit embedding inputs, error states, queue identity and reauthorization contracts |
| Fallback and budget behavior are underspecified | Provider data rules and atomic budget reservations before calls |
| First release includes too many programs | One UAV workflow first; later gates for drafts and GPR |
| Architecture and changing status are mixed | Short execution plan here; historical detail remains in v1; evidence register required |

## 1. Product scope and architecture

**Purpose:** maintain an operational record for aircraft, pilots, credentials and recency, company authorizations, type competencies, maintenance, flight requests and logs, safety events, and evidence reports. The portal records compliance evidence; a named human remains responsible for operational decisions.

**Architecture direction retained from v1:** Next.js App Router, TypeScript, Supabase Postgres/RLS/Auth/Storage, Tailwind and the existing component system. The target compute platform remains Cloudflare Workers through OpenNext, subject to measured compatibility and cutover acceptance. Retrieval remains in Postgres using pgvector and full-text search. Exact versions and provider capabilities must be checked against the actual repository and official documentation before implementation.

**Invariants:**

- Operational readiness is determined by the existing deterministic gate, not an AI answer. Show its verdict beside assistance whenever the question concerns readiness.
- Server actions and database policies enforce permissions. UI visibility is presentation.
- Ordinary application requests use the caller's session and RLS. Service-role exceptions require explicit authorization checks, tenant scoping, and tests.
- Cross-tenant references are rejected by database constraints as well as policies.
- The assistant may create an isolated draft proposal in a later release; only a human can submit it through existing operational actions, which re-check permissions and separation of duties.
- Changes to applied migrations use new migrations. Regenerate database types and prove schema compatibility.
- Private tenant documents retain their source access rules throughout the AI pipeline.
- Treat retrieved documents as untrusted data. They cannot grant tools, change permissions, or override instructions.

## 2. Evidence and current-state register

Use four evidence labels: **Observed** = inspected directly with a date and artifact; **Reported** = inherited from another source; **Planned** = required work; **Unverified** = evidence missing or conflicting. A reported successful check does not satisfy a current release gate.

| Item | Evidence available for v1.1 | Required next evidence |
|---|---|---|
| Workspace contents | Observed: v1 plan and brand assets present; application source absent | Locate the application checkout and confirm its remote |
| Branch `cloudflare-prep`, commit `8d03f98`, 77 dirty entries | Reported by v1 | Fresh branch/commit/status record; securely preserve uncommitted work |
| 54 migrations, four pending on hosted database | Reported by v1 | Local migration inventory and hosted migration history |
| 694 unit tests, lint and app typecheck green | Reported by v1 as run 2026-11-04 | CI logs against the release commit |
| Production build green | Reported indirectly by v1 from 2026-11-02 documentation | Fresh app and target-platform build logs |
| Database password exposed in an earlier chat | Reported by v1; containment not evidenced | Rotation and old-credential rejection evidence without secret values |
| C0, citation re-baseline, AI and GPR implementation | Reported incomplete by v1 | Code/schema inspection; do not infer completion from this revision |

Create an evidence record for each release with: commit SHA, environment, UTC timestamp, executor, command or scenario, result, and artifact link. Store no secrets, raw personal records, or reusable signed URLs in evidence.

## 3. Immediate sequence and ownership

Role names below are **proposed responsibilities, not confirmed assignments**. Assign named people before starting a release gate. One person may hold multiple roles where existing separation-of-duties rules allow it.

| Order | Work | Proposed accountable role | Completion evidence |
|---|---|---|---|
| 1 | P0-6: contain the reported database credential exposure | Platform/security owner — unassigned | Credential rotated, dependent connections updated, old credential rejected, relevant access logs reviewed |
| 2 | P0-1/P0-2: preserve and commit the application baseline, lockfile, and CI | Engineering lead — unassigned | Recovery copy of uncommitted work; reviewable commits; remote branch; CI result |
| 3 | Establish staging and rehearse P0-3/P0-4/P0-5 | Database/platform owner — unassigned | Isolated projects and secrets; migration replay; integration tests; generated-type drift check; restore rehearsal |
| 4 | Apply validated baseline changes through the release procedure | Release owner — unassigned | Backup checkpoint, migration history, app/schema compatibility and staging smoke checks |
| 5 | C0 and R-01/R-02, plus readiness-affecting regulatory corrections identified by review | Compliance owner + engineering lead — unassigned | Consistent record truth, reviewed source citations, deterministic gate regression tests |
| 6 | Build one retrieval-to-answer workflow behind tenant gating | AI/application owner — unassigned | Permission-aware retrieval, audit, budget, verifier and refusal tests |
| 7 | Run a limited UAV pilot and decide whether to expand | Product/operations owner — unassigned | Named pilot group, outcome measurements, issue review, release decision |

Document-only research and synthetic fixtures may proceed while prerequisites are being resolved. No additional production credentials or external model access should be enabled before credential containment and environment isolation are established. Corpus preparation may run alongside record corrections, but operator-facing assistance remains blocked until the record-truth gate passes.

## 4. Release gates

These `REL-*` identifiers describe release gates; they do not replace the existing track/task IDs. A gate passes only when its evidence is attached. Do not treat an unassigned owner, incomplete test, or undocumented exception as a pass.

| Gate | Scope and exit criteria | Blocks |
|---|---|---|
| REL-0 — secure baseline | Credential containment; recoverable code baseline; named owners; current repository inventory; CI enabled | New deployed AI capabilities and production migrations |
| REL-1 — safe database and staging | Isolated staging; all migrations replay; upgrade from a representative prior schema rehearsed; RLS/constraints/triggers tested; types match; backup/restore proven | Production database changes and platform cutover |
| REL-2 — reliable operational truth | C0 cutover complete; reminders, reports and readiness use consistent credential/recency sources; R-01/R-02 complete; readiness-affecting defects resolved or affected operations explicitly disabled; browser journeys pass | Operator-facing AI answers |
| REL-3 — read-only UAV pilot | One workflow; reviewed corpus; source permissions; audited tools; provider policy; atomic budgets; refusal/verification gates; pilot metrics and owner agreed | Broader assistance rollout |
| REL-4 — expansion decision | Pilot meets outcome targets; issues reviewed; measured cost/latency; operational support and rollback tested | Additional screens, tenants, providers and draft workflow |
| REL-5 — later capabilities | Separate release evidence for drafts, GPR records/QC/commercial permissions, and cross-domain answers | Each later capability's own rollout |

**Platform cutover is a separate release event.** It requires REL-0, REL-1, and platform-specific smoke, performance, authentication and recovery evidence. It need not wait for the AI pilot, and does not by itself prove readiness for that pilot. Avoid combining cutover with C0 or major corpus changes in one production release.

## 5. First pilot and product outcomes

**Proposed first workflow:** an authorized operator asks why a selected pilot/aircraft/operation is or is not ready. The screen shows the deterministic gate, the records used, verified supporting citations, missing information, and the existing human action needed. Assistance cannot approve a flight, alter records, or create operational facts.

Start with one tenant, a named small pilot group, and one entry point. Keep report drafting, autonomous actions, GPR operations, estimates, cross-domain orchestration, and optional extra provider tiers outside this pilot. Keep the gateway abstraction and separate verifier, but enable only the providers needed to satisfy the pilot's approved verification and availability contract.

The following are **proposed targets**, to be confirmed by the product/operations owner after baseline measurement:

| Measure | Baseline and measurement | Proposed pilot target |
|---|---|---|
| Time to understand a readiness refusal | At least 10 representative cases before assistance; repeat matched cases during pilot | Median time reduced by at least 25% without worsening decision accuracy |
| Evidence lookup time | Measure source/record lookup for the same cases | Median time reduced by at least 25% |
| Operational decision accuracy | Compliance owner labels expected outcomes before testing | No incorrect ready-to-fly outcome attributable to assistance in the evaluation/pilot review |
| Answer safety | Evaluate displayed claims and mandatory-refusal cases using §9 | Every safety gate passes; refusal is preferable to unsupported certainty |
| User usefulness | Named users rate completed cases and explain low scores | At least 80% rated useful; track refusal rate separately |
| Performance and cost | Record p50/p95 latency, retries, token usage and cost per completed/refused run | Owner-approved numeric latency and daily spend limits before enabling pilot |

Run the pilot for at least two weeks and collect at least 30 completed cases; extend it if the case mix is unrepresentative. These are evaluation samples, not proof that all possible answers are correct. Before launch, replace provisional targets with owner-approved values; do not infer approval from this plan.

## 6. Database, corpus and permission contracts

### 6.1 Database verification

CI must build a disposable database from migrations and exercise real policies, grants, triggers and constraints. Also rehearse upgrading a representative prior schema containing synthetic records, since an empty reset cannot expose all upgrade failures.

Required scenarios: two tenants; roles with full/read/own/none access; restricted personal and document data; inactive/deactivated accounts; platform admin without operational access; composite foreign-key rejection; direct RPC calls; scoped service-role paths; public-intake throttling under concurrency; append-only guards; and generated-type drift.

Apply validated production migrations only after the staging rehearsal and backup checkpoint. Use additive/backward-compatible changes where practical, and record when old code ceases to be compatible. C0 must switch readers and writers together under an explicit data mapping/reconciliation procedure; preserve source records until the reconciliation is signed off.

### 6.2 Corpus source access

The v1 expression `organisation_id is null or owns_row(organisation_id)` is insufficient as the complete read policy. Tenant ownership is one condition; source authorization is another.

- Global approved public regulatory sources may be read by authenticated users within the approved product scope. Private documents must never become global merely because a source row is missing.
- Tenant-owned chunks inherit the source document's permission area, sensitivity and any record-specific access restriction. The `corpus` administration area governs curation; it does not grant blanket access to restricted document contents.
- Apply the same source authorization to metadata, full-text search, vector search, tool results, cached responses, conversation history, drafts and audit detail. A summary can disclose the source just as its raw text can.
- Chunks require a valid source-version relationship. Missing or invalid permission metadata denies access. No authenticated caller may promote private content to a global source.
- Re-check access on each run and before displaying stored results. Permission revocation must also block derived answers/history that reveal the revoked source; append-only audit retention is separate from permission to view it.
- Show that an answer may be incomplete without disclosing the names, IDs, counts or existence of records the caller cannot access.

Prove this with two users in the same tenant with different document permissions, as well as two users in different tenants. Test direct retrieval and indirect disclosure through history, summaries, errors and audit screens.

### 6.3 Source version and time

Retain immutable source snapshots, source URL, content hash, retrieval timestamp, verification status, reviewer, jurisdiction, authority category, and provision-level effective intervals where required. A changed source creates a new version; it must not overwrite the text behind an existing citation.

For a historical flight, select the version effective on that date, including its end of validity. A version superseded today may still be the correct historical version. Keep ingestion time separate from legal effective time. An unresolved effective date blocks a requirement claim for the affected date range.

The exact regulatory dates, citations, authority classifications and retention obligations reported in v1 require source review. Do not change operational rules solely from either plan's summaries.

## 7. Search, tool and queue interfaces

### 7.1 Search RPC

Proposed contract for M-04, subject to schema review:

```text
search_corpus(
  p_domain,
  p_query_text,
  p_query_embedding,
  p_embedding_model,
  p_embedding_dims,
  p_authorities,
  p_effective_on,
  p_k
)
```

The server creates the query embedding using the corpus's pinned model/version and dimensions. Reject incompatible embeddings; never compare vectors produced by different embedding identities. Keep provider calls outside the SQL RPC. Validate domain, date, authority values, query size and bounded `p_k`; optional caller filters can only narrow the server-authorized scope. Apply RLS to both full-text and vector paths before returning content.

Return immutable source-version/chunk IDs, supporting text spans, citation, authority, effective interval and ranking components. Define distinct results for no accessible matches, invalid input, unsupported historical coverage, embedding mismatch, and backend failure. A backend failure must not be presented as an empty evidence register. Do not expose forbidden-source existence through result diagnostics.

Specify the SQL types, model identity format, actual limits, query settings and result schema in the implementation contract before M-04 is considered ready. Benchmark representative permission-filtered queries; settings and index sizing are measured configuration, not assumed constants.

### 7.2 Record tools

Retain v1's allow-listed read-only tools and one-round-trip RPC direction. Each tool contract must identify its permission area, arguments, row/byte caps, freshness timestamp, partial/truncated status, failure states and audit fields. Authorize record IDs under the caller's session. Distinguish no records from insufficient permission and query failure without revealing hidden records.

`/api/agent/run` authenticates the actual user session and active profile, then checks tenant enablement, tool permissions and budget. The cron route's shared-secret mechanism is not a substitute for user authentication. Readiness tools depend on C0 and the reviewed record sources.

### 7.3 Deferred processing

Use synchronous processing for the first pilot if it meets the measured runtime limits. Introduce queues only when required; adding a queue does not waive any authorization checks.

Before enabling queued work, define a versioned message schema with run ID, organization/user IDs, idempotency key, schema version, expiry, permitted phase, budget reservation ID, and references to an authorized input snapshot. Keep raw personal/source content out of general queue logs and dead-letter diagnostics.

A queue consumer has no caller session. It may compose over an already authorized snapshot only after a narrowly scoped server-side authorization operation confirms that the user is still active, still belongs to the tenant, and can still access every referenced source/record. Revalidate the response before delivery and on later reads. IDs in a message are claims to check, not proof of permission. Use an access/version revision check around processing so revocation during a run blocks delivery; discard stale results.

Any privileged validation RPC must be service-role-only, derive current permissions from trusted database state, validate the user/tenant/source relationship, and return a minimal result. Do not enqueue user JWTs or expose a generic impersonation RPC. Define retry, timeout, cancellation, duplicate delivery and terminal failure behavior before shipping the consumer.

## 8. Provider data rules and spending

### 8.1 Data sent to providers

Before enabling a provider or fallback route, record the provider and downstream routing destinations, permitted data classes, processing region where relevant, retention/training settings, credentials owner, and the approving organization role. Unknown provider settings mean the route remains disabled for private records.

Default pilot policy: redact direct identifiers unless needed; exclude DOB, work-authorization documents, restricted incident content, credentials/secrets and commercial estimates from external prompts until separately reviewed. Use minimized structured tool outputs rather than entire reports. Apply the same rules to embeddings, reranking, verification, tracing and provider prompt caches.

Fallback must remain inside the tenant's approved provider/data policy. If no permitted route is available, refuse with an availability explanation. Never silently send a restricted payload to a less restricted destination. Record the actual provider/model and any fallback in the run audit. Provider policy acceptance is a launch dependency, not permission to send production data during development.

### 8.2 Atomic budget reservations

Before any billable call, atomically reserve a conservative upper bound against the tenant's remaining budget. Use a transactional ledger or equivalent serialized authority; caching/counters may assist admission control but cannot be the sole proof of a hard spend ceiling.

Reservations cover generation, verification, embedding/reranking where billable, repair attempts and permitted fallback calls. Bound both input and output size. Reconcile actual usage after completion; uncertain timeouts remain conservatively charged until reconciled. A retry requires an available reservation. Fail closed when the authoritative budget store is unavailable.

Use idempotency keys for logical runs and phase attempts. For ambiguous provider timeouts, use provider idempotency where supported; otherwise treat the call as potentially billed before retrying. Define reservation expiry/recovery so a crashed worker neither permanently locks capacity nor frees funds for an in-flight call. Define the budget's currency/unit, daily reset timezone, token accounting, and reconciliation tolerance before enabling it.

Test simultaneous requests at the remaining limit, retries after timeout, duplicate queue messages, crashes after reservation, a call that succeeds while audit persistence fails, fallback charges, and budget-store failure. No admitted combination may exceed the reserved ceiling. An independent account-level provider ceiling remains defense in depth and must be exercised where available.

## 9. Answer validation and evaluation

Use a structured answer with explicit status (`answered`, `partial`, `refused`, or `unavailable`), individually identified claims, supporting chunk/record references, unknowns, and a human handoff. Every displayed normative or operational fact must map to evidence; free-text summaries and handoffs must not introduce uncatalogued claims. An `unknowns` field never authorizes unsupported assertions elsewhere in the answer.

| Check | Method | Release requirement |
|---|---|---|
| Structure and evidence binding | Deterministic schema, retrieved-ID membership, source version, valid span and permission checks | 100% of displayed normative claims pass; reject invalid output |
| Authority and historical validity | Reviewed source metadata plus deterministic date/jurisdiction checks | No displayed requirement rests only on an unverified or inapplicable source |
| Meaning supported by the cited text | Separate verifier and compliance-owner-labeled evaluation; verifier tier differs from generator | Every displayed normative claim must be accepted by verification; zero known unsupported normative claims in the release set |
| Record fidelity | Compare claims with authorized tool outputs and deterministic readiness verdict | No invented records, altered gate verdicts or suppressed blocking reasons |
| Refusal behavior | Mandatory-refusal cases with expected outcomes | 100% pass on release set, including no source, forbidden source, stale/inapplicable source and injected instructions |
| Useful answer coverage | Fraction of answerable cases answered correctly | Track separately from safety; proposed >=90% on the reviewed answerable set |

Deterministic citation binding does not establish semantic truth. A second model also does not guarantee it; record disagreement, preserve refusal, and use human review to calibrate the verifier. Drop unsupported claims, then check that the remaining answer is coherent and still answers the question. If dropping a claim changes the decision or hides material uncertainty, refuse or return an explicit partial answer.

Before the UAV pilot, use at least 60 labeled cases spanning normal, historical, incomplete, forbidden, adversarial and required-refusal scenarios. Include the 50 realistic workflow questions from v1 within that set where appropriate. The compliance owner labels the source-backed expected results and reviews every normative answer in the release set. Keep a holdout set separate from prompt tuning. Run retrieval regression on relevant schema, corpus, permission, prompt and model changes.

Review all pilot runs flagged by disagreement, refusal anomalies or user reports, plus a representative sample of other runs. Quarterly red-team work remains a later standing requirement; injection and cross-tenant tests are required before launch.

## 10. Testing and definition of done

Required checks against the exact release commit:

1. Dependency installation from the lockfile, lint, app and Worker typechecks, unit tests, app build and target-platform build.
2. Disposable-database migration replay, representative upgrade rehearsal, RLS/grant/constraint/trigger tests, and generated-type drift failure.
3. Browser journeys in isolated staging: login/reset, credential recording and independent verification, blocked flight submission/approval/logging, capped report export, revoked/deactivated access, and the first AI workflow when enabled.
4. AI regression: retrieval permissions and dates, claim validation, refusal, prompt injection, provider failure, cost concurrency, audit persistence and cancellation.
5. Human inspection of pilot screens, printed evidence and error/partial states. Verify that hidden records, raw database wording and secrets do not appear.

A task is done when its behavior and relevant failure modes are verified, comments/contracts are updated, migration compatibility is recorded, and the evidence is linked. A green unit-test total alone does not satisfy a release gate. Run checks appropriate to the change; do not fabricate successful runs or require unrelated checks for a documentation-only edit.

## 11. Staging, deployment and recovery

**Environment isolation:** local, staging and production use separate database projects, storage, secrets, callback origins and provider budgets. Staging uses synthetic/anonymized fixtures approved for its purpose; it does not reuse production personal records. Require explicit environment identifiers and a deployment preflight that refuses a staging build configured with production project identifiers. Disable real outbound mail, webhooks and SharePoint writes in staging unless an isolated integration test explicitly needs them.

**Deployment order:**

1. Record the release SHA, target project, migration set, named release owner and rollback triggers. Confirm secret rotation and stage-specific environment configuration.
2. Rehearse migrations and old/new app compatibility in staging. Verify credential/recency reconciliation for C0 and citation changes against reviewed source records.
3. Capture a production backup checkpoint and evidence from a restore rehearsal into an isolated project, including application, auth and storage recovery dependencies. Choose owner-approved RPO/RTO values before launch.
4. Apply compatible schema changes, deploy the application, run post-deploy smoke checks, and record the actual migration history and runtime configuration. Use an explicit controlled transition if compatibility cannot be maintained.
5. For platform cutover, verify authentication/session refresh, callbacks, signed storage URLs, API routes, webhooks, cron, Worker resource use and representative large inputs. Provision runtime secrets and required bindings before routing user traffic. Enable exactly one scheduler and verify deduplication.
6. Enable assistance only for the named pilot tenant/users after REL-2 and REL-3 evidence is complete. Observe it before expanding.

**Rollback triggers:** any confirmed tenant/source disclosure; authentication or readiness regression; missing audit trail; budget-ceiling failure; or error/latency thresholds exceeded. Define numeric error-rate and latency thresholds from staging measurements before deployment. On security or unsupported-readiness incidents, disable assistance immediately and contain the affected path.

**Application recovery:** roll back to a known compatible artifact or previous host and ensure only one scheduler runs. DNS rollback alone does not recover database changes.

**Database recovery:** prefer a reviewed forward fix for compatible schema issues. For destructive/corrupting changes, the release/database owner chooses a restore procedure with writes controlled and post-checkpoint data reconciled. Record how auth users, storage objects and database references are recovered together. Never describe an untested down migration as a recovery plan.

Keep the previous host available for an observation period agreed by the release owner. Run a recovery exercise before removing it. No deployment or infrastructure action is authorized merely by creating this planning file.

## 12. Operations and rollout decisions

Collect per-run and per-release latency, errors, refusal reasons, provider calls, cost reservations/actuals, retrieval coverage, truncated tools, verifier disagreements, audit failures and scheduler outcomes. Alert on cross-tenant/source authorization failures, missing audit writes, exceeded budgets and failed operational jobs. Logs must redact sensitive content and secrets.

Audit/history views require their own permission checks and source-aware redaction. Record enough source/version and permission context to reconstruct a decision without giving every administrator unrestricted access to personal or commercial records. Assign retention and deletion/legal-hold rules by record category after compliance/privacy review; do not automatically inherit a regulatory retention period for all prompts and model payloads.

Use the existing per-tenant settings and environment allow-list for rollout. Document how to disable assistance immediately, cancel queued/in-flight work where possible, and prevent new provider calls without disabling the operational record system. This does not require a general-purpose feature-flag platform.

Monthly during broader rollout, review a representative sample and all material incidents; reconcile provider usage and confirm owner/on-call coverage. Corpus/model/provider changes need regression evidence and a recoverable prior version.

## 13. Task dependencies and later roadmap

Existing task IDs remain stable. These dependency additions must be reconciled into the application repository's task ledger; migration IDs do not dictate execution order. In particular, regulatory M-15/M-16 may precede AI M-01, and permission enum additions must be applied before policies use them.

| Task/group | Required dependency clarification |
|---|---|
| P0-3 production migrations | REL-0, isolated staging, migration/upgrade tests, backup/recovery evidence |
| C0 and R-01/R-02 | Reviewed source mapping, data reconciliation, deterministic gate/reminder/report regression checks |
| M-01–M-04 and K-02 | Source-version model, permission inheritance, pinned embedding identity, explicit search contract; corpus-only preparation may run before REL-2 |
| M-03 corpus RLS | Any required permission enums/defaults first, then actual source-policy tests; organization membership alone is insufficient |
| M-05 audit and M-13 settings | Defined write path, read permissions, source-aware redaction, retention rules, budgets and rollout settings |
| M-14/A-03/B-02 tools | C0, relevant regulatory corrections, caller authorization, audit, caps and error contracts |
| A-01/A-02 gateway | Provider/data policy, stub tests, budget authority; M-05 for persisted accounting acceptance |
| A-04/A-05 answers | Reviewed corpus and sources, search contract, source authorization, semantic verifier and evaluation set |
| A-06/B-03 pilot UI | Relevant tools and answers, audit/settings, readiness verdict, REL-2, A-08 and Q-01; M-06 drafts are not required for read-only pilot |
| A-08 budgets | Atomic reservations, explicit reset/cost policy, concurrent and retry tests before any enabled provider route |
| Q-01 evaluation | Start fixtures and expected outcomes early; executable retrieval lane follows M-04; passing evaluation blocks the pilot |
| A-07 drafts | REL-4 expansion decision, M-06, B-02, evidence freshness check at confirmation, separation-of-duties and stale-draft tests |
| G-01–G-08 | Separate scope/owner decision after pilot evidence; source preparation may proceed independently if it adds no enabled operational surface |
| X-01 | Independently accepted UAV and GPR workflows; labeled authority and permission boundaries tested together |

**Later roadmap retained:** drafts through existing human-confirmed forms; GPR registry/calibration, jobs/lines/dataset processing lineage, QC/nonconformance release controls, deliverables and commercial estimates; then cross-domain assistance. Raw GPR files use bounded/direct storage transfer rather than oversized server-action payloads. Each capability needs measurable acceptance and a release owner; do not begin an unbounded parallel program from the presence of a task ID.

The v1 effort figures remain historical estimates with wide uncertainty. Re-estimate after the application inventory and contracts are complete; include database tests, source review, migration rehearsal, evaluation and operational recovery. Dates require named capacity and a critical path, not a sum of coding days.

## 14. Open decisions and document maintenance

| Decision | Responsible role to assign | Required by |
|---|---|---|
| Named engineering, database/platform, compliance, product and release owners | Project sponsor | REL-0 |
| Operator jurisdiction, actual operation types, source authority and citation reviewer | Compliance/operations owner | REL-2 |
| Staging projects, backup scope, RPO/RTO, deployment thresholds and recovery owner | Database/platform owner | REL-1 / cutover |
| Data residency and approved provider/data classes, including fallback and verification | Privacy/accountable organization owner | Before private data reaches any model service |
| Pilot users, case mix, latency ceiling, daily budget and outcome targets | Product/operations owner | REL-3 |
| Corpus/audit/history retention and deletion rules, including snapshots needed for evidence | Compliance/privacy owner | Before production ingestion and audit capture |
| Atomic budget mechanism and ambiguous-call reconciliation | Engineering/platform owner | A-08 |
| Region move and platform cutover business case, measured against current latency/cost | Platform/product owner | Before scheduling cutover |
| Drafts, GPR kit/manual priorities and cross-domain scope | Product/operations owner | REL-4 / REL-5 |

**Document layout:** this v1.1 file is the execution entry point. [v1](TerraOI-plan-v1.md) retains the original architecture inventory, white-label implementation notes, reported compliance defects, historical state and source-document map. It is a historical reference, not fresh verification evidence. The referenced application documents are absent from this workspace; broken references in v1 do not prove those artifacts exist here.

When integrated into the application repository, keep architecture in its architecture/design documents, dated verification records under `docs/status/`, task state and decision IDs in `proj-plan.md`, and deployment commands in the deploy runbook. These are proposed locations until actually created or verified. Link them from this entry point, and reconcile their precedence explicitly. Do not duplicate changing branch/test/migration counts across multiple documents.

Update the version/date when requirements change. Record the rationale and affected task/gate, keep original versions recoverable, and attach evidence when changing a status to complete. Revalidate time-sensitive dependency, platform, pricing and regulatory claims using the actual repository and authoritative sources before relying on them.

**Change log — 2026-11-04, v1.1:** incorporated the document review; reordered prerequisites; introduced release gates and accountable-role placeholders; added database integration tests, isolated staging and recovery requirements; extended source permissions across AI data paths; specified search/queue contracts; separated citation checks from semantic verification; added provider data rules and atomic budget reservations; narrowed the first pilot and defined proposed product outcomes; separated historical reports from current evidence. Application code, infrastructure and regulatory claims were not independently re-verified in this revision.
