"""Super-admin v2: audit log, coupons, LLM call log, impersonation tokens.

Adds tables and columns required by the new ``admin.oyechats.com`` command
center:

* ``audit_logs`` — immutable record of every super-admin mutation
* ``coupons`` — promotional discount codes
* ``llm_call_logs`` — per-call LLM metering for the cost dashboard
* ``impersonation_tokens`` — short-lived (30 min) tokens for "act as customer"
* ``clients.superadmin_role`` — owner | admin | readonly RBAC tier
* ``clients.suspended_at`` — soft-suspension timestamp

Revision ID: f9a0b1c2d3e4
Revises: e7b1f2c4d8a9
Create Date: 2026-04-28
"""

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# revision identifiers, used by Alembic.
revision = "f9a0b1c2d3e4"
down_revision = "e7b1f2c4d8a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── Client columns ──
    op.add_column(
        "clients",
        sa.Column("superadmin_role", sa.String(), nullable=True),
    )
    op.add_column(
        "clients",
        sa.Column("suspended_at", sa.DateTime(timezone=True), nullable=True),
    )

    # ── audit_logs ──
    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "actor_id",
            sa.Integer(),
            sa.ForeignKey("clients.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("actor_name", sa.String(), nullable=True),
        sa.Column("action", sa.String(), nullable=False),
        sa.Column("target_type", sa.String(), nullable=True),
        sa.Column("target_id", sa.String(), nullable=True),
        sa.Column("before", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("after", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("ip", sa.String(), nullable=True),
        sa.Column("user_agent", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_audit_logs_action", "audit_logs", ["action"])
    op.create_index("ix_audit_logs_target_type", "audit_logs", ["target_type"])
    op.create_index("ix_audit_logs_target_id", "audit_logs", ["target_id"])
    op.create_index("ix_audit_logs_created_at", "audit_logs", ["created_at"])
    op.create_index(
        "ix_audit_logs_actor_created",
        "audit_logs",
        ["actor_id", sa.text("created_at DESC")],
    )

    # ── coupons ──
    op.create_table(
        "coupons",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("code", sa.String(), nullable=False, unique=True),
        sa.Column("percent_off", sa.Integer(), nullable=True),
        sa.Column("amount_off_cents", sa.Integer(), nullable=True),
        sa.Column("max_redemptions", sa.Integer(), nullable=True),
        sa.Column(
            "redemptions",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "applies_to_plan_ids",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_coupons_code", "coupons", ["code"], unique=True)

    # ── llm_call_logs ──
    op.create_table(
        "llm_call_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column(
            "bot_id",
            sa.Integer(),
            sa.ForeignKey("bots.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "client_id",
            sa.Integer(),
            sa.ForeignKey("clients.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("model", sa.String(), nullable=False),
        sa.Column(
            "prompt_tokens",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "completion_tokens",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "cost_cents",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "latency_ms",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "fallback_used",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_llm_call_logs_bot_id", "llm_call_logs", ["bot_id"])
    op.create_index("ix_llm_call_logs_client_id", "llm_call_logs", ["client_id"])
    op.create_index("ix_llm_call_logs_model", "llm_call_logs", ["model"])
    op.create_index("ix_llm_call_logs_created_at", "llm_call_logs", ["created_at"])

    # ── impersonation_tokens ──
    op.create_table(
        "impersonation_tokens",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("token_hash", sa.String(), nullable=False, unique=True),
        sa.Column(
            "actor_id",
            sa.Integer(),
            sa.ForeignKey("clients.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "target_id",
            sa.Integer(),
            sa.ForeignKey("clients.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_impersonation_tokens_token_hash",
        "impersonation_tokens",
        ["token_hash"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("ix_impersonation_tokens_token_hash", table_name="impersonation_tokens")
    op.drop_table("impersonation_tokens")

    op.drop_index("ix_llm_call_logs_created_at", table_name="llm_call_logs")
    op.drop_index("ix_llm_call_logs_model", table_name="llm_call_logs")
    op.drop_index("ix_llm_call_logs_client_id", table_name="llm_call_logs")
    op.drop_index("ix_llm_call_logs_bot_id", table_name="llm_call_logs")
    op.drop_table("llm_call_logs")

    op.drop_index("ix_coupons_code", table_name="coupons")
    op.drop_table("coupons")

    op.drop_index("ix_audit_logs_actor_created", table_name="audit_logs")
    op.drop_index("ix_audit_logs_created_at", table_name="audit_logs")
    op.drop_index("ix_audit_logs_target_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_target_type", table_name="audit_logs")
    op.drop_index("ix_audit_logs_action", table_name="audit_logs")
    op.drop_table("audit_logs")

    op.drop_column("clients", "suspended_at")
    op.drop_column("clients", "superadmin_role")
