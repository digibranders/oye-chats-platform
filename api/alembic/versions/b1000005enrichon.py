"""Lead enrichment defaults ON: email verification and the company lookup.

``bots.email_verification_enabled`` and ``bots.company_lookup_enabled`` are the
customer's own switch on two metered enrichments. They have flipped twice: ON
at first (``c3f7a91b2d84``), then OFF (``b3d9f1a7c2e5``) on the theory that a
paid feature must be an explicit opt-in. The discoverability cost of OFF turned
out to be real: a customer on a plan that includes enrichment saw nothing
happen until they found the tab. The plan gate and the super-admin kill switch
still decide who can spend at all; the toggle is how a customer who does not
want the credits spent turns either off.

Two changes, both deliberate:

* The column default becomes ``true``, so every chatbot created from here on
  starts with both switched on. The ORM default in ``models.py`` moves with it.
* Every existing row is set to ``true`` too. Every current account is a test
  account, and the ask was "on by default for all"; a customer who wants either
  off turns it off on Experience > Leads, exactly as before.

``downgrade`` restores the ``false`` default only. It does not flip rows back:
by then some will have been switched off by hand, and a downgrade cannot tell
those apart from the ones this migration switched on.

Revision ID: b1000005enrichon
Revises: b1000004embedprof
Create Date: 2026-09-08

"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "b1000005enrichon"
down_revision: str | None = "b1000004embedprof"
branch_labels: None = None
depends_on: None = None

_COLUMNS = ("email_verification_enabled", "company_lookup_enabled")


def upgrade() -> None:
    for column in _COLUMNS:
        op.alter_column("bots", column, existing_type=sa.Boolean(), server_default=sa.text("true"))
        op.execute(sa.text(f"UPDATE bots SET {column} = true WHERE {column} = false"))


def downgrade() -> None:
    for column in _COLUMNS:
        op.alter_column("bots", column, existing_type=sa.Boolean(), server_default=sa.text("false"))
