# TerraOI agent tracking

Working records of the autonomous execution agent (branch `terraoi/build`). Source of truth for requirements stays [docs/plan/TerraOI-plan-v1.3.md](../plan/TerraOI-plan-v1.3.md) (unchanged).

| File | Purpose |
|---|---|
| [TerraOI-agent.md](TerraOI-agent.md) | Reusable execution instructions and local tooling |
| [TerraOI-todo.md](TerraOI-todo.md) | Requirement coverage and task status |
| [TerraOI-backlog.md](TerraOI-backlog.md) | Questions, blockers, deferred decisions |
| [TerraOI-state.md](TerraOI-state.md) | Current checkpoint and exact next action |
| [TerraOI-execution-log.md](TerraOI-execution-log.md) | Concise execution history |
| [TerraOI-tasks/](TerraOI-tasks/) | One file per agent task with verification |

These live under `docs/` rather than the repository root because `scripts/structure.mjs` refuses new top-level entries without supervisor approval (see backlog Q-02).
