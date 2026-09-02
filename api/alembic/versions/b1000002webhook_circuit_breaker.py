"""Webhook circuit breaker: record why and when an endpoint was auto-disabled.

``_MAX_RETRIES`` bounded retries per EVENT only, and nothing ever flipped
``webhooks.is_active``. An endpoint dead for a week still received five attempts
for every event a busy bot produced, forever. The breaker disables a webhook
after ten consecutive exhausted deliveries with no success in between.

``webhooks.disabled_reason``
    Human-readable cause, shown to the customer so a silently dead integration
    is explained rather than merely switched off.

``webhooks.disabled_at``
    When the breaker tripped. Load-bearing rather than decorative: the streak
    query only counts deliveries recorded AFTER this timestamp, so a webhook the
    customer re-enables gets a fresh ten-strike window instead of being tripped
    again by the very failures that disabled it.

The streak itself is derived from ``webhook_deliveries`` rather than kept in a
counter column, so this revision adds two nullable columns and nothing else. No
index: the query is keyed on ``webhook_deliveries.webhook_id``, which is already
indexed, and these two columns are only ever read one row at a time.

Revision ID: b1000002webhook
Revises: b1000001coupon
Create Date: 2026-09-02

"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "b1000002webhook"
down_revision: str | None = "b1000001coupon"
branch_labels: None = None
depends_on: None = None


def upgrade() -> None:
    op.add_column("webhooks", sa.Column("disabled_reason", sa.Text(), nullable=True))
    op.add_column("webhooks", sa.Column("disabled_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("webhooks", "disabled_at")
    op.drop_column("webhooks", "disabled_reason")
