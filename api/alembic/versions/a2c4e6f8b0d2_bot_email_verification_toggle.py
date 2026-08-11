"""Add bots.email_verification_enabled (per-agent opt-in)

Customer-facing toggle (AI Agent → Advanced) that gates the metered Reoon email
verification. Off by default: an agent never spends credits on verification
until the customer turns it on, and it still requires a Standard/Professional
plan and the super-admin ``feature.email_verification_enabled`` switch.

Idempotent: skips the ADD COLUMN when the column already exists (e.g. a dev DB
where ``Base.metadata.create_all`` built the table with the model column).

Revision ID: a2c4e6f8b0d2
Revises: f5a1c2b3d4e6
Create Date: 2026-08-10

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "a2c4e6f8b0d2"
down_revision: str | Sequence[str] | None = "f5a1c2b3d4e6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "bots"
COLUMN = "email_verification_enabled"


def _has_column() -> bool:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    return COLUMN in {c["name"] for c in insp.get_columns(TABLE)}


def upgrade() -> None:
    if _has_column():
        return
    op.add_column(
        TABLE,
        sa.Column(
            COLUMN,
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    if not _has_column():
        return
    op.drop_column(TABLE, COLUMN)
