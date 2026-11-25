#!/usr/bin/env bash
# Docker-free pgTAP run (TOI-005). Fresh PG16 cluster shaped like Supabase: superuser supabase_admin
# owns the cluster, migrations and tests run as a NON-superuser "postgres" (as on Supabase), then seed,
# then pg_prove. Needs: postgresql-16, postgresql-16-pgvector, postgresql-16-pgtap, postgresql-16-cron,
# libtap-parser-sourcehandler-pgtap-perl. This is NOT `supabase db test` (config pins PG17); CI's
# `database` job stays the gate.
# Usage: scripts/db-shim/run.sh [repo-dir] [test-glob]     NOTEST=1 stops after migrations+seed.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "${1:-$HERE/../..}" && pwd); GLOB=${2:-'*.sql'}
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
DATA=${PGSHIM_DATA:-/tmp/pgshim-data}; PORT=${PGSHIM_PORT:-54329}
RUNAS=${PGSHIM_OS_USER:-postgres}
as_os() { if [ "$(id -un)" = "$RUNAS" ]; then bash -c "$1"; else su "$RUNAS" -c "$1"; fi; }
dups=$(ls "$REPO"/supabase/migrations/*.sql | xargs -n1 basename | cut -c1-14 | sort | uniq -d)
if [ -n "$dups" ]; then echo "DUPLICATE MIGRATION VERSION(S): $dups"; exit 5; fi
as_os "$PGBIN/pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1 || true
rm -rf "$DATA"; mkdir -p "$DATA"; chown "$RUNAS" "$DATA" 2>/dev/null || true
as_os "$PGBIN/initdb -D $DATA -U supabase_admin --auth=trust" >/dev/null
cat >> "$DATA/postgresql.conf" <<EOF
port=$PORT
shared_preload_libraries='pg_cron'
cron.database_name='postgres'
unix_socket_directories='/tmp'
listen_addresses='127.0.0.1'
EOF
as_os "$PGBIN/pg_ctl -D $DATA -l /tmp/pgshim.log -w start" >/dev/null
A="psql -h /tmp -p $PORT -U supabase_admin -v ON_ERROR_STOP=1 -q"
$A -d template1 -c "create database postgres" 2>/dev/null || true
$A -d postgres -c "create role postgres login createrole createdb replication bypassrls"
$A -d postgres -c "alter database postgres owner to postgres"
$A -d postgres -c "alter database postgres set search_path = \"\$user\", public, extensions"
$A -d postgres -f "$HERE/supabase-shim.sql" >/dev/null
P="psql -h /tmp -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q"
for f in $(ls "$REPO"/supabase/migrations/*.sql | sort); do
  if ! $P -f "$f" > /tmp/pgshim-mig.log 2>&1; then echo "MIGRATION FAILED: $f"; tail -n 20 /tmp/pgshim-mig.log; exit 3; fi
done
if [ -f "$REPO/supabase/seed.sql" ]; then $P -f "$REPO/supabase/seed.sql" > /tmp/pgshim-seed.log 2>&1 || { echo SEED FAILED; tail -n 20 /tmp/pgshim-seed.log; exit 4; }; fi
echo "migrations+seed ok"
[ "${NOTEST:-0}" = 1 ] && exit 0
cd "$REPO/supabase/tests/database"
pg_prove -h /tmp -p $PORT -U postgres -d postgres $GLOB
