"""launch promotions (time-boxed free-period offers)

Adds the ``promotions`` table — one row per acquisition campaign (e.g. "sign up
this month, 3 months free") — plus three columns on ``subscriptions`` that link
a subscription to the promo it was created under and drive the deferred-charge
free period:

* ``promotion_id``       — FK to the campaign (SET NULL on promo delete).
* ``promo_free_until``   — when the free period ends / first real charge lands.
* ``promo_reminder_sent``— idempotency log for promo reminder emails.

All additive and backfill-free: the new columns are nullable (or default '{}'),
so every existing subscription reads as "not on any promo", which is correct.

Revision ID: d3f1a9c07b21
Revises: a71d9f4e5c38
Create Date: 2026-08-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "d3f1a9c07b21"
down_revision: str | Sequence[str] | None = "a71d9f4e5c38"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "promotions",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("code", sa.String(), nullable=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column(
            "is_active",
            sa.Boolean(),
            server_default=sa.text("true"),
            nullable=False,
        ),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "free_cycles",
            sa.Integer(),
            server_default=sa.text("3"),
            nullable=False,
        ),
        sa.Column(
            "eligible_plan_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column("max_redemptions", sa.Integer(), nullable=True),
        sa.Column(
            "redeemed_count",
            sa.Integer(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=True,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=True,
        ),
        sa.CheckConstraint("ends_at > starts_at", name="ck_promotions_window_order"),
        sa.CheckConstraint("free_cycles > 0", name="ck_promotions_free_cycles_positive"),
        sa.CheckConstraint(
            "max_redemptions IS NULL OR max_redemptions > 0",
            name="ck_promotions_max_redemptions_positive",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_promotions_code",
        "promotions",
        ["code"],
        unique=True,
    )

    op.add_column(
        "subscriptions",
        sa.Column("promotion_id", sa.Integer(), nullable=True),
    )
    op.create_foreign_key(
        "fk_subscriptions_promotion_id",
        "subscriptions",
        "promotions",
        ["promotion_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column(
        "subscriptions",
        sa.Column("promo_free_until", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "subscriptions",
        sa.Column(
            "promo_reminder_sent",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default="{}",
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_constraint("fk_subscriptions_promotion_id", "subscriptions", type_="foreignkey")
    op.drop_column("subscriptions", "promo_reminder_sent")
    op.drop_column("subscriptions", "promo_free_until")
    op.drop_column("subscriptions", "promotion_id")
    op.drop_index("ix_promotions_code", table_name="promotions")
    op.drop_table("promotions")
