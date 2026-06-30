"""Merge two open alembic heads.

The repo accumulated two unmerged heads:

* ``f2d4b6a8c0e1`` — ``document_source_column`` (descends from the
  ``e1c3a5f7b9d2`` referral-caps chain).
* ``c5d7a9e2b104`` — ``unlimit_crawl_pages_paid_plans`` (descends from
  the main ``a1b2f9d0c4e8`` merge head).

The two branches touch completely independent areas (one rebuilds
``documents.source``, the other patches the ``plans.limits`` JSONB), so
no schema or data conflicts. This empty merge migration unifies them so
``alembic upgrade head`` is unambiguous again and the next sibling
migration has a single parent to chain off.

Revision ID: d8e9f1a2b3c4
Revises: f2d4b6a8c0e1, c5d7a9e2b104
Create Date: 2026-06-30
"""

revision = "d8e9f1a2b3c4"
down_revision = ("f2d4b6a8c0e1", "c5d7a9e2b104")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
