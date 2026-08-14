#!/usr/bin/env bash
# Bring up an ISOLATED mock chat stack for load testing (Phase 8 / 8A):
#   - creates/migrates an isolated Postgres DB (oyechats_loadtest)
#   - seeds plans + fixtures (a bot with an active sub, ai_chat cost 0, docs)
#   - starts the mock LLM/embeddings server (no external provider calls)
#   - starts a SECOND API instance on :8001 routed entirely at the mock
#   - verifies a real chat streams end-to-end, then prints the k6 env
#
# Nothing here touches production or the running dev instance on :8000.
# Re-runnable: it reuses the DB/seed if already present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
API="$ROOT/api"
LT="$ROOT/load-tests"
PY="$API/.venv/bin/python"

TEST_DB="${TEST_DB:-oyechats_loadtest}"
PGHOST="${PGHOST:-localhost}"; PGPORT="${PGPORT:-5432}"
DB_URL="postgresql://${PGHOST}:${PGPORT}/${TEST_DB}"
API_PORT="${API_PORT:-8001}"
MOCK_PORT="${MOCK_PORT:-9099}"
REDIS_URL="${REDIS_URL:-redis://localhost:6379/3}"   # DB index 3 = isolated from dev
DOCS="${DOCS:-50}"
DB_POOL_SIZE="${DB_POOL_SIZE:-5}"; DB_MAX_OVERFLOW="${DB_MAX_OVERFLOW:-10}"
mkdir -p "$LT/results" "$LT/.run"

echo "== 1. create test DB ($TEST_DB) if absent =="
psql "postgresql://${PGHOST}:${PGPORT}/postgres" -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${TEST_DB}'" | grep -q 1 \
  || createdb -h "$PGHOST" -p "$PGPORT" "$TEST_DB"

echo "== 2. migrate =="
( cd "$API" && DB_URL="$DB_URL" APP_ENV=development "$API/.venv/bin/alembic" upgrade head )

echo "== 3. seed plans + fixtures =="
( cd "$API" && DB_URL="$DB_URL" APP_ENV=development "$PY" scripts/seed_plans.py --apply || \
  DB_URL="$DB_URL" APP_ENV=development "$PY" scripts/seed_plans.py )
( cd "$API" && DB_URL="$DB_URL" APP_ENV=development "$PY" "$LT/datasets/seed_fixtures.py" --docs "$DOCS" )

echo "== 4. start mock LLM server on :$MOCK_PORT =="
( cd "$LT/mock-llm" && MOCK_LLM_LATENCY_MS="${MOCK_LLM_LATENCY_MS:-1200}" \
  "$PY" -m uvicorn server:app --host 127.0.0.1 --port "$MOCK_PORT" \
  > "$LT/.run/mock.log" 2>&1 & echo $! > "$LT/.run/mock.pid" )
sleep 2
curl -fsS "http://127.0.0.1:${MOCK_PORT}/healthz" >/dev/null && echo "  mock: up"

echo "== 5. start test API instance on :$API_PORT (routed at mock) =="
cd "$API"
DB_URL="$DB_URL" \
APP_ENV=development \
REDIS_URL="$REDIS_URL" \
WORKER_ENABLED=false \
DB_POOL_SIZE="$DB_POOL_SIZE" DB_MAX_OVERFLOW="$DB_MAX_OVERFLOW" \
LLM_MODEL="openai/gpt-4o-mini" FALLBACK_MODEL="openai/gpt-4o-mini" \
OPENAI_API_KEY="sk-mock-loadtest" \
OPENAI_API_BASE="http://127.0.0.1:${MOCK_PORT}/v1" \
OPENAI_BASE_URL="http://127.0.0.1:${MOCK_PORT}/v1" \
GOOGLE_API_KEY="mock-loadtest" \
GEMINI_EMBED_URL="http://127.0.0.1:${MOCK_PORT}/v1beta" \
RELEVANCE_GATE_ENABLED=false RERANK_ENABLED=false \
DYLD_FALLBACK_LIBRARY_PATH="${DYLD_FALLBACK_LIBRARY_PATH:-/opt/homebrew/lib}" \
"$API/.venv/bin/python" -m uvicorn app.main:app --host 127.0.0.1 --port "$API_PORT" --workers 1 --proxy-headers --forwarded-allow-ips="*" \
  > "$LT/.run/api.log" 2>&1 &
echo $! > "$LT/.run/api.pid"

echo "== 6. wait for API health =="
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${API_PORT}/health/live" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${API_PORT}/health/full" || { echo "API did not come up; see $LT/.run/api.log"; exit 1; }
echo

echo "== 7. verify a real chat streams via the mock (no external spend) =="
curl -fsS -m 30 -X POST "http://127.0.0.1:${API_PORT}/chat/stream" \
  -H 'Content-Type: application/json' -H 'X-Bot-Key: bot-loadtest-000000' \
  -d '{"question":"what are your pricing plans?","session_id":"session_verify_0"}' | head -c 200
echo; echo

cat > "$LT/.run/env.sh" <<EOF
export BASE_URL=http://127.0.0.1:${API_PORT}
export BOT_KEY=bot-loadtest-000000
export API_KEY=lt_admin_key_deterministic_0001
export OPERATOR_KEY=lt_operator_key_deterministic_0001
export TEST_ENV=local
export MOCK_LLM=true
export MOCK_LLM_VERIFIED=1
export TEST_DB=${TEST_DB}
export DB_URL=${DB_URL}
EOF
echo "Stack up. Source the k6 env with:  source $LT/.run/env.sh"
