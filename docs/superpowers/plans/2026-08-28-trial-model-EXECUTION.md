# Execution log, plan-less 14-day trial

Plan: `docs/superpowers/plans/2026-08-28-trial-model.md`
Branch: `claude/trial-model-14d`, cut from `development` at `8192e408`.

## Environment

| Item | Value |
|---|---|
| Postgres | 16 (Ubuntu cluster `16/main`), `postgresql-16-pgvector` 0.6.0 installed from apt |
| `DB_URL` | `postgresql://postgres:postgres@localhost:5432/oyechats` |
| Extensions | `vector` and `citext` created by the `pg_engine` fixture on `oyechats_pytest` |
| Harness proof | `uv run pytest tests/test_activation_events.py -q --no-cov` reported **6 passed**, zero skipped |
| Frontend | `npm ci` in `app/` |

Every backend figure below is a run with `DB_URL` exported, so DB-backed tests
execute rather than skip. Where a number of skips is reported it is named.

Baseline established after Task 1 with the whole suite: **5869 passed, 4 skipped**
(5873 collected).

## Task log

### Task 1, `plans.is_public`

Status: **done**.

Failing test first (`tests/test_trial_signup_defaults.py`), verified failing with
exactly the error the plan predicted, `TypeError: 'is_public' is an invalid
keyword argument for Plan`. Then the column on `Plan`, migration
`l6a7b8c9d0e1` chained off the single head `k5f6a7b8c9d0` (confirmed with
`alembic heads`, not assumed), the `is_public` filter in
`plan_service.get_active_plans`, and the purchase guard on all three plan
resolution sites: `/checkout/quote`, `/checkout` and `/change-plan`.

Deviation, recorded rather than improvised: ten tests in
`tests/test_change_plan_unlimited_agent_guard.py` failed after the guard landed.
Cause is not the guard. That file builds `Plan` objects that are never flushed,
so SQLAlchemy column defaults never fire and `is_public` reads `None`. The file
already passes `is_active=True` explicitly for exactly this reason, so the fix
follows its own convention: `_plan` now also passes `is_public=True`. Production
rows cannot take this shape, the column is `NOT NULL` with a server default.

Gates: two new tests pass. `-k "plan_service or pricing_catalog or
checkout_quote"` 9 passed. `-k "plan or checkout or subscription"` 647 passed.
Whole suite 5869 passed, 4 skipped. `ruff check` clean, `ruff format --check`
clean (642 files).
