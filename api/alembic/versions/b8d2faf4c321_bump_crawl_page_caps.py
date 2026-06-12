"""Bump per-plan ``max_crawl_pages`` to align with monthly credit budgets.

The initial crawl-limit migration (``a7c1e9f3b210``) set page caps that were
significantly tighter than what each tier's credit allowance could afford —
e.g. Starter (2,000 credits, 3 credits/page = ~666 pages of budget) was
locked at 300 pages, so customers could literally have spare credits and
still be blocked. That created a "why won't you let me pay you?" UX, which
is one of the worst possible upgrade triggers.

This migration raises the page cap to be **just above** the credit budget,
so credits remain the binding cost constraint while the page cap stays as
a workload-protection ceiling (subprocess timeout, lock duration, memory).

New values:

    free       →    100  (was   75) — slightly under credit budget of ~167
    starter    →    600  (was  300) — matches credit budget of ~666
    standard   →  1,500  (was  750) — well within credit budget of ~3,333
    enterprise → 10,000  (was 5,000) — true infra ceiling, not credit ceiling

Depth, JS cap, and concurrency are intentionally unchanged — those are
workload protections (combinatorial explosion, RAM, time budget) that
credits can't replicate.

Revision ID: b8d2faf4c321
Revises: a7c1e9f3b210
Create Date: 2026-06-11
"""

from alembic import op

revision = "b8d2faf4c321"
down_revision = "a7c1e9f3b210"
branch_labels = None
depends_on = None


# Old → new mapping. The downgrade restores the values from a7c1e9f3b210
# explicitly so we don't depend on that migration's constants being
# importable from this file (alembic discourages cross-revision imports).
_BUMP = {
    "free": {"old": 75, "new": 100},
    "starter": {"old": 300, "new": 600},
    "standard": {"old": 750, "new": 1500},
    "enterprise": {"old": 5000, "new": 10000},
}


def upgrade() -> None:
    """Patch ``max_crawl_pages`` only — leave every other limit key alone.

    Uses ``jsonb_set`` with the ``create_missing=true`` default so the patch
    works whether or not the key already exists, which keeps this idempotent
    against environments that hand-edited plan rows.
    """
    for slug, values in _BUMP.items():
        op.execute(
            f"""
            UPDATE plans
               SET limits = jsonb_set(
                       COALESCE(limits, '{{}}'::jsonb),
                       '{{max_crawl_pages}}',
                       to_jsonb({values["new"]}::int),
                       true
                   )
             WHERE slug = '{slug}'
            """
        )


def downgrade() -> None:
    """Restore the pre-bump page caps from migration a7c1e9f3b210."""
    for slug, values in _BUMP.items():
        op.execute(
            f"""
            UPDATE plans
               SET limits = jsonb_set(
                       COALESCE(limits, '{{}}'::jsonb),
                       '{{max_crawl_pages}}',
                       to_jsonb({values["old"]}::int),
                       true
                   )
             WHERE slug = '{slug}'
            """
        )
