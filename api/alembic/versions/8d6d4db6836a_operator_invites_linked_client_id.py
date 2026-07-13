"""operator invites + linked_client_id

Adds the invite-based operator onboarding schema:

* ``operator_invites`` table — pending / accepted / revoked / expired invites
  a workspace owner sends to a would-be operator. Token is stored as a
  SHA-256 hex hash; the plaintext appears only in the invite email link.
  A partial unique index enforces "at most one pending invite per
  (workspace, email)" — accepted / revoked / expired rows coexist for audit.

* ``operators.linked_client_id`` — nullable FK to ``clients.id``. When set,
  identifies the underlying Client identity that owns this operator role.
  Enables one Client to hold operator roles in multiple workspaces without
  a duplicate identity per workspace. NULL for legacy operators (created
  with their own password via ``POST /operators/create``), preserving full
  backward compatibility.

* ``operators.invited_email`` — historic snapshot of the email the invite
  targeted. Preserved even if the linked Client's email later changes.

* Partial unique index ``ux_operators_linked_per_workspace`` prevents a
  Client from holding two operator rows in the same workspace, but only
  applies to linked rows so legacy operators (all NULL linked_client_id)
  are untouched.

Revision ID: 8d6d4db6836a
Revises: 780433c15b3a
Create Date: 2026-07-10 14:25:21.906692

"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "8d6d4db6836a"
down_revision: str | Sequence[str] | None = "780433c15b3a"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    # ── operator_invites ────────────────────────────────────────────────
    op.create_table(
        "operator_invites",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("client_id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(), nullable=False),
        sa.Column("role", sa.String(), server_default="operator", nullable=False),
        sa.Column("department_id", sa.Integer(), nullable=True),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("status", sa.String(), server_default="pending", nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("invited_by_client_id", sa.Integer(), nullable=True),
        sa.Column("invited_by_name", sa.String(), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_by_client_id", sa.Integer(), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_by_client_id", sa.Integer(), nullable=True),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resend_count", sa.Integer(), server_default="0", nullable=False),
        sa.ForeignKeyConstraint(["client_id"], ["clients.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["department_id"], ["departments.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["invited_by_client_id"], ["clients.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["accepted_by_client_id"], ["clients.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["revoked_by_client_id"], ["clients.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_operator_invites_client_id"),
        "operator_invites",
        ["client_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_operator_invites_email"),
        "operator_invites",
        ["email"],
        unique=False,
    )
    op.create_index(
        op.f("ix_operator_invites_token_hash"),
        "operator_invites",
        ["token_hash"],
        unique=True,
    )
    # Partial unique — at most one pending invite per (workspace, email).
    op.create_index(
        "ux_operator_invites_pending_unique",
        "operator_invites",
        ["client_id", "email"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )

    # ── operators: linked_client_id + invited_email ────────────────────
    op.add_column("operators", sa.Column("linked_client_id", sa.Integer(), nullable=True))
    op.add_column("operators", sa.Column("invited_email", sa.String(), nullable=True))
    op.create_foreign_key(
        "operators_linked_client_id_fkey",
        "operators",
        "clients",
        ["linked_client_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        op.f("ix_operators_linked_client_id"),
        "operators",
        ["linked_client_id"],
        unique=False,
    )
    # Partial unique — a Client identity can hold at most one operator row
    # per workspace. Legacy rows (linked_client_id NULL) are excluded so this
    # migration is safe against pre-existing data.
    op.create_index(
        "ux_operators_linked_per_workspace",
        "operators",
        ["client_id", "linked_client_id"],
        unique=True,
        postgresql_where=sa.text("linked_client_id IS NOT NULL"),
    )


def downgrade() -> None:
    """Downgrade schema — reverses everything ``upgrade`` added.

    Safe to run against a DB that has active invites: the CASCADE FKs handle
    orphaned dependents, and dropping ``operator_invites`` wholesale is fine
    since no other table references it.
    """
    op.drop_index(
        "ux_operators_linked_per_workspace",
        table_name="operators",
        postgresql_where=sa.text("linked_client_id IS NOT NULL"),
    )
    op.drop_index(op.f("ix_operators_linked_client_id"), table_name="operators")
    op.drop_constraint("operators_linked_client_id_fkey", "operators", type_="foreignkey")
    op.drop_column("operators", "invited_email")
    op.drop_column("operators", "linked_client_id")

    op.drop_index(
        "ux_operator_invites_pending_unique",
        table_name="operator_invites",
        postgresql_where=sa.text("status = 'pending'"),
    )
    op.drop_index(op.f("ix_operator_invites_token_hash"), table_name="operator_invites")
    op.drop_index(op.f("ix_operator_invites_email"), table_name="operator_invites")
    op.drop_index(op.f("ix_operator_invites_client_id"), table_name="operator_invites")
    op.drop_table("operator_invites")
