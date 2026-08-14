#!/usr/bin/env bash
# CHAT-CONCURRENCY KNEE SWEEP (Phase 7). Runs chat-concurrency.js once per level,
# each with server-side sampling, and writes a per-level k6 JSON summary + a CSV
# of server metrics into results/. Then prints a compact table so you can see the
# knee (where TTFB/errors inflect and pg connections hit the pool ceiling).
#
# Prereqs: source load-tests/.run/env.sh (from start-mock-stack.sh) so BASE_URL,
# BOT_KEY and MOCK_LLM_VERIFIED are set, and the mock stack is up.
#
#   LEVELS="1 5 10 15 20 30 50 100" DURATION=45s ./run-knee-test.sh
set -euo pipefail
LT="$(cd "$(dirname "$0")/.." && pwd)"
source "$LT/.run/env.sh"
API_PID="$(cat "$LT/.run/api.pid")"
LEVELS="${LEVELS:-1 5 10 15 20 30 50 100}"
DURATION="${DURATION:-45s}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUTDIR="$LT/results/knee_${STAMP}"
mkdir -p "$OUTDIR"
echo "conc,p50_ttfb_ms,p95_ttfb_ms,p99_ttfb_ms,p95_total_ms,error_rate,http_reqs,max_pg_active,max_pg_total" > "$OUTDIR/summary.csv"

for c in $LEVELS; do
  echo "===== concurrency = $c ====="
  csv="$OUTDIR/server_c${c}.csv"
  "$LT/runner/sample-server.sh" "$csv" "$API_PID" "$TEST_DB" 600 &
  SAMP=$!
  k6 run \
    -e CONC="$c" -e DURATION="$DURATION" \
    --summary-export "$OUTDIR/k6_c${c}.json" \
    "$LT/scenarios/chat-concurrency.js" || true
  kill "$SAMP" 2>/dev/null || true
  # Extract headline numbers from the k6 summary + server CSV.
  python3 "$LT/runner/parse-knee.py" "$c" "$OUTDIR/k6_c${c}.json" "$csv" >> "$OUTDIR/summary.csv"
done

echo; echo "===== KNEE SUMMARY ($OUTDIR/summary.csv) ====="
column -s, -t "$OUTDIR/summary.csv"
