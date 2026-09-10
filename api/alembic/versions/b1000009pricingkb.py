"""Let an owner answer pricing from the knowledge base.

``bots.pricing_from_knowledge_base``, default false. False is what every
existing bot keeps and it is the behaviour they have today: pricing questions
are answered only from ``pricing_url``'s own chunks, or escalated to the team.
True says "my prices live in my documents", which is the case for every
customer whose price list is an uploaded PDF rather than a public pricing page;
those bots were escalating every pricing question while holding the answer.

Not nullable, with a server default, so a row inserted by an older worker mid
deploy still reads as gated rather than as NULL.

Revision ID: b1000009pricingkb
Revises: b1000008recalibrate
Create Date: 2026-09-09

"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "b1000009pricingkb"
down_revision: str | None = "b1000008recalibrate"
branch_labels: None = None
depends_on: None = None


def upgrade() -> None:
    op.add_column(
        "bots",
        sa.Column("pricing_from_knowledge_base", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("bots", "pricing_from_knowledge_base")
