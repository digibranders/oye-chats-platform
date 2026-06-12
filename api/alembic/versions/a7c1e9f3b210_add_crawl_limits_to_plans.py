"""Add per-plan crawl limits (pages, depth, JS cap, concurrency).

Different tiers should be allowed to crawl different amounts. Today every
client hits the hardcoded 100-page ceiling in ``crawler_service.crawl_website``
and the env-driven ``MAX_CRAWL_PAGES_JS=25`` cap for JS sites — so even paid
customers get the same crawl as the free tier.

This migration adds four new keys to each plan's ``limits`` JSONB blob:

- ``max_crawl_pages``       — hard ceiling on pages ingested per crawl
- ``max_crawl_depth``       — BFS depth bound (queue-level, not just filter)
- ``max_crawl_js_pages``    — page cap when Chromium is used (memory guard)
- ``max_crawl_concurrency`` — parallel HTTP fetches per crawl

The schema is unchanged — JSONB lets new keys land as a data-only update,
so a downgrade is a clean key-strip and existing rows that already shipped
to prod (with no crawl limit keys) keep working until upgrade runs.

Plan tiers (locked with product):
  free       →  75 pages · depth 3 · JS cap  25 · concurrency 3
  starter    → 300 pages · depth 4 · JS cap 100 · concurrency 5
  standard   → 750 pages · depth 4 · JS cap 200 · concurrency 5
  enterprise → 5000 pages · depth 5 · JS cap 500 · concurrency 8

Revision ID: a7c1e9f3b210
Revises: d5e6f7a8b9c0
Create Date: 2026-06-11
"""

from alembic import op

revision = "a7c1e9f3b210"
down_revision = "d5e6f7a8b9c0"
branch_labels = None
depends_on = None


# Locked tier values. Centralized here so the migration and the rollback
# read from the same source — and so a future tier tweak is a single-line
# diff in a fresh migration rather than two scattered updates.
_PLAN_LIMITS: dict[str, dict[str, int]] = {
    "free": {
        "max_crawl_pages": 75,
        "max_crawl_depth": 3,
        "max_crawl_js_pages": 25,
        "max_crawl_concurrency": 3,
    },
    "starter": {
        "max_crawl_pages": 300,
        "max_crawl_depth": 4,
        "max_crawl_js_pages": 100,
        "max_crawl_concurrency": 5,
    },
    "standard": {
        "max_crawl_pages": 750,
        "max_crawl_depth": 4,
        "max_crawl_js_pages": 200,
        "max_crawl_concurrency": 5,
    },
    "enterprise": {
        "max_crawl_pages": 5000,
        "max_crawl_depth": 5,
        "max_crawl_js_pages": 500,
        "max_crawl_concurrency": 8,
    },
}

# Keys to strip on downgrade. Pinned to the exact set this migration writes
# so a downgrade never deletes an unrelated limit key that a later migration
# added under the same JSONB column.
_LIMIT_KEYS = (
    "max_crawl_pages",
    "max_crawl_depth",
    "max_crawl_js_pages",
    "max_crawl_concurrency",
)


def upgrade() -> None:
    """Merge crawl limit keys into each known plan's ``limits`` JSONB.

    ``||`` on JSONB is a right-biased merge — re-running the migration is a
    no-op for plans that already have the new keys, which makes this safe
    against accidental double-execution and against environments that have
    already been hand-patched.
    """
    for slug, limits in _PLAN_LIMITS.items():
        # Build the patch as a JSONB literal. Values are ints so json.dumps
        # would also work, but inlining as a SQL-side jsonb_build_object keeps
        # us from having to escape anything inside the f-string.
        patch_pairs = ", ".join(f"'{k}', {v}" for k, v in limits.items())
        op.execute(
            f"""
            UPDATE plans
               SET limits = COALESCE(limits, '{{}}'::jsonb)
                          || jsonb_build_object({patch_pairs})
             WHERE slug = '{slug}'
            """
        )


def downgrade() -> None:
    """Strip exactly the four crawl-limit keys this migration introduced.

    Leaves every other limit key intact. We use ``-`` over a key list rather
    than rewriting the whole JSONB so a partially-hand-edited row keeps its
    other customizations.
    """
    for slug in _PLAN_LIMITS:
        for key in _LIMIT_KEYS:
            op.execute(
                f"""
                UPDATE plans
                   SET limits = limits - '{key}'
                 WHERE slug = '{slug}'
                """
            )
