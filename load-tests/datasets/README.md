# Test data strategy

Deterministic, isolated, disposable seed data — **never real customer data**. All
seeders refuse any DB whose name doesn't contain `loadtest` (override: `FORCE_SEED=1`).

## Fixtures — `seed_fixtures.py`
Creates the minimum a chat load test needs, idempotently:
- 1 client (test admin) with a fixed `api_key`
- 1 bot with a fixed `bot_key`
- 1 **active** subscription (so the chat subscription-gate passes)
- `PricingConfig credit_cost.ai_chat = 0` (chat needs no credit grants)
- 1 operator
- N KB documents with deterministic pseudo-embeddings (so hybrid retrieval runs)
- **Warm sessions** (`--warm`): sessions with a stored lead name so every turn
  runs the full RAG/LLM path instead of the first-turn name-ask short-circuit.

```bash
DB_URL=postgresql://localhost:5432/oyechats_loadtest \
  ../api/.venv/bin/python seed_fixtures.py --docs 50 --warm 120
```
Non-secret fixed credentials (valid only in the test DB, safe to print):
`bot_key=bot-loadtest-000000`, `api_key=lt_admin_key_deterministic_0001`,
`operator_key=lt_operator_key_deterministic_0001`.

## Scale data — `seed_scale.py`
Bulk-fills `chat_sessions` + `chat_messages` for DB-scale benchmarking
(15 messages/session, `created_at` spread over 90 days, runs `ANALYZE`).
```bash
DB_URL=postgresql://localhost:5432/oyechats_loadtest \
  ../api/.venv/bin/python seed_scale.py --messages 1000000
```

## Dataset size profiles
| Profile | `--docs` | `--warm` | `seed_scale --messages` | Purpose |
|---|---|---|---|---|
| **small** | 50 | 120 | 0 | knee/concurrency test (default) |
| **medium** | 200 | 300 | 100000 | dashboard/analytics + 100K DB scale |
| **large** | 500 | 600 | 1000000 | 1M-row DB degradation + high concurrency |

`--warm` must be ≥ the max chat concurrency you plan to drive (each VU needs its
own warm session). The mock's deterministic embeddings mean retrieval results are
stable across runs, so benchmarks are repeatable.

## Cleanup
Test sessions/messages are prefixed (`session_warm_*`, `session_scale_*`) for easy
removal, or drop the whole DB: `bash ../runner/stop-mock-stack.sh --drop-db`.
