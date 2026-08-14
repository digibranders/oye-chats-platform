#!/usr/bin/env bash
# DB SCALE BENCHMARK (Phase 12). Seeds chat_messages to each target row count and
# runs EXPLAIN ANALYZE on the hot-path queries the audit flagged, BEFORE and AFTER
# creating the two missing indexes — proving their impact with measured plans.
#
#   LEVELS="100000 1000000" ./run-db-scale.sh
set -euo pipefail
LT="$(cd "$(dirname "$0")/.." && pwd)"
API="$LT/../api"
PY="$API/.venv/bin/python"
TEST_DB="${TEST_DB:-oyechats_loadtest}"
DB_URL="postgresql://localhost:5432/${TEST_DB}"
LEVELS="${LEVELS:-100000 1000000}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$LT/results/dbscale_${STAMP}.txt"

HOT_SESSION_QUERY="SELECT * FROM chat_messages WHERE session_id='session_scale_5' ORDER BY created_at DESC LIMIT 5;"
HOT_BOT_QUERY="SELECT * FROM chat_sessions WHERE bot_id=(SELECT id FROM bots ORDER BY id LIMIT 1) ORDER BY created_at DESC LIMIT 500;"

explain() { psql "$DB_URL" -X -c "EXPLAIN (ANALYZE, BUFFERS, TIMING) $1"; }

{
  for target in $LEVELS; do
    echo "############################################################"
    echo "# TARGET chat_messages ~= $target"
    echo "############################################################"
    ( cd "$API" && DB_URL="$DB_URL" APP_ENV=development "$PY" "$LT/datasets/seed_scale.py" --messages "$target" )
    echo "----- row counts -----"
    psql "$DB_URL" -X -c "SELECT (SELECT count(*) FROM chat_messages) AS messages, (SELECT count(*) FROM chat_sessions) AS sessions;"

    echo "===== BEFORE INDEXES: hot history query ====="; explain "$HOT_SESSION_QUERY"
    echo "===== BEFORE INDEXES: hot bot-session query ====="; explain "$HOT_BOT_QUERY"

    echo "===== creating missing indexes ====="
    psql "$DB_URL" -X -c "CREATE INDEX IF NOT EXISTS ix_chat_messages_session_id_created ON chat_messages(session_id, created_at DESC);"
    psql "$DB_URL" -X -c "CREATE INDEX IF NOT EXISTS ix_chat_sessions_bot_id_created ON chat_sessions(bot_id, created_at DESC);"
    psql "$DB_URL" -X -c "ANALYZE chat_messages; ANALYZE chat_sessions;"

    echo "===== AFTER INDEXES: hot history query ====="; explain "$HOT_SESSION_QUERY"
    echo "===== AFTER INDEXES: hot bot-session query ====="; explain "$HOT_BOT_QUERY"

    echo "===== dropping the test indexes (repeatable next level) ====="
    psql "$DB_URL" -X -c "DROP INDEX IF EXISTS ix_chat_messages_session_id_created; DROP INDEX IF EXISTS ix_chat_sessions_bot_id_created;"
    echo
  done
} | tee "$OUT"
echo "Saved -> $OUT"
