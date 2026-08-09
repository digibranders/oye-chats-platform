"""client notification preferences

Gives the workspace owner the same push opt-outs operators already had.
``send_push_to_client`` is a real delivery path (small teams run entirely off
the owner login), but ``Client`` had nowhere to record a preference, so the
owner could not mute anything.

Revision ID: d3a71b6c04e2
Revises: c8ed5bc1ce2a
Create Date: 2026-08-09

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d3a71b6c04e2"
down_revision: str | Sequence[str] | None = "c8ed5bc1ce2a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nullable with no server default: NULL means "never set", which the
    # evaluator reads as fully opted in — same convention as Operator.
    op.add_column(
        "clients",
        sa.Column("notification_preferences", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("clients", "notification_preferences")
