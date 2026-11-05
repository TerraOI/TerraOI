---
description: Supervisor review of a TerraOI PR against AGENTS.md and plan §20.4
argument-hint: <PR number>
allowed-tools: Bash(gh pr view:*), Bash(gh pr list:*), Bash(gh issue list:*), Bash(gh issue view:*), Bash(gh pr diff:*), Bash(gh pr checks:*), Bash(git fetch:*), Bash(git diff:*), Bash(git log:*), Bash(pnpm:*), Read, Grep, Glob
---

You are assisting the TerraOI supervisor in reviewing pull request #$ARGUMENTS. You review; you do not approve, merge, push or comment on GitHub unless the supervisor explicitly says so in chat.

## Gather

1. `gh pr view $ARGUMENTS --json title,body,author,labels,files,baseRefName,headRefName,additions,deletions` and `gh pr checks $ARGUMENTS`.
2. `gh pr diff $ARGUMENTS`.
3. Read the task packet linked in the PR body (`docs/tasks/T-xxx-*.md`), the plan sections it cites in `docs/plan/TerraOI-plan-v1.3.md`, and `AGENTS.md`.
4. If the diff touches `supabase/`, read the full migration and its tests, not just the diff.

## Check (plan §20.4). For each item give PASS / FAIL / N/A with file:line evidence

1. **Scope.** Changes match the packet's "Owns" list; one lane plus shared paths, or a `cross-lane` label with a reason; no unrelated refactors; size about 400 lines or fewer, excluding migrations and generated types.
2. **Tests first and real.** Every acceptance item in the packet has a test. Name the key guard (RLS policy, membership check, clearance filter, verifier rule) and state which test would fail if it were removed. If none would, FAIL. Database behavior is tested against real Postgres/RLS, not mocks.
3. **Contracts.** Types come from `src/contracts/`; no duplicate ad-hoc schemas; any contract change has an ADR in `docs/decisions/`.
4. **Tenancy.** The organization comes only from `TenantContext`. Search the diff for org/tenant ids read from body, query, headers, cookies, model output or client state. Every service-role/admin client use is justified and has an ADR.
5. **RLS.** Every new table has RLS enabled, policies, and negative tests for another tenant, another project and a deactivated member. Every SECURITY DEFINER function pins `search_path`.
6. **Data policy.** Model calls only via `src/platform/gateway/`; data class propagated to derived rows; no change that relaxes clearance.
7. **Secrets and client bundle.** No secrets, `.env*`, keys or real client data; no privileged keys importable from client components (`'use client'` files).
8. **Failure behavior.** Safe error codes; no leakage of hidden records or provider names to employees; idempotency where retries are possible; no unverified answer text streamed.
9. **Evidence.** CI checks green; the PR pastes real `pnpm verify` (and `pnpm db:test`) output; staging evidence if the packet requires it.

## Report

- A table with the 9 items and their verdicts.
- **Blocking findings** first (must fix before merge), each with file:line, why it matters (cite the plan § or AGENTS.md rule) and a concrete fix.
- **Non-blocking suggestions**, kept short.
- A recommendation: Approve / Request changes / Escalate (escalate when it changes a contract, a security boundary or the plan).
- Also check coordination (docs/COORDINATION.md): the packet was claimed by this PR's author; every `Depends on` task is merged; no other open PR claims the same packet; `needs-contract` issues this PR depends on are resolved.
- If the supervisor asks, draft the GitHub review in the protocol format (COORDINATION.md §5): first line `[Supervisor] Round N`, then **Blocking** items numbered `B1…` (file:line, rule, fix) and **Non-blocking** items numbered `N1…`. Post it only after an explicit "post it", using `gh pr review <n> --request-changes` (or `--comment` / `--approve` as the supervisor says) with that body.
