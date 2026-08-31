"""addon_plan_cache generalises seat_plan_cache

The on-demand mint introduced in 6af9910c242d applied only to operator seats.
The branding-removal add-on has the same shape and the same problem: a plan id
pinned in the environment, a Razorpay plan whose amount IS the debit, and no way
to change the price without minting by hand and repointing the variable in the
same breath.

Rather than pin two more ids (and a USD twin for each), the cache becomes
add-on agnostic. ``addon_kind`` joins the unique key because a seat and a
branding removal can cost the same amount, and the plan's item name is what the
customer reads on the checkout sheet — a shared row would tell someone buying
branding removal they were paying for an operator seat.

Rewritten rather than migrated in place: both databases hold zero rows (no
add-on has ever been minted through the cache), so there is nothing to preserve
and a drop/create is honest about that. Were there rows, this would need an
``ALTER TABLE ... ADD COLUMN addon_kind DEFAULT 'seat'`` and a constraint swap.

Revision ID: 7b1c4e2af903
Revises: 6af9910c242d
Create Date: 2026-08-31
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "7b1c4e2af903"
down_revision: str | Sequence[str] | None = "6af9910c242d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _create_addon_table() -> None:
    op.create_table(
        "addon_plan_cache",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        # Which add-on this plan bills: 'seat', 'branding'.
        sa.Column("addon_kind", sa.String(length=32), nullable=False),
        sa.Column("currency", sa.String(length=3), server_default="INR", nullable=False),
        # Minor units in `currency`, GST INCLUSIVE — what Razorpay debits.
        sa.Column("amount_minor", sa.Integer(), nullable=False),
        sa.Column("razorpay_plan_id", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("addon_kind", "currency", "amount_minor", name="uq_addon_plan_amount"),
        sa.CheckConstraint("amount_minor > 0", name="chk_addon_plan_amount_positive"),
    )


def upgrade() -> None:
    """Upgrade schema."""
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "seat_plan_cache" in tables:
        # Empty by construction; see the module docstring.
        op.drop_table("seat_plan_cache")
    if "addon_plan_cache" not in tables:
        _create_addon_table()


def downgrade() -> None:
    """Downgrade schema.

    Restores the seat-only shape. Any branding rows are lost, which costs
    nothing beyond a re-mint: the next branding checkout creates a fresh plan
    for the same amount, and existing mandates reference their plan directly
    and never read this table.
    """
    op.drop_table("addon_plan_cache")
    op.create_table(
        "seat_plan_cache",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("currency", sa.String(length=3), server_default="INR", nullable=False),
        sa.Column("amount_minor", sa.Integer(), nullable=False),
        sa.Column("razorpay_plan_id", sa.String(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=True,
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("currency", "amount_minor", name="uq_seat_plan_amount"),
        sa.CheckConstraint("amount_minor > 0", name="chk_seat_plan_amount_positive"),
    )
