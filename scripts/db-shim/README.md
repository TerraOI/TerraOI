# db-shim: pgTAP and type generation without Docker

For machines where `supabase start` cannot run (no Docker, or no registry access). CI's `database` job remains the gate; results here are labelled "PG16 shim" and are evidence, not a substitute.

| Script | What it does |
|---|---|
| `run.sh [repo] [glob]` | fresh PG16 cluster, Supabase-like roles/schemas (`supabase-shim.sql`), all migrations as non-superuser `postgres`, `seed.sql`, then `pg_prove` over `supabase/tests/database`; refuses duplicate migration versions |
| `gentypes.sh [out]` | regenerates `src/contracts/database.types.ts` with postgres-meta v0.100.0; byte-identical to CI on `main` a0a6b3c |
| `font-mock.cjs` | `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` file for an offline `next build --webpack` |

Ubuntu packages: `postgresql-16 postgresql-16-pgvector postgresql-16-pgtap postgresql-16-cron libtap-parser-sourcehandler-pgtap-perl`. Run as root (it `su`s to `postgres` for `initdb`) or as the `postgres` OS user.

Known fidelity gaps: PG16 not PG17; `auth`/`storage`/`graphql_public` are minimal stubs (only what migrations and tests touch); no PostgREST, so request-role behaviour is exercised through `set local role` exactly as the pgTAP files already do.
