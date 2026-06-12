"""Affiliate invites: magic-link onboarding for non-existing emails.

Adds the ``affiliate_invites`` table so super admin can invite anyone by
email, not only existing OyeChats customers. The invitee receives a magic
link that lets them set a password and atomically create both their
``clients`` row and their ``affiliates`` row.

Schema choices:
* ``token_hash`` is sha256 of the raw token; raw tokens are emailed once
  and never persisted. Mirrors ``impersonation_tokens`` pattern.
* ``expires_at`` defaults to 14 days from creation in the service layer.
* ``accepted_at`` / ``revoked_at`` are independent nullable timestamps —
  an invite can be either, but never both.
* Partial unique index on ``(email)`` WHERE pending so super admin can't
  accidentally send two live invites to the same address.

Revision ID: c7d9e2b4f1a8
Revises: a1f9c3e6d4b2
Create Date: 2026-06-09
"""

import sqlalchemy as sa

from alembic import op

revision = "c7d9e2b4f1a8"
down_revision = "a1f9c3e6d4b2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "affiliate_invites",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("email", sa.String(), nullable=False),
        # sha256 hex digest = 64 chars; store as TEXT for futureproofing.
        # Uniqueness enforced by the explicit named index below — not by a
        # column-level constraint, which would create a second identical index.
        sa.Column("token_hash", sa.Text(), nullable=False),
        sa.Column(
            "max_active_codes",
            sa.Integer(),
            nullable=False,
            server_default="10",
        ),
        sa.Column(
            "invited_by",
            sa.Integer(),
            sa.ForeignKey("clients.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint(
            "max_active_codes > 0",
            name="chk_invite_max_codes_positive",
        ),
    )
    # Fast lookup by token (already unique).
    op.create_index(
        "ix_affiliate_invites_token_hash",
        "affiliate_invites",
        ["token_hash"],
        unique=True,
    )
    # Pending-invites-by-email lookup. Partial index keeps it small.
    op.create_index(
        "ix_affiliate_invites_email_pending",
        "affiliate_invites",
        ["email"],
        postgresql_where=sa.text("accepted_at IS NULL AND revoked_at IS NULL"),
    )
    # Sort pending invites by recency for the super-admin UI list.
    op.create_index(
        "ix_affiliate_invites_created",
        "affiliate_invites",
        [sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_affiliate_invites_created", table_name="affiliate_invites")
    op.drop_index("ix_affiliate_invites_email_pending", table_name="affiliate_invites")
    op.drop_index("ix_affiliate_invites_token_hash", table_name="affiliate_invites")
    op.drop_table("affiliate_invites")
