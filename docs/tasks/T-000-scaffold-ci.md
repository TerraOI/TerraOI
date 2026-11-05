# T-000 Repository scaffold, CI and staging pipeline

Lane: shared · Week: 0 · Protected: yes · Depends on: none · Status: in review (this PR)
Plan refs: §3.1, §3.3, §15.1 TOI-00, §16 (CI paragraph), §20.1

## Goal
A greenfield Next.js + OpenNext (Cloudflare) + Supabase repository where `pnpm verify` and CI give every later task a reliable green/red signal, and merges to `main` can deploy to staging once T-004 supplies the infrastructure.

## Owns
`package.json`, `pnpm-lock.yaml`, root configs, `src/app/` placeholder, `src/contracts/health*`, `supabase/config.toml`, `supabase/tests/database/000_guardrails.test.sql`, `scripts/`, `.github/workflows/`

## Acceptance
- [x] `pnpm verify` passes locally (lint, typecheck, unit tests, docs links, Next build)
- [x] `pnpm cf:build` produces a Workers bundle
- [ ] CI `database` job runs Supabase locally and the guardrail tests pass (verified on first CI run)
- [x] Lane rule unit-tested (`scripts/lanes.test.mjs`)
- [x] Staging deploy workflow skips cleanly until T-004 secrets exist

## Out of scope
Tenancy, auth, any product feature (T-1xx onward).
