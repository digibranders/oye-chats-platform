"""subscription gateway cancel executed at

Adds ``subscriptions.gateway_cancel_executed_at`` — when the IRREVERSIBLE
Razorpay cancel was actually issued for a row.

``cancel_at_period_end`` used to be inseparable from the gateway cancel:
``/subscriptions/cancel`` called ``rzp.subscription.cancel(cancel_at_cycle_end=1)``
before flipping the flag, so a customer who changed their mind a day later
could not be un-cancelled (Razorpay has no un-cancel API) and had to buy a
whole new mandate. The flag now records reversible customer INTENT and this
column records the gateway FACT; the two are separated by
``task_execute_pending_cancellations``, which issues the real cancel a couple
of days before ``current_period_end``.

BACKFILL (load-bearing): every row that already has ``cancel_at_period_end``
was cancelled at Razorpay under the old code, so it must NOT read as "mandate
still live". Leaving these NULL would make ``/subscriptions/resume`` clear the
flag against a dead mandate and the customer would churn involuntarily on their
renewal date with the UI promising the opposite. ``canceled_at`` is the moment
the old ``/cancel`` issued the gateway call, so it is the accurate stamp;
``now()`` covers the handful of legacy rows where it was never written.

Revision ID: d8a4c1e07b62
Revises: a71d9f4e5c38
Create Date: 2026-08-05
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d8a4c1e07b62"
down_revision: str | Sequence[str] | None = "a71d9f4e5c38"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "subscriptions",
        sa.Column("gateway_cancel_executed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute(
        """
        UPDATE subscriptions
           SET gateway_cancel_executed_at = COALESCE(canceled_at, now())
         WHERE cancel_at_period_end IS TRUE
        """
    )


def downgrade() -> None:
    op.drop_column("subscriptions", "gateway_cancel_executed_at")
