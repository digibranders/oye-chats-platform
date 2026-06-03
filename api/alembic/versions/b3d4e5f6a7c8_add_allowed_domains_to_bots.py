"""Add allowed_domains + domain_check_enabled to bots for widget embed origin restriction.

When ``domain_check_enabled`` is true the backend rejects widget requests
(``X-Bot-Key``) whose ``Origin``/``Referer`` hostname does not match an entry
in ``allowed_domains``. Entries support exact hostnames (``acme.com``) and
wildcard subdomains (``*.acme.com``). The toggle defaults to ``false`` so
existing bots keep working until their owner opts in.

The data migration pre-populates ``allowed_domains`` from each bot's existing
``website`` value (hostname + ``*.hostname``) so the admin UI has sensible
defaults when the customer enables the check.

Revision ID: b3d4e5f6a7c8
Revises: a1b2c3d4e5f7
Create Date: 2026-06-03
"""

import json
from urllib.parse import urlparse

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "b3d4e5f6a7c8"
down_revision = "a1b2c3d4e5f7"
branch_labels = None
depends_on = None


def _hostname_from_website(raw: str | None) -> str | None:
    if not raw:
        return None
    value = raw.strip().lower()
    if not value:
        return None
    if "://" not in value:
        value = f"https://{value}"
    try:
        parsed = urlparse(value)
    except ValueError:
        return None
    host = (parsed.hostname or "").strip()
    if not host:
        return None
    if host.startswith("www."):
        host = host[4:]
    if not host or "." not in host:
        return None
    return host


def upgrade() -> None:
    op.add_column(
        "bots",
        sa.Column(
            "allowed_domains",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
    )
    op.add_column(
        "bots",
        sa.Column(
            "domain_check_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id, website FROM bots WHERE website IS NOT NULL")).fetchall()
    update_stmt = sa.text("UPDATE bots SET allowed_domains = CAST(:domains AS JSONB) WHERE id = :id")
    for row in rows:
        host = _hostname_from_website(row.website)
        if not host:
            continue
        bind.execute(update_stmt, {"domains": json.dumps([host, f"*.{host}"]), "id": row.id})


def downgrade() -> None:
    op.drop_column("bots", "domain_check_enabled")
    op.drop_column("bots", "allowed_domains")
