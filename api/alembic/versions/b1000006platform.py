"""Remember what the customer's site is built on, for the Deploy page's picker.

The "What is your website built on?" dropdown reset to HTML on every visit, so
a customer on Next.js re-picked it every single time they opened Deploy. The
answer is stable for the life of a site and nothing was keeping it.

``bots.install_platform``
    A platform id from ``app/src/data/platformIntegrations.ts`` (``nextjs``,
    ``wordpress``, ...). NULL means nobody knows yet and the picker keeps its
    default.

``bots.install_platform_source``
    ``detected`` (the install probe fingerprinted the served HTML) or
    ``manual`` (the customer picked it). The probe never overwrites ``manual``:
    a wrong guess must not be able to take the customer's own answer away.

Both nullable with no default and no backfill. Every existing row starts at
"unknown", and fills itself on the next install probe or the next time someone
uses the dropdown, which is exactly the behaviour a new column should have.

Revision ID: b1000006platform
Revises: b1000005enrichon
Create Date: 2026-09-07

"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "b1000006platform"
down_revision: str | None = "b1000005enrichon"
branch_labels: None = None
depends_on: None = None


def upgrade() -> None:
    op.add_column("bots", sa.Column("install_platform", sa.String(length=24), nullable=True))
    op.add_column("bots", sa.Column("install_platform_source", sa.String(length=16), nullable=True))


def downgrade() -> None:
    op.drop_column("bots", "install_platform_source")
    op.drop_column("bots", "install_platform")
