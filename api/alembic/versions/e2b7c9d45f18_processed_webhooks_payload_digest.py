"""processed_webhooks.payload_digest — replay dedup on the SIGNED body (M-2)

The Razorpay HMAC covers only the request BODY; the event id lives in a
header. A replayed signed body with a fresh header id therefore passes both
the signature check and the event-id dedup — and gets processed twice. The
sha256 of the raw body is a second unique key: distinct Razorpay events never
share an exact body (they embed unique payment/subscription ids and
timestamps), so a digest collision IS a replay. Nullable — legacy rows and
callers that don't pass a digest keep working; Postgres unique indexes admit
multiple NULLs.

Revision ID: e2b7c9d45f18
Revises: d9a4f7c31e85
Create Date: 2026-08-06
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "e2b7c9d45f18"
down_revision: str | Sequence[str] | None = "d9a4f7c31e85"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("processed_webhooks", sa.Column("payload_digest", sa.Text(), nullable=True))
    op.create_index(
        "uq_processed_webhooks_payload_digest",
        "processed_webhooks",
        ["payload_digest"],
        unique=True,
        postgresql_where=sa.text("payload_digest IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_processed_webhooks_payload_digest", table_name="processed_webhooks")
    op.drop_column("processed_webhooks", "payload_digest")
