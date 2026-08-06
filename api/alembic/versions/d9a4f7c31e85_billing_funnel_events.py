"""billing_funnel_events — checkout-abandonment / payment-failure funnel signal (Wave 3.0)

The app detects a customer closing the Razorpay sheet (modal.ondismiss) and a
gateway decline (payment.failed), but neither left any operator-visible trace —
"who is hitting Pay and bailing at the payment sheet" was invisible. One row
per detected event, written fire-and-forget from the app; read by the
superadmin funnel view. Deliberately NOT a money table: no invariants hang off
it, rows are droppable, and losing one event loses telemetry, not rupees.

Revision ID: d9a4f7c31e85
Revises: c8f3e6b24a71
Create Date: 2026-08-06
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "d9a4f7c31e85"
down_revision: str | Sequence[str] | None = "c8f3e6b24a71"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "billing_funnel_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "client_id",
            sa.Integer(),
            sa.ForeignKey("clients.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("event", sa.String(length=24), nullable=False),
        sa.Column("surface", sa.String(length=12), nullable=False),
        sa.Column("meta", JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_billing_funnel_events_created_at", "billing_funnel_events", ["created_at"])
    op.create_index("ix_billing_funnel_events_client_id", "billing_funnel_events", ["client_id"])


def downgrade() -> None:
    op.drop_index("ix_billing_funnel_events_client_id", table_name="billing_funnel_events")
    op.drop_index("ix_billing_funnel_events_created_at", table_name="billing_funnel_events")
    op.drop_table("billing_funnel_events")
