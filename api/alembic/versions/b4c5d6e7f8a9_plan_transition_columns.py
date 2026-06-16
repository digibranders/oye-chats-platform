"""Add scheduled-change + upgrade-proration columns to subscriptions.

Adds the columns the new paid→paid Razorpay transition flow needs:

  * ``scheduled_plan_id``         — Plan FK; non-null while a downgrade is
                                    queued for cutover at ``current_period_end``.
  * ``scheduled_billing_cycle``   — billing cycle the scheduled plan kicks in on.
  * ``scheduled_change_at``       — when the queued change should fire (mirrors
                                    ``current_period_end`` at queue time so the
                                    cron has an independent index it can scan).
  * ``upgrade_credit_pending_cents`` — proration credit (in plan-currency cents)
                                       to apply as a credit-ledger top-up once
                                       the new subscription's first ``activated``
                                       webhook clears.
  * ``prev_razorpay_subscription_id`` — points the new local row at the gateway
                                        subscription it replaced so the activation
                                        handler recognises a transition vs. a
                                        first-time signup.

Backfill is unnecessary — the columns default to NULL / 0 and only get written
by the new transition flow. The partial-unique index on (client_id, status)
is unaffected because we never mark two rows ``active|trialing|past_due`` at
the same time during a transition.

Revision ID: b4c5d6e7f8a9
Revises: a3b4c5d6e7f8
Create Date: 2026-06-16
"""

import sqlalchemy as sa

from alembic import op

revision = "b4c5d6e7f8a9"
down_revision = "a3b4c5d6e7f8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "subscriptions",
        sa.Column("scheduled_plan_id", sa.Integer(), nullable=True),
    )
    op.add_column(
        "subscriptions",
        sa.Column("scheduled_billing_cycle", sa.String(length=16), nullable=True),
    )
    op.add_column(
        "subscriptions",
        sa.Column("scheduled_change_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "subscriptions",
        sa.Column(
            "upgrade_credit_pending_cents",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "subscriptions",
        sa.Column("prev_razorpay_subscription_id", sa.String(), nullable=True),
    )
    op.create_foreign_key(
        "fk_subscriptions_scheduled_plan",
        source_table="subscriptions",
        referent_table="plans",
        local_cols=["scheduled_plan_id"],
        remote_cols=["id"],
        ondelete="SET NULL",
    )
    # Index lets the cron safety net find queued changes whose cutover time
    # has passed without scanning the full subscriptions table.
    op.create_index(
        "ix_subscriptions_scheduled_change_at",
        "subscriptions",
        ["scheduled_change_at"],
        postgresql_where=sa.text("scheduled_change_at IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_subscriptions_scheduled_change_at",
        table_name="subscriptions",
    )
    op.drop_constraint(
        "fk_subscriptions_scheduled_plan",
        "subscriptions",
        type_="foreignkey",
    )
    op.drop_column("subscriptions", "prev_razorpay_subscription_id")
    op.drop_column("subscriptions", "upgrade_credit_pending_cents")
    op.drop_column("subscriptions", "scheduled_change_at")
    op.drop_column("subscriptions", "scheduled_billing_cycle")
    op.drop_column("subscriptions", "scheduled_plan_id")
