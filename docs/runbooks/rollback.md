# Rollback (plan §17.2 step 5, §16 Operations row)

**Status: the tool exists and is unit-tested; no rollback has ever been executed anywhere.** The staging rehearsal is gated on [#177](https://github.com/TerraOI/TerraOI/issues/177) (open `policy-violation` → `deploy-staging.yml` refuses), and production is not reachable from a builder machine by design (plan §20.8). What is proved today is the *decision logic*, in `scripts/workers-rollback.test.mjs`; what is owed is the run.

## The rule this enforces

§17.2 and [T-404](../tasks/T-404-production-readiness.md): **rollback is an app artifact plus an index generation, never "the last deploy."** So a rollback names two things — the `wrangler` version id and the pinned `embedding_indexes` generation — and both are written down before the command is typed. "We rolled back" is not evidence; a pair of ids is.

## Step 1 — see what is actually available · `AGENT`

```bash
node scripts/workers-rollback.mjs --env staging --list
```

Prints the retained versions newest-first: version id, timestamp, git revision. The default depth is three, which is the retention T-404 proposes; it becomes a real setting when the `workers/` deployment exists. `--depth N` overrides it for the rehearsal.

The helper refuses, before touching an account:

- an environment the config does not declare (`stageing` is a typo, not an empty environment);
- a version id that is not on the listing — including `latest` and `current`, which is exactly the "last deploy" thinking the rule is against;
- the version that is **already serving**, because that deploy would be read as a fix;
- **production**, unless the caller passes `--allow-production` — and that flag is the owner's to type, not an agent's (§20.8).

## Step 2 — dry-run, then execute · `AGENT` on staging, `OWNER` on production

```bash
node scripts/workers-rollback.mjs --env staging --to <VERSION_ID>            # prints the command, changes nothing
node scripts/workers-rollback.mjs --env staging --to <VERSION_ID> --execute  # the rehearsal step
```

Dry-run is the default. The command is built as an argument array, never a shell string, and the tests assert it carries no token, secret or URL material (AGENTS §4.6).

## Step 3 — check the schema is still compatible · `AGENT`

A rolled-back app must still work against the **current** schema. That is why the migration rule matters: `scripts/migrations.mjs` allows one new, later-timestamped migration per PR and forbids editing a merged one, and the rollback rule that follows is that **a migration which breaks the previous app version is a cutover, not an upgrade**. A cutover needs the owner's decision and a frozen artifact pair — old app *and* old generation — or the rollback lands on a schema it cannot speak to.

Check, in order:

```bash
node scripts/check-migrations.mjs      # what this release added to the sequence
git log --oneline <OLD_TAG>..<TAG> -- supabase/migrations/
```

If a migration in that range is not forward-compatible, **stop**: the rollback is a cutover and the owner decides it.

## Step 4 — the index generation half · `AGENT` (mechanism), `OWNER` (decision)

The app artifact is only half the pair. Retrieval answers from the pinned `embedding_indexes` generation ([ADR-0007](../decisions/0007-e1-embedding-clearance.md), [T-113](../tasks/T-113-chunk-embed-publish.md)'s pointer switch), so the rehearsal's second case is: switch the published generation, show retrieval answering from it, switch back, and show retrieval answering from the reverted generation with the same hits. The retention T-404 proposes is the last two published generations. Until T-113's pointer switch is on `main`, this step cannot run and is recorded as owed rather than approximated.

## Step 5 — record it

In the week's `docs/status/YYYY-Www.md`: the before/after `wrangler deployments list` pair, the generation pinned before and after, the preflight line, and **what the rollback did not undo** — §17.2 is explicit that an app or DNS rollback does not undo database, published-source or external-action changes, and a runbook that implies otherwise causes the next incident.

## Failure behaviour, written as rules

| Situation | Required behaviour |
|---|---|
| The rollback command fails partway | The previous version keeps serving; nothing is described as "half rolled back" |
| The listing shows only the current version | There is nothing to roll back to — escalate as an incident, do not redeploy an old tag blind (the build may not reproduce the artifact) |
| The schema moved incompatibly since the target | Stop; it is a cutover, and the owner decides |
| The generation to revert to is no longer retained | Stop; rebuild the generation, and record that retention was too shallow |
| An interrupted migration run | The environment stays on the previous compatible version and the sequence position is written down (§17.2) |

## What has not been rehearsed, and what would unblock each

| Item | Why not | Human step that unblocks it |
|---|---|---|
| Deploy A, deploy B, roll back to B→A on staging | #177 blocks staging deploys | owner closes [#177](https://github.com/TerraOI/TerraOI/issues/177) |
| Index-generation switch and revert | T-113's pointer switch is not on `main` | the lane lands T-113's SQL half (slot `036`) |
| A production rollback | production does not exist, and the tool refuses it without an owner flag | T-004's production provisioning + the owner's `--allow-production` |
