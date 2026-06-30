"""Merge the second pair of open heads.

After the earlier ``d8e9f1a2b3c4`` merge, two new platform-feedback
migrations (``b3c8d1e4f7a9`` resolution columns and ``c5e9a2b7d3f1``
taxonomy) landed off ``f2d4b6a8c0e1`` independently of that merge,
producing yet another fork at:

* ``d8e9f1a2b3c4`` (earlier mergepoint, crawl-unlimit + document-source)
* ``c5e9a2b7d3f1`` (feedback taxonomy, descends from f2d4b6a8c0e1 via
  the resolution migration)

The two branches touch entirely independent areas — plan JSONB and
``documents.source`` on one side, ``platform_feedback`` columns and
indexes on the other — so this empty merge migration simply re-unifies
the head graph so ``alembic upgrade head`` and ``alembic revision
--autogenerate`` are unambiguous again.

Revision ID: a4b6c8d0e2f3
Revises: d8e9f1a2b3c4, c5e9a2b7d3f1
Create Date: 2026-06-30
"""

revision = "a4b6c8d0e2f3"
down_revision = ("d8e9f1a2b3c4", "c5e9a2b7d3f1")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
