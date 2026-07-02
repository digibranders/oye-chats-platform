"""Raise the Starter/Standard operator seat ceiling.

``limits.operators`` (see ``d3e4f5a6b7c8_seed_plans_canonical_matrix``) is
the hard cap enforced in ``operator_routes.py`` when creating a new
operator — distinct from ``included_operator_seats``, the number of seats
bundled free into the plan's base price. Raising the ceiling lets clients
pay for extra seats (via ``POST /subscription/seats``) up to a higher total
without changing what's included for free:

* Starter:  ceiling 1  -> 5   (``included_operator_seats`` stays 1)
* Standard: ceiling 2  -> 10  (``included_operator_seats`` stays 2)

Only the ``operators`` key inside the ``limits`` JSONB is touched — every
other limit/feature key is left exactly as seeded.

Revision ID: 199150a66c11
Revises: c8e4a1b7d9f2
Create Date: 2026-07-01
"""

import sqlalchemy as sa

from alembic import op

revision = "199150a66c11"
down_revision = "c8e4a1b7d9f2"
branch_labels = None
depends_on = None

_NEW_CEILINGS = {"starter": 5, "standard": 10}
_OLD_CEILINGS = {"starter": 1, "standard": 2}


def upgrade() -> None:
    conn = op.get_bind()
    for slug, ceiling in _NEW_CEILINGS.items():
        conn.execute(
            sa.text(
                """
                UPDATE plans
                SET limits = jsonb_set(limits, '{operators}', CAST(:ceiling AS jsonb), true)
                WHERE slug = :slug
                """
            ),
            {"slug": slug, "ceiling": str(ceiling)},
        )


def downgrade() -> None:
    conn = op.get_bind()
    for slug, ceiling in _OLD_CEILINGS.items():
        conn.execute(
            sa.text(
                """
                UPDATE plans
                SET limits = jsonb_set(limits, '{operators}', CAST(:ceiling AS jsonb), true)
                WHERE slug = :slug
                """
            ),
            {"slug": slug, "ceiling": str(ceiling)},
        )
