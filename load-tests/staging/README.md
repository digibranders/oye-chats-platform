# Reproducible Docker staging stack

A full, throwaway mirror of production — **nginx → API (gunicorn) → PostgreSQL 16 +
pgvector + Redis + ARQ worker** — for scalability testing. Spend-safe: a bundled
mock LLM/embeddings service stands in for OpenAI/Gemini, so nothing external is
ever called. Isolated from the repo's dev `docker-compose.yml`, the systemd units,
and the prod nginx config.

## Start / stop

```bash
# from repo root
docker compose -f load-tests/staging/docker-compose.yml up -d --build
# ... test ...
docker compose -f load-tests/staging/docker-compose.yml down -v   # -v also drops the DB volume
```

Boot order is enforced by health/completion gates: `db`+`redis`+`mock-llm` become
healthy → `migrate` runs `alembic upgrade head` (incl. the new hot-path indexes)
→ `api` and `worker` start → `nginx` waits for `api` healthy.

## Health checks

```bash
curl -fsS http://localhost:8088/health/live      # liveness (no DB/LLM)
curl -fsS http://localhost:8088/health/full | jq # db, redis, worker, llm, pool, chat_gate
docker compose -f load-tests/staging/docker-compose.yml ps   # per-service health
```

`/health/full` reports the `pool` (checked_out connections) and the new
`chat_gate` (in_flight / available / rejected_total) — the two signals to watch
under load.

## Ports (chosen to avoid clashing with a local dev stack)

| Service | Host port | Purpose |
|---|---|---|
| nginx  | 8088 | the one entrypoint — point k6/browsers here |
| db     | 55432 | psql for seeding + EXPLAIN |
| redis  | 56379 | redis-cli inspection |

## Seed test data, then load-test

```bash
# 1. Seed a bot + active sub + warm sessions into the staging DB
DB_URL=postgresql://oyechats:oyechats@localhost:55432/oyechats \
  ../../api/.venv/bin/python ../datasets/seed_fixtures.py --docs 50 --warm 120
# (or run it inside the container: docker compose ... exec api uv run python /app/../load-tests/datasets/seed_fixtures.py ...)

# 2. Run the k6 knee test against the staging entrypoint
BASE_URL=http://localhost:8088 BOT_KEY=bot-loadtest-000000 MOCK_LLM_VERIFIED=1 \
  LEVELS="1 5 10 15 20 30 50 100" DURATION=40s bash ../runner/run-knee-test.sh
```

## A/B the scalability knobs

The knobs under test are compose env vars — override to compare configs without
code changes:

```bash
CHAT_MAX_CONCURRENCY=20 DB_POOL_SIZE=10 \
  docker compose -f load-tests/staging/docker-compose.yml up -d
```

| Var | Default | Meaning |
|---|---|---|
| `WEB_CONCURRENCY` | 1 | gunicorn workers (keep 1 until the WS backplane lands) |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` | 5 / 10 | API connection pool (max 15) |
| `CHAT_MAX_CONCURRENCY` | 10 | backpressure gate — in-flight chat generations |
| `CHAT_ACQUIRE_TIMEOUT_S` | 8 | wait for a slot before a 503 |
| `MOCK_LLM_LATENCY_MS` | 1200 | simulated generation time (on the `mock-llm` service) |

## Notes

- **Docker was not available in the environment that authored this stack**, so it
  was validated for config correctness, not executed here. The equivalent
  process-level stack (same code, same pool config, same mock) was used for the
  measured knee test in `../results/`.
- The stack pins `WEB_CONCURRENCY=1` like prod: the in-memory WebSocket manager
  is not yet horizontally scalable (a documented blocker). Raising it is only
  valid for non-live-chat load experiments.
