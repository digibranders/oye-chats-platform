"""Pricing answer gate: pin every bot's pricing answers to one page.

A visitor asking "how much does it cost" was answered from whichever chunk won
retrieval, which on a bot with an old uploaded rate card meant a confidently
quoted stale price. This column lets an owner name the one page the bot may
price from.

``bots.pricing_url``
    The page a pricing answer must come from. Compared against
    ``documents.document_name`` after normalization (scheme, ``www.``, trailing
    slash, query and fragment are all dropped), so the URL an admin pastes and
    the URL the crawler stored compare equal.

There is deliberately no companion opt-in flag. The gate is unconditional and
platform-wide: every bot is gated on every pricing-intent turn, and this column
selects the SOURCE rather than whether the restriction applies. NULL is
therefore not "gate off", it is "no page I am allowed to price from", and such a
bot routes every pricing question to its team. That is the behaviour change this
migration ships, and it needs no data migration: NULL is the correct value for
every existing row.

No index: the column is read one row at a time, off a ``bots`` row already
loaded by primary key on every chat turn.

Revision ID: b1000003pricing
Revises: b1000002webhook
Create Date: 2026-09-04

"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "b1000003pricing"
down_revision: str | None = "b1000002webhook"
branch_labels: None = None
depends_on: None = None


def upgrade() -> None:
    op.add_column("bots", sa.Column("pricing_url", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("bots", "pricing_url")
