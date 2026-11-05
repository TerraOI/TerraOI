---
description: Answer builders' open questions and decisions, oldest first, grounded in the TerraOI docs
argument-hint: "[issue number] (optional: answer just one)"
allowed-tools: Bash(gh issue list:*), Bash(gh issue view:*), Bash(gh pr list:*), Bash(gh pr view:*), Bash(git fetch:*), Bash(git log:*), Read, Grep, Glob
---

You help the TerraOI supervisor answer questions from builders' AI agents (docs/COORDINATION.md §6). Builders keep working on a stated assumption while they wait, so **accuracy matters more than speed**: a wrong answer sends an agent the wrong way. You **draft**; you post, label, close or edit files only after the supervisor says so in chat.

## 1. Collect

- If `$ARGUMENTS` names an issue, handle only that one. Otherwise:
  `gh issue list --state open --label question --json number,title,createdAt,author,assignees` and the same for `needs-supervisor`, oldest first.
- For each: `gh issue view <n> --comments`. Note the asker's **assumption**, whether it is reversible, and any `provisional` PRs that reference it (`gh pr list --search "Provisional on: #<n> in:body" --state open`).

## 2. Draft each answer

1. **Search the sources** before answering: `docs/FAQ.md`, `docs/plan/TerraOI-plan-v1.3.md`, `AGENTS.md`, `docs/COORDINATION.md`, `docs/REPO-STRUCTURE.md`, `docs/decisions/`, the packet, `src/contracts/`. Cite every claim as `§x.y`, a file path or `FAQ-NNNN`.
2. **Classify it again.** A `question` that actually touches a §6 decision area (tenancy, RLS, clearance, verification, contracts, scope, weakening a test) is a **decision**: say so and switch to the decision format.
3. **Clarification format:**
   - **Answer:** one to three sentences.
   - **Your assumption:** *confirmed* / *adjust: …* (what to change in the provisional work).
   - **Sources:** …
   - **Add to FAQ?** yes/no; if yes, the proposed `FAQ-NNNN` entry.
4. **Decision format:** options (from the asker plus any they missed) with trade-offs, your recommendation and why, what it changes (contracts, ADR needed?, plan section), and the follow-up the asker should take. Mark it **Supervisor decides**: never present your recommendation as the decision.
5. If the docs genuinely don't answer it, say so plainly. Don't invent; propose which doc should gain the answer.

## 3. Present, then act only on approval

Show all drafts in one message, oldest first, numbered by issue. For each one the supervisor approves (possibly edited), and only then:

- Post a comment beginning `[Supervisor] Answer` with the final text (`gh issue comment <n> --body-file …`).
- `gh issue edit <n> --add-label answered`, then `gh issue close <n> --reason completed`.
- For linked `provisional` PRs, comment `[Supervisor] #<n> answered: <confirmed | adjust: …>. Remove provisional once your PR matches.`
- Queue FAQ entries and ADRs for a `docs/faq-YYYY-Www` branch; offer to open that PR at the end.

Never answer on the supervisor's behalf without their approval, and never close a `needs-supervisor` issue without an explicit decision from them.
