"""Default widget origin-enforcement ON + backfill configured bots.

``domain_check_enabled`` previously defaulted OFF, so any site could embed a
customer's public bot key. Combined with the fail-open behaviour in
``_enforce_bot_origin`` (a true flag with an empty ``allowed_domains`` allows
all origins), it is now safe to flip the default ON.

Upgrade:
  * Flip the ``domain_check_enabled`` server default to ``true`` so newly
    inserted bots enforce by default.
  * Backfill ``domain_check_enabled = true`` for EXISTING bots that already
    have a NON-EMPTY ``allowed_domains`` list -- those have domains to check,
    so protecting them changes nothing for legitimate traffic. Bots with an
    empty allowlist are left untouched (behaviour unchanged; they remain
    unenforced regardless because enforcement fails open on empty).

Downgrade:
  * Restore the ``false`` server default and clear the flag on bots whose
    ``allowed_domains`` is non-empty (the exact set this migration set), so the
    round-trip is reversible without disturbing rows a customer toggled by hand
    on an empty allowlist.

Revision ID: c1e7a9d3f2b4
Revises: b7d1c3e5f9a2
Create Date: 2026-07-03
"""

import sqlalchemy as sa

from alembic import op

revision = "c1e7a9d3f2b4"
down_revision = "b7d1c3e5f9a2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "bots",
        "domain_check_enabled",
        server_default=sa.true(),
    )
    op.execute(
        sa.text(
            "UPDATE bots "
            "SET domain_check_enabled = true "
            "WHERE domain_check_enabled = false "
            "AND jsonb_array_length(allowed_domains) > 0"
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE bots "
            "SET domain_check_enabled = false "
            "WHERE domain_check_enabled = true "
            "AND jsonb_array_length(allowed_domains) > 0"
        )
    )
    op.alter_column(
        "bots",
        "domain_check_enabled",
        server_default=sa.false(),
    )
