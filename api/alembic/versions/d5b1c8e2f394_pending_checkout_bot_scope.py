"""Scope the in-flight checkout marker to the bot it funds

``clients.pending_checkout_*`` is now shared by BOTH first-mandate routes:
``POST /subscriptions/checkout`` and ``/subscriptions/change-plan`` Branch 3
(trial→paid, Free→paid, revive-in-place). Branch 3 can mint a BOT-scoped
mandate, so the reuse key needs the bot alongside the plan, cycle and country —
otherwise an account-level in-flight checkout could be handed back for a
per-agent purchase and the activation would attach the plan to the wrong
ledger.

Nullable with no backfill: NULL is exactly "account-level", which is what every
pre-existing marker was (only ``/checkout`` wrote them, and it only ever mints
account-level mandates).

Revision ID: d5b1c8e2f394
Revises: c9e2a4f7b1d3
Create Date: 2026-08-14
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d5b1c8e2f394"
down_revision: str | Sequence[str] | None = "c9e2a4f7b1d3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("clients", sa.Column("pending_checkout_bot_id", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("clients", "pending_checkout_bot_id")
