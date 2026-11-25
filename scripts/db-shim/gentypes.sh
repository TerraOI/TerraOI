#!/usr/bin/env bash
# Regenerate src/contracts/database.types.ts without Docker (TOI-004/005): migrate a fresh shim DB, then run
# postgres-meta v0.100.0 (the version supabase CLI 3.0.0 pins) with an identity formatter, which is what makes
# the output byte-identical to CI's artifact on main a0a6b3c. Usage: scripts/db-shim/gentypes.sh [out-file]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../.." && pwd)
OUT=${1:-$REPO/src/contracts/database.types.ts}
PGMETA=${PGMETA_DIR:-/tmp/postgres-meta-v0.100.0}
if [ ! -d "$PGMETA/node_modules" ]; then
  git clone -q --depth 1 --branch v0.100.0 https://github.com/supabase/postgres-meta.git "$PGMETA"
  (cd "$PGMETA" && npm ci --ignore-scripts --silent)
  sed -i 's|^const host: Host = .*|const host: Host = { cwd: process.cwd(), env: process.env, format: async (code: string) => code }|' "$PGMETA/src/server/format-pool.ts"
  sed -i 's|^const host = { cwd: process.cwd(), env: process.env }|const host = { cwd: process.cwd(), env: process.env, format: async (c) => c }|' "$PGMETA/src/server/format-worker.js"
fi
NOTEST=1 "$HERE/run.sh" "$REPO" >/dev/null
cd "$PGMETA"
PG_META_DB_URL="postgres://supabase_admin@127.0.0.1:${PGSHIM_PORT:-54329}/postgres" PG_META_GENERATE_TYPES=typescript \
PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=public,graphql_public PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=true \
  node --loader ts-node/esm src/server/server.ts 2>/tmp/gentypes.err > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"; echo "wrote $OUT"
