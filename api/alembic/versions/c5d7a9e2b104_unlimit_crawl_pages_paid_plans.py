"""Unlimit max_crawl_pages on paid plans (Starter, Standard).

Crawling on paid tiers is now metered purely by credits: each page
ingested deducts ``credit_cost.url_scan`` (5 credits) from the
client's monthly grant + top-ups, with no per-crawl page ceiling
imposed by the plan itself. The plan's ``limits.max_crawl_pages``
field on Starter and Standard is therefore set to the UNLIMITED
sentinel (-1) — the route layer treats this as "no plan cap" and
derives the effective ceiling from the caller's available credit
balance (clamped to a generous safety bound to prevent runaway
crawls from a misclicked button).

The Free plan keeps its concrete ``max_crawl_pages: 20`` ceiling
because Free is the only tier whose page count is gated by the
plan rather than by credits — 20 pages × 5 credits = 100 credits,
which sits below the 200-credit monthly Free allowance, so the
cap is the practically-binding gate.

Enterprise is left untouched in this migration; its existing
10000-page ceiling stays as a safety bound while contract terms
continue to govern actual usage.

Revision ID: c5d7a9e2b104
Revises: a1b2f9d0c4e8
Create Date: 2026-06-30
"""

import sqlalchemy as sa

from alembic import op

revision = "c5d7a9e2b104"
down_revision = "a1b2f9d0c4e8"
branch_labels = None
depends_on = None


# Snapshot of the pre-migration cap so downgrade() can restore them
# without us having to inspect production data live.
_PRE_MIGRATION_CAPS = {
    "starter": 300,
    "standard": 1200,
}

UNLIMITED = -1


def _patch_limit(conn, slug: str, max_crawl_pages: int) -> None:
    """Set ``limits.max_crawl_pages`` for the named plan, in place.

    Uses ``jsonb_set`` so other keys in the JSONB blob (credits, depth,
    feature flags written by sibling migrations) are preserved verbatim.
    The cast on the value is required because ``jsonb_set`` expects a
    JSONB scalar, not a SQL integer.
    """
    conn.execute(
        sa.text(
            """
            UPDATE plans
               SET limits = jsonb_set(
                       COALESCE(limits, '{}'::jsonb),
                       '{max_crawl_pages}',
                       to_jsonb(CAST(:val AS INTEGER)),
                       true
                   )
             WHERE slug = :slug
            """
        ),
        {"slug": slug, "val": int(max_crawl_pages)},
    )


def upgrade() -> None:
    conn = op.get_bind()
    for slug in ("starter", "standard"):
        _patch_limit(conn, slug, UNLIMITED)


def downgrade() -> None:
    conn = op.get_bind()
    for slug, cap in _PRE_MIGRATION_CAPS.items():
        _patch_limit(conn, slug, cap)
