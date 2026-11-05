# T-001 Team and agent rules

Lane: shared · Week: 0 · Protected: yes · Depends on: none · Status: done — merged as [PR #1](https://github.com/TerraOI/TerraOI/pull/1); the coordination protocol and question workflow landed in [PR #2](https://github.com/TerraOI/TerraOI/pull/2)
Plan refs: §20.1, §20.4, §20.6, §20.7

## Goal
Every builder's agent, whatever the tool, reads the same rules; protected paths route to the supervisor; PRs carry evidence; the supervisor has a repeatable review command.

## Owns
`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, `.github/CODEOWNERS`, `.github/pull_request_template.md`, `.claude/commands/terraoi-review.md`, `docs/tasks/`, `docs/decisions/`, `docs/status/`

## Acceptance
- [x] AGENTS.md covers plan §20.6 items 1–7
- [x] CODEOWNERS lists every protected path from §20.1
- [x] PR template contains the §20.4 self-review checklist
- [ ] Builders' GitHub handles added to CODEOWNERS (when known)
- [ ] Branch protection on `main` enabled by the owner (see docs/status)
