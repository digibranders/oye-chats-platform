"""Move saved answering-strictness values onto the recalibrated gate scale.

The relevance gate's pass mark moved from 0.55 to 0.3. It sat above the judge's
own "related enough to help" anchor (0.5), so a judge following its own rubric
failed the gate on every broad company question. The dashboard's three presets
moved with it:

    Lenient   0.45 -> 0.15
    Balanced  0.55 -> 0.30
    Strict    0.65 -> 0.50

Two things carry an old-scale number and both are migrated here, because the
code default alone reaches neither of them.

``bots.relevance_threshold``
    A bot that saved one of the old preset values chose a LABEL, not a number,
    so it keeps the label: the stored value is mapped to the new preset. The
    column stores only a float, so a hand-typed 0.45 is indistinguishable from
    a preset click and is remapped the same way; that is the intended
    trade-off, because the alternative leaves a "Balanced" bot behaving as
    "Strict" with nothing in the console to explain it. Any other value is left
    alone and shows as "Custom", exactly as it does today. NULL (platform
    default) is untouched and picks up the new default from code.

``pricing_config['rag.relevance_threshold']``
    The super-admin runtime knob, which ``relevance_gate._resolve_threshold``
    consults for every bot whose own threshold is NULL, i.e. the majority.
    It wins over the code default, so an old-scale row left in place would make
    this entire recalibration a silent no-op for most of the platform. The
    super-admin RAG form pre-fills this field with the currently effective
    value and persists every field on save, so a row holding 0.5 or 0.55 is the
    likely state, not a hypothetical one. Only a value in the old-scale band is
    rewritten: an admin who has deliberately set something outside it keeps it.

DOWNGRADE IS A NO-OP, AND THAT IS DELIBERATE. The forward map cannot be
inverted from the data: a bot hand-set to 0.50 before this migration is left
alone on the way up (it matches no old preset) and would be rewritten to 0.65
on the way down, destroying a value its owner chose. The deploy's own failure
path never downgrades the schema either (see the restore guard in
deploy-api.yml), so the honest behaviour is to leave the data forward-migrated
and say so.

One consequence worth knowing on a failed deploy: if a step between
``alembic upgrade head`` and the service restart fails, the guard resets the
code but not the schema, so the previous release reads recalibrated numbers
with the old semantics. That direction is the safe one (the bot answers more
and refuses less) but it is not the owner's chosen setting, so re-deploy rather
than leaving it.

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

# The runtime knob is rewritten only inside the old-scale band, so a
# deliberately unusual admin value survives. 0.40 to 0.70 covers every value
# the old console could produce plus the 0.5 that ``runtime_config`` and the
# config.py comment both used to name.
_KNOB_KEY = "rag.relevance_threshold"
_KNOB_BAND = (0.40, 0.70)
_KNOB_NEW = 0.30

# Fail fast instead of queueing behind an open transaction. ``bots`` is read on
# every chat request, so a blocked ALTER stalls the widget for as long as the
# blocker lives; a timeout aborts into the deploy's restore guard instead.
_LOCK_TIMEOUT = "3s"


def upgrade() -> None:
    op.execute(f"SET lock_timeout = '{_LOCK_TIMEOUT}'")
    for old, new in _PRESETS:
        op.execute(
            f"UPDATE bots SET relevance_threshold = {new} "
            f"WHERE relevance_threshold IS NOT NULL AND abs(relevance_threshold - {old}) < {_EPS}"
        )
    # JSONB, so the value is cast out for the comparison and back in for the
    # write. Guarded by a numeric-shape test: a row holding a string or an
    # object is left for a human rather than crashed on.
    op.execute(
        f"UPDATE pricing_config SET value = to_jsonb({_KNOB_NEW}::float) "
        f"WHERE key = '{_KNOB_KEY}' "
        f"AND jsonb_typeof(value) = 'number' "
        f"AND (value#>>'{{}}')::float BETWEEN {_KNOB_BAND[0]} AND {_KNOB_BAND[1]}"
    )


def downgrade() -> None:
    """Intentionally empty. See the module docstring: the forward remap is not
    invertible from the data, and guessing would overwrite thresholds their
    owners set by hand."""
