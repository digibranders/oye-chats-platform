"""lead_info: resolved company identity columns

Phase B of company intelligence. The resolution engine
(``company_profile_service`` + ``company_markup`` + ``domain_normalizer`` and
the cross-tenant ``company_profile`` cache) has been shipped and tested since
Phase A but was never called by anything — these columns are where its output
lands.

``lead_info.company`` keeps holding the raw registrable domain
("infosys.com"). It is not overwritten, for two reasons: it is free and always
available, so a failed or still-pending resolution degrades to the domain
rather than to nothing; and existing consumers — the leads list, CSV export,
outbound webhooks — already read that column and would silently change meaning.

Revision ID: d81b4e5c9a37
Revises: c3f7a91b2d84
Create Date: 2026-08-11

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import context, op

revision: str = "d81b4e5c9a37"
down_revision: str | Sequence[str] | None = "c3f7a91b2d84"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "lead_info"
NEW_COLUMNS: tuple[tuple[str, sa.types.TypeEngine], ...] = (
    ("company_name", sa.String()),
    ("company_description", sa.Text()),
    ("company_logo_url", sa.String()),
)


def _columns() -> set[str] | None:
    """Column names of ``lead_info``, or None in offline (``--sql``) mode.

    House standard (see ``1da557cae107``): without this guard
    ``alembic upgrade --sql`` raises ``NoInspectionAvailable`` on a
    MockConnection and DDL review is impossible. In offline mode the
    statements are emitted unconditionally, which is what a SQL script wants.
    """
    if context.is_offline_mode():
        return None
    return {c["name"] for c in sa.inspect(op.get_bind()).get_columns(TABLE)}


def upgrade() -> None:
    # ``Base.metadata.create_all()`` runs at app startup, so any environment
    # that has booted since the model landed already has these columns.
    existing = _columns()
    for name, type_ in NEW_COLUMNS:
        if existing is None or name not in existing:
            op.add_column(TABLE, sa.Column(name, type_, nullable=True))


def downgrade() -> None:
    """Drop the columns. Safe: every value is rebuildable.

    The data is a cache projection — ``company_profile`` still holds the
    resolved identity per domain, and each lead still has its ``company``
    domain to re-resolve from.
    """
    existing = _columns()
    for name, _type in reversed(NEW_COLUMNS):
        if existing is None or name in existing:
            op.drop_column(TABLE, name)
