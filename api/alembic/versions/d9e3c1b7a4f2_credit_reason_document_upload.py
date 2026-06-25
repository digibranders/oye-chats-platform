"""Extend credit_reason enum with ``document_upload``.

The credit-ledger reason column is a PG ENUM (``credit_reason``). When
the document-upload credit cost shipped, the value ``"document_upload"``
was added to the application code (``credit_service.check_and_deduct``
calls and ``REASON_LABEL`` in the admin Billing page) but the enum was
never extended. SQLAlchemy's column declaration in ``models.py`` is a
plain ``String``, so INSERTs that pass through PG's permissive
text→enum literal coercion may succeed, but any explicit IN-clause
comparison (``reason IN ('ai_chat', 'document_upload', …)``) fails at
the planner step because PG cannot cast every literal to the enum
type.

This migration adds the missing value. ``ALTER TYPE … ADD VALUE …
IF NOT EXISTS`` is idempotent, so re-running the migration on an env
that was hand-patched is a no-op.

Postgres requires ``ADD VALUE`` to run outside a transaction block,
hence the ``with op.get_context().autocommit_block()`` wrapper.
"""

from __future__ import annotations

from alembic import op

# revision identifiers, used by Alembic.
revision = "d9e3c1b7a4f2"
down_revision = "f8b2c4d6e1a3"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE credit_reason ADD VALUE IF NOT EXISTS 'document_upload'")


def downgrade() -> None:
    # Dropping an enum value is not supported by PostgreSQL — once a
    # value exists in a column, removing it requires rewriting the
    # whole type. Leave the value in place on downgrade; it's harmless.
    pass
