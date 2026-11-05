# FAQ: answered questions

Search this file **before** opening a `question` issue ([COORDINATION.md §6](COORDINATION.md)). Each entry was answered by the supervisor. Decisions that change architecture or contracts live in [decisions/](decisions/) or plan §18.1 instead; this file links to them.

**Format:** newest at the top of each section. `FAQ-NNNN` ids never change or get reused. When an answer changes, keep the entry, mark it `Superseded by FAQ-NNNN`, and add the new one.

```markdown
### FAQ-NNNN: <question as asked>
**Answer:** <one to three sentences>. **Why:** <reason, with § or file>.
Source: #<issue> · Date: YYYY-MM-DD · Applies to: <lane / module / all>
```

## Stack and tooling

### FAQ-0003: Can I upgrade TypeScript to 7?
**Answer:** Not yet. TypeScript is pinned to 6.x. **Why:** `typescript-eslint` does not support TS 7, and lint crashes with it (plan §3.1: pin a tested compatibility set). Upgrade in a dedicated PR once typescript-eslint supports TS 7 and `pnpm verify` passes.
Source: PR #1 · Date: 2026-11-04 · Applies to: all

### FAQ-0002: Should I enable the OpenNext R2 incremental cache or ISR?
**Answer:** No. **Why:** authenticated tenant pages are private/no-store (plan §4.4); any cache needs an ADR that shows tenant, user and ACL scoping in its key.
Source: PR #1 · Date: 2026-11-04 · Applies to: Lane 1

## Repository and assets

### FAQ-0005: Where do Lane 2 HTTP routes (job API, knowledge review API) live?
**Answer:** In `src/app/api/jobs/` and `src/app/api/knowledge/`, owned by Lane 2 and protected in CODEOWNERS; every other path under `src/app/` stays Lane 1. Implement the route in Lane 2 directly, with no thin re-export from Lane 1. **Why:** the route file is the auth boundary, so it belongs to the lane that owns the handler and its tests (plan §20.2). Until the `scripts/lanes.mjs` change lands, don't open a PR that adds these routes.
Source: #11 · Date: 2026-11-05 · Applies to: Lane 2

### FAQ-0004: My feature needs to write a table the other lane owns. Who writes it?
**Answer:** The owning lane provides a scoped RPC (for example `create_collection_v1`) that enforces membership, role level and data-class rules; the other lane only calls it. Never write the other lane's table from your code or your own migration. **Why:** one place for the class and audience rules (plan §4.3, §6.2); knowledge tables grant members `select` only (#13).
Source: #10 · Date: 2026-11-05 · Applies to: all

### FAQ-0001: Can components import CSS, JS or values directly from `brand/`?
**Answer:** No. `src/platform/branding/` reads `tokens.json` and `brand-config.json`, validates them against the `TenantBrand` contract, and the app uses that. **Why:** one validated choke point for white-label modes (plan §5.1, [brand/README.md](../brand/README.md)).
Source: PR #1 · Date: 2026-11-05 · Applies to: Lane 1
