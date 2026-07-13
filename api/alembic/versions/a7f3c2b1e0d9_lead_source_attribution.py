"""Lead source attribution — durable UTM + visitor journey on LeadInfo, and
per-session ``visitor_journey`` capture on ChatSession.

Adds three nullable JSONB columns:

* ``chat_sessions.visitor_journey`` — list of ``{path, ts}`` entries recorded
  by the widget as the visitor navigates the host site before opening the
  chat. Complements the existing ``chat_sessions.utm_params`` (per-session
  UTM snapshot) and ``chat_sessions.page_url``/``referrer`` columns.

* ``lead_info.utm_params`` and ``lead_info.visitor_journey`` — copy of the
  parent session's attribution snapshot at the moment a lead is captured.
  Durable — persists even if the chat session is later pruned by retention
  policies. Populated only when the owning client is on a plan that has
  the "Lead Source Attribution" feature (Standard / Enterprise) — the
  copy is gated in ``chat_routes.lead_capture_endpoint``.

Migration policy
----------------
All three columns are ``nullable=True`` with no server default. Existing
rows read back as NULL (which the Leads API and CSV export treat as
"Direct / Organic" — no source information). No backfill: attribution
data for chats that already happened cannot be reconstructed, so we
start the ledger going forward.

Revision ID: a7f3c2b1e0d9
Revises: fec42d60624c
Create Date: 2026-07-09
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision = "a7f3c2b1e0d9"
down_revision = "fec42d60624c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "chat_sessions",
        sa.Column("visitor_journey", JSONB(), nullable=True),
    )
    op.add_column(
        "lead_info",
        sa.Column("utm_params", JSONB(), nullable=True),
    )
    op.add_column(
        "lead_info",
        sa.Column("visitor_journey", JSONB(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("lead_info", "visitor_journey")
    op.drop_column("lead_info", "utm_params")
    op.drop_column("chat_sessions", "visitor_journey")
