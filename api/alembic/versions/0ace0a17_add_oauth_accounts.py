"""Add ``oauth_accounts`` table and relax ``clients.hashed_password`` to nullable.

Why:
* Google OAuth signup creates a Client without a password, so the password
  column can no longer be NOT NULL. Existing password rows are untouched.
* ``oauth_accounts`` stores the provider's stable subject id keyed by
  (provider, provider_user_id) so a returning user always finds the same
  Client even if their provider-side email later changes.

Indexes:
* ``ix_oauth_accounts_provider_subject`` (unique) — primary lookup at login.
* ``ix_oauth_accounts_client_provider`` (unique) — one row per (client,
  provider), keeps account-linking idempotent.

Revision ID: 0ace0a17
Revises: f3a4b5c6d7e8
Create Date: 2026-06-24
"""

import sqlalchemy as sa
from sqlalchemy import inspect

from alembic import op

# revision identifiers, used by Alembic.
revision = "0ace0a17"
down_revision = "f3a4b5c6d7e8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Relax NOT NULL on hashed_password — OAuth-only accounts have no password.
    op.alter_column(
        "clients",
        "hashed_password",
        existing_type=sa.String(),
        nullable=True,
    )

    # Idempotent table creation: an earlier rev-ID collision left half of
    # the schema applied on at least one dev DB. ``inspect`` lets us skip
    # cleanly without a Postgres ``IF NOT EXISTS`` clause that wouldn't
    # work for portable migrations.
    bind = op.get_bind()
    insp = inspect(bind)
    existing_tables = set(insp.get_table_names())

    if "oauth_accounts" not in existing_tables:
        op.create_table(
            "oauth_accounts",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column(
                "client_id",
                sa.Integer(),
                sa.ForeignKey("clients.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("provider", sa.String(), nullable=False),
            sa.Column("provider_user_id", sa.String(), nullable=False),
            sa.Column("email", sa.String(), nullable=True),
            sa.Column("picture_url", sa.Text(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.text("now()"),
                nullable=False,
            ),
            sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True),
        )

    existing_indexes = (
        {idx["name"] for idx in insp.get_indexes("oauth_accounts")} if "oauth_accounts" in existing_tables else set()
    )

    if "ix_oauth_accounts_client_id" not in existing_indexes:
        op.create_index(
            "ix_oauth_accounts_client_id",
            "oauth_accounts",
            ["client_id"],
            unique=False,
        )
    if "ix_oauth_accounts_provider_subject" not in existing_indexes:
        op.create_index(
            "ix_oauth_accounts_provider_subject",
            "oauth_accounts",
            ["provider", "provider_user_id"],
            unique=True,
        )
    if "ix_oauth_accounts_client_provider" not in existing_indexes:
        op.create_index(
            "ix_oauth_accounts_client_provider",
            "oauth_accounts",
            ["client_id", "provider"],
            unique=True,
        )


def downgrade() -> None:
    op.drop_index("ix_oauth_accounts_client_provider", table_name="oauth_accounts")
    op.drop_index("ix_oauth_accounts_provider_subject", table_name="oauth_accounts")
    op.drop_index("ix_oauth_accounts_client_id", table_name="oauth_accounts")
    op.drop_table("oauth_accounts")

    # NOTE: We cannot re-tighten ``hashed_password`` to NOT NULL without
    # first verifying every row has a password — by definition, downgrading
    # past this migration with OAuth-only Clients in the table would fail.
    # Restoring the constraint is therefore a manual ops step; this
    # downgrade only undoes the additive change.
    op.alter_column(
        "clients",
        "hashed_password",
        existing_type=sa.String(),
        nullable=True,
    )
