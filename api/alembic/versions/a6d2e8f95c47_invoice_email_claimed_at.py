"""invoices.email_claimed_at — crash-safe claim for the recovery email sweep

The M-5 fix claimed the send by stamping emailed_at BEFORE sending, which
converted the duplicate-email bug into something worse: a worker crash between
claim-commit and send (deploys restart the worker!) left emailed_at set with
no email delivered — invisible to the recovery sweep AND the emails_pending
alert, silently losing a legally required tax document. The claim now lives in
its own column: emailed_at goes back to meaning DELIVERED (stamped after the
send returns), and a stale claim (>1h) is re-swept.

Revision ID: a6d2e8f95c47
Revises: f4c8e1a72b96
Create Date: 2026-08-06
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a6d2e8f95c47"
down_revision: str | Sequence[str] | None = "f4c8e1a72b96"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("invoices", sa.Column("email_claimed_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("invoices", "email_claimed_at")
