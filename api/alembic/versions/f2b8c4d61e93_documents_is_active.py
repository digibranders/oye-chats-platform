"""documents.is_active — deactivatable knowledge for paid→Free downgrades

Adds a boolean ``is_active`` to ``documents`` (default true, indexed). Retrieval
and listing queries scope to active chunks; a paid subscription lapsing to Free
flips a bot's chunks to false in bulk (reversibly) rather than deleting them.

Revision ID: f2b8c4d61e93
Revises: e7a4c2f19d80
Create Date: 2026-08-05
"""

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "f2b8c4d61e93"
down_revision = "e7a4c2f19d80"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # server_default='true' backfills every existing chunk as active, so the
    # column is immediately NOT NULL with no downtime and no behavior change.
    op.add_column(
        "documents",
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )
    op.create_index("ix_documents_is_active", "documents", ["is_active"])


def downgrade() -> None:
    op.drop_index("ix_documents_is_active", table_name="documents")
    op.drop_column("documents", "is_active")
