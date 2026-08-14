#!/usr/bin/env bash
# Sample server-side capacity metrics into a CSV once per second while a k6 test
# runs. This is the NO-DOCKER observability path (Phase 16): it captures exactly
# the signals that reveal the DB-pool knee and event-loop stall.
#
#   ./sample-server.sh <out.csv> <api_pid> [test_db] [duration_s]
#
# Columns: ts, sys_cpu_idle, api_rss_mb, api_cpu, pg_total, pg_active, pg_idle_txn,
#          pg_waiting, redis_clients, redis_ops
set -euo pipefail
OUT="${1:?usage: sample-server.sh <out.csv> <api_pid> [test_db] [dur]}"
API_PID="${2:?api pid required}"
TEST_DB="${3:-oyechats_loadtest}"
DUR="${4:-600}"
DB_URL="postgresql://localhost:5432/${TEST_DB}"

echo "ts,sys_cpu_idle_pct,api_rss_mb,api_cpu_pct,pg_total,pg_active,pg_idle_in_txn,pg_waiting,redis_clients,redis_ops" > "$OUT"
end=$(( $(date +%s) + DUR ))
while [ "$(date +%s)" -lt "$end" ]; do
  ts=$(date +%s)
  # System CPU idle % (macOS `top`), best-effort.
  idle=$(top -l 1 -n 0 2>/dev/null | awk -F'[ %]+' '/CPU usage/{print $(NF-1)}' | head -1)
  # API process RSS (MB) + %CPU.
  read -r rss cpu < <(ps -o rss=,%cpu= -p "$API_PID" 2>/dev/null | awk '{printf "%.0f %s", $1/1024, $2}') || true
  # Postgres connection breakdown for the TEST DB only.
  pgline=$(psql "$DB_URL" -tAc \
    "SELECT count(*), count(*) FILTER (WHERE state='active'), count(*) FILTER (WHERE state='idle in transaction'), count(*) FILTER (WHERE wait_event_type='Client' OR wait_event IS NOT NULL) FROM pg_stat_activity WHERE datname='${TEST_DB}';" 2>/dev/null | tr '|' ',' )
  [ -z "$pgline" ] && pgline=",,,"
  rclients=$(redis-cli -n 3 info clients 2>/dev/null | awk -F: '/connected_clients/{print $2+0}')
  rops=$(redis-cli info stats 2>/dev/null | awk -F: '/instantaneous_ops_per_sec/{print $2+0}')
  echo "${ts},${idle:-},${rss:-},${cpu:-},${pgline},${rclients:-},${rops:-}" >> "$OUT"
  sleep 1
done
