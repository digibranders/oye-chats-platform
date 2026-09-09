"""Move saved answering-strictness presets onto the recalibrated gate scale.

The relevance gate's pass mark moved from 0.55 to 0.3 (it sat above the
judge's own "related enough to help" anchor and refused broad company
questions). The dashboard's three presets moved with it:

    Lenient   0.45 -> 0.15
    Balanced  0.55 -> 0.30
    Strict    0.65 -> 0.50

A bot that saved one of the old preset values chose a LABEL, not a number, so
it keeps the label: the stored value is mapped to the new preset. Any other
hand-set value is left alone and shows as "Custom" in the console, exactly as
it does today. NULL (platform default) is untouched.

Revision ID: b1000008recalibrate
Revises: b1000007waitsince
Create Date: 2026-09-09

"""

from __future__ import annotations

from alembic import op

revision: str = "b1000008recalibrate"
down_revision: str | None = "b1000007waitsince"
branch_labels: None = None
depends_on: None = None

# (old, new) preset pairs. Compared with a tolerance because the column is
# double precision and the console wrote these as JS floats.
_PRESETS = ((0.45, 0.15), (0.55, 0.30), (0.65, 0.50))
_EPS = 0.001


def upgrade() -> None:
    for old, new in _PRESETS:
        op.execute(
            f"UPDATE bots SET relevance_threshold = {new} "
            f"WHERE relevance_threshold IS NOT NULL AND abs(relevance_threshold - {old}) < {_EPS}"
        )


def downgrade() -> None:
    for old, new in reversed(_PRESETS):
        op.execute(
            f"UPDATE bots SET relevance_threshold = {old} "
            f"WHERE relevance_threshold IS NOT NULL AND abs(relevance_threshold - {new}) < {_EPS}"
        )
