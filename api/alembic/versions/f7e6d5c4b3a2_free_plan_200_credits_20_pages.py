"""Reduce Free plan to 200 credits/month and 20 page-crawl limit.

Changes (Free plan row only):
  * credits_per_month    : 250 → 200
  * limits.credits       : 250 → 200
  * limits.page_scraping : 30  → 20
  * limits.max_crawl_pages: 100 → 20  (per-crawl ceiling matches monthly cap)

All other plans and all other limit keys are left untouched.

Revision ID: f7e6d5c4b3a2
Revises: d9e3c1b7a4f2
Create Date: 2026-06-25
"""

from alembic import op

revision = "f7e6d5c4b3a2"
down_revision = "d9e3c1b7a4f2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE plans
           SET credits_per_month = 200,
               limits = limits
                        || '{"credits": 200}'::jsonb
                        || '{"page_scraping": 20}'::jsonb
                        || '{"max_crawl_pages": 20}'::jsonb
         WHERE slug = 'free'
        """
    )


def downgrade() -> None:
    op.execute(
        """
        UPDATE plans
           SET credits_per_month = 250,
               limits = limits
                        || '{"credits": 250}'::jsonb
                        || '{"page_scraping": 30}'::jsonb
                        || '{"max_crawl_pages": 100}'::jsonb
         WHERE slug = 'free'
        """
    )
