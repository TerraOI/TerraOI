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

### FAQ-0001: Can components import CSS, JS or values directly from `brand/`?
**Answer:** No. `src/platform/branding/` reads `tokens.json` and `brand-config.json`, validates them against the `TenantBrand` contract, and the app uses that. **Why:** one validated choke point for white-label modes (plan §5.1, [brand/README.md](../brand/README.md)).
Source: PR #1 · Date: 2026-11-05 · Applies to: Lane 1
