"""Lower Standard and Starter ``max_crawl_concurrency`` from 5 to 3.

Cleanstart-style sites (Webflow + Cloudflare) throttle bursts at concurrency 5,
causing silent drops where 1 in 4 page fetches return empty bodies. Production
crawls of those domains were landing ~70% of sitemap URLs instead of the
~95%+ we get at concurrency 3 (verified end-to-end against cleanstart.com).

Concurrency 3 is the public-web safe default: fast enough that crawl wall-time
is still bounded by per-page latency, slow enough that CDN bot-protection
rarely triggers. Free was already at 3. Enterprise stays at 8 — those
customers typically crawl their own infrastructure where throttle headroom
is high, and they explicitly pay for the faster wall-time.

Revision ID: c3a4b5d6e7f8
Revises: b8d2faf4c321
Create Date: 2026-06-12
"""

from alembic import op

revision = "c3a4b5d6e7f8"
down_revision = "b8d2faf4c321"
branch_labels = None
depends_on = None


_AFFECTED_SLUGS = ("standard", "starter")


def upgrade() -> None:
    for slug in _AFFECTED_SLUGS:
        op.execute(
            f"""
            UPDATE plans
               SET limits = jsonb_set(
                       COALESCE(limits, '{{}}'::jsonb),
                       '{{max_crawl_concurrency}}',
                       to_jsonb(3::int),
                       true
                   )
             WHERE slug = '{slug}'
            """
        )


def downgrade() -> None:
    for slug in _AFFECTED_SLUGS:
        op.execute(
            f"""
            UPDATE plans
               SET limits = jsonb_set(
                       COALESCE(limits, '{{}}'::jsonb),
                       '{{max_crawl_concurrency}}',
                       to_jsonb(5::int),
                       true
                   )
             WHERE slug = '{slug}'
            """
        )
