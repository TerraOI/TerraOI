# FAQ: answered questions

Search this file **before** opening a `question` issue ([COORDINATION.md §6](COORDINATION.md)). Each entry was answered by the supervisor. Decisions that change architecture or contracts live in [decisions/](decisions/) or plan §18.1 instead; this file links to them.

**Format:** newest at the top of each section. `FAQ-NNNN` ids never change or get reused. When an answer changes, keep the entry, mark it `Superseded by FAQ-NNNN`, and add the new one.

```markdown
### FAQ-NNNN: <question as asked>
**Answer:** <one to three sentences>. **Why:** <reason, with § or file>.
Source: #<issue> · Date: YYYY-MM-DD · Applies to: <lane / module / all>
```

## Stack and tooling

### FAQ-0009: How do I update `database.types.ts` without Docker?
**Answer:** Push the migration with its pgTAP. If the types are stale, CI's `database` job fails only on that step and uploads the regenerated file as the `database-types` artifact; run `gh run download <run id> -n database-types -D src/contracts/`, commit it and push. Never hand-edit the file, and never take types from a run whose pgTAP failed (that run uploads none). **Why:** no builder machine has Docker, and CI is the only place the generator runs ([#122](https://github.com/TerraOI/TerraOI/issues/122)).
Source: #122 · Date: 2026-11-09 · Applies to: all (migration PRs)

### FAQ-0003: Can I upgrade TypeScript to 7?
**Answer:** Not yet. TypeScript is pinned to 6.x. **Why:** `typescript-eslint` does not support TS 7, and lint crashes with it (plan §3.1: pin a tested compatibility set). Upgrade in a dedicated PR once typescript-eslint supports TS 7 and `pnpm verify` passes.
Source: PR #1 · Date: 2026-11-04 · Applies to: all

### FAQ-0002: Should I enable the OpenNext R2 incremental cache or ISR?
**Answer:** No. **Why:** authenticated tenant pages are private/no-store (plan §4.4); any cache needs an ADR that shows tenant, user and ACL scoping in its key.
Source: PR #1 · Date: 2026-11-04 · Applies to: Lane 1

## Repository and assets

### FAQ-0008: How are brand assets (logos, symbols) served?
**Answer:** Platform assets from `brand/` are copied at build time into `public/brand/v<kit version>/` (generated, git-ignored, never committed). Customer assets are served by `GET /brand-assets/{configVersion}/{name}`, resolved from the request host and stored in `tenant_brand_assets`. Both send `Cache-Control: public, max-age=31536000, immutable`, because the version is in the path. **Why:** the kit stays the single source, and a host can never be asked for another tenant's asset ([#118](https://github.com/TerraOI/TerraOI/issues/118), T-103).
Source: #118 · Date: 2026-11-09 · Applies to: Lane 1

### FAQ-0007: I need a small change in another packet's merged files. What do I do?
**Answer:** Don't edit them. Ask on an issue; that packet's claimant (or the supervisor) can authorize a scoped edit that names the exact files and changes, and you make it in your own PR. **Why:** each file has one owner ([COORDINATION.md §3](COORDINATION.md)), and a named, scoped authorization keeps that true ([#44](https://github.com/TerraOI/TerraOI/issues/44)).
Source: #44 · Date: 2026-11-08 · Applies to: all

### FAQ-0006: Who may upload into a collection?
**Answer:** Anyone holding `knowledge.write` (the `contributor` role) or `knowledge.admin`, within the collection's project audience. Uploading is capture, not publication: content reaches employees only after review (T-213). **Why:** plan §6.2 and the publish predicate `user_may_publish_into` ([#39](https://github.com/TerraOI/TerraOI/issues/39)).
Source: #39 · Date: 2026-11-08 · Applies to: all

### FAQ-0005: Where do Lane 2 HTTP routes (job API, knowledge review API) live?
**Answer:** In `src/app/api/jobs/` and `src/app/api/knowledge/`, owned by Lane 2 and protected in CODEOWNERS; every other path under `src/app/` stays Lane 1. Implement the route in Lane 2 directly, with no thin re-export from Lane 1. **Why:** the route file is the auth boundary, so it belongs to the lane that owns the handler and its tests (plan §20.2). `scripts/lanes.mjs` picks the longest matching prefix, so the `lanes` CI check treats these folders as Lane 2.
Source: #11 · Date: 2026-11-05 · Applies to: Lane 2

### FAQ-0004: My feature needs to write a table the other lane owns. Who writes it?
**Answer:** The owning lane provides a scoped RPC (for example `create_collection_v1`) that enforces membership, role level and data-class rules; the other lane only calls it. Never write the other lane's table from your code or your own migration. **Why:** one place for the class and audience rules (plan §4.3, §6.2); knowledge tables grant members `select` only (#13).
Source: #10 · Date: 2026-11-05 · Applies to: all

### FAQ-0001: Can components import CSS, JS or values directly from `brand/`?
**Answer:** No. `src/platform/branding/` reads `tokens.json` and `brand-config.json`, validates them against the `TenantBrand` contract, and the app uses that. **Why:** one validated choke point for white-label modes (plan §5.1, [brand/README.md](../brand/README.md)).
Source: PR #1 · Date: 2026-11-05 · Applies to: Lane 1
