#!/usr/bin/env bash
# Tear down the mock stack started by start-mock-stack.sh. Does NOT drop the test
# DB by default (keep it for repeat runs / DB-scale). Pass --drop-db to remove it.
set -uo pipefail
LT="$(cd "$(dirname "$0")/.." && pwd)"
for p in api mock; do
  if [ -f "$LT/.run/$p.pid" ]; then
    pid="$(cat "$LT/.run/$p.pid")"
    kill "$pid" 2>/dev/null && echo "stopped $p ($pid)" || echo "$p already stopped"
    rm -f "$LT/.run/$p.pid"
  fi
done
if [ "${1:-}" = "--drop-db" ]; then
  TEST_DB="${TEST_DB:-oyechats_loadtest}"
  dropdb -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" "$TEST_DB" && echo "dropped $TEST_DB" || true
fi
