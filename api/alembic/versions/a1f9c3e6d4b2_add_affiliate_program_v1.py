"""Affiliate program v1: invite-only referral codes + click tracking.

Adds the v1 (money-free) affiliate program tables:

* ``affiliates`` — soft-membership flag tied to a Client, invite-only,
  capped at 5 active rows via service-layer enforcement.
* ``referral_codes`` — globally unique, case-insensitive code per affiliate,
  with an optional internal ``label`` (e.g. "Twitter launch").
* ``referral_clicks`` — append-only click log; IP and UA are hashed.
* ``clients.referral_code_id`` + ``clients.referral_attributed_at`` — first-touch
  attribution columns. NULL for the vast majority of clients.

Online-safety:
  * Both new columns on ``clients`` are nullable and have no default — the
    ``ALTER TABLE`` is a metadata-only operation in PG 11+ (no row rewrite).
  * The FK from ``clients.referral_code_id`` is added ``NOT VALID`` first
    and then validated separately, so it never holds an ``ACCESS EXCLUSIVE``
    lock while scanning the table.
  * The supporting index on ``clients.referral_code_id`` is built with
    ``CREATE INDEX CONCURRENTLY`` inside an ``autocommit_block`` so writes
    to ``clients`` are not blocked.

The money layer (commission %, customer discount %, payouts) is deferred
to v2 — see ``platform/docs/affiliate-program.md`` for the additive
migration path.

Revision ID: a1f9c3e6d4b2
Revises: b3d4e5f6a7c8
Create Date: 2026-06-09
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision = "a1f9c3e6d4b2"
down_revision = "b3d4e5f6a7c8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── Extension ──
    # citext = case-insensitive text; safe / idempotent on every run.
    op.execute("CREATE EXTENSION IF NOT EXISTS citext")

    # ── affiliates ──
    op.create_table(
        "affiliates",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "client_id",
            sa.Integer(),
            sa.ForeignKey("clients.id", ondelete="RESTRICT"),
            nullable=False,
            unique=True,
        ),
        sa.Column(
            "invited_by",
            sa.Integer(),
            sa.ForeignKey("clients.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "max_active_codes",
            sa.Integer(),
            nullable=False,
            server_default="10",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "max_active_codes > 0",
            name="chk_affiliate_max_codes_positive",
        ),
    )
    # Partial index on the "active affiliate" lookup path.
    op.create_index(
        "ix_affiliates_active",
        "affiliates",
        ["client_id"],
        postgresql_where=sa.text("deactivated_at IS NULL"),
    )

    # ── referral_codes ──
    # We declare ``code`` as the citext type so DB-level UNIQUE handles
    # "Save20" vs "save20" collisions without any application-level lower().
    op.create_table(
        "referral_codes",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "affiliate_id",
            sa.Integer(),
            sa.ForeignKey("affiliates.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column(
            "code",
            postgresql.CITEXT(),
            nullable=False,
            unique=True,
        ),
        sa.Column("label", sa.Text(), nullable=True),
        sa.Column(
            "active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            r"code ~ '^[A-Za-z0-9_-]{3,20}$'",
            name="chk_referral_code_format",
        ),
    )
    # Partial index for the active-codes-per-affiliate count query.
    op.create_index(
        "ix_referral_codes_active_per_affiliate",
        "referral_codes",
        ["affiliate_id"],
        postgresql_where=sa.text("active = true"),
    )

    # ── referral_clicks ──
    # Append-only. IP/UA hashed at the application layer (sha256), so a
    # raw IP never lands in this table even via stray INSERT.
    op.create_table(
        "referral_clicks",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column(
            "code_id",
            sa.Integer(),
            sa.ForeignKey("referral_codes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("ip_hash", sa.Text(), nullable=True),
        sa.Column("ua_hash", sa.Text(), nullable=True),
        sa.Column("referrer", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "ix_referral_clicks_code_time",
        "referral_clicks",
        ["code_id", sa.text("created_at DESC")],
    )

    # ── clients: attribution columns ──
    # Nullable + no default = metadata-only ALTER (no table rewrite).
    op.add_column(
        "clients",
        sa.Column("referral_code_id", sa.Integer(), nullable=True),
    )
    op.add_column(
        "clients",
        sa.Column(
            "referral_attributed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )

    # FK added NOT VALID first → no full-table scan under ACCESS EXCLUSIVE.
    # Then validated in a separate statement that only holds SHARE UPDATE
    # EXCLUSIVE (still allows reads + writes).
    op.execute(
        """
        ALTER TABLE clients
        ADD CONSTRAINT fk_clients_referral_code
        FOREIGN KEY (referral_code_id) REFERENCES referral_codes(id)
        ON DELETE SET NULL
        NOT VALID
        """
    )
    op.execute("ALTER TABLE clients VALIDATE CONSTRAINT fk_clients_referral_code")

    # CONCURRENTLY index requires no surrounding transaction.
    # autocommit_block() temporarily exits the migration's transaction
    # so the index build doesn't block writes to ``clients``.
    with op.get_context().autocommit_block():
        op.execute(
            "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_clients_referral_code "
            "ON clients (referral_code_id) WHERE referral_code_id IS NOT NULL"
        )


def downgrade() -> None:
    # Reverse order — drop dependent objects first.
    with op.get_context().autocommit_block():
        op.execute("DROP INDEX CONCURRENTLY IF EXISTS idx_clients_referral_code")

    op.execute("ALTER TABLE clients DROP CONSTRAINT IF EXISTS fk_clients_referral_code")
    op.drop_column("clients", "referral_attributed_at")
    op.drop_column("clients", "referral_code_id")

    op.drop_index("ix_referral_clicks_code_time", table_name="referral_clicks")
    op.drop_table("referral_clicks")

    op.drop_index(
        "ix_referral_codes_active_per_affiliate",
        table_name="referral_codes",
    )
    op.drop_table("referral_codes")

    op.drop_index("ix_affiliates_active", table_name="affiliates")
    op.drop_table("affiliates")

    # Leave the citext extension in place — other future migrations may
    # depend on it, and dropping it would force a CASCADE.
