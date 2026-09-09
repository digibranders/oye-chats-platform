"""Drop ``bots.qualification_flow``: a column nothing has ever written.

Repo-wide it appears exactly twice: the model declaration and the baseline
DDL. No reader, no writer, no serializer that would reach it by reflection, in
the API, the worker, the scripts, any of the five frontends, or the tests. It
was added for a guided-qualification flow that was never built, and it has sat
in every ``SELECT *`` and every schema dump since.

Reversible: ``downgrade`` puts the column back, nullable, which is exactly the
state it is in today. Nothing can have data to lose, because nothing writes it.

Revision ID: b1000010dropqualflow
Revises: b1000009pricingkb
Create Date: 2026-09-09

"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "b1000010dropqualflow"
down_revision: str | None = "b1000009pricingkb"
branch_labels: None = None
depends_on: None = None

# ``bots`` is read on every chat request; fail fast rather than queue reads
# behind a blocked ALTER.
_LOCK_TIMEOUT = "3s"


def upgrade() -> None:
    op.execute(f"SET lock_timeout = '{_LOCK_TIMEOUT}'")
    op.drop_column("bots", "qualification_flow")


def downgrade() -> None:
    op.execute(f"SET lock_timeout = '{_LOCK_TIMEOUT}'")
    op.add_column("bots", sa.Column("qualification_flow", postgresql.JSONB(astext_type=sa.Text()), nullable=True))
