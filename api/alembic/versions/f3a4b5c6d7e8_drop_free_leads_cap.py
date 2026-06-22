"""Drop the 15-leads/month cap from the Free plan.

The Free plan ships with the leads dashboard feature-locked
(``sidebar.locked + ent.isFree`` short-circuit in the admin app) and BANT
qualification disabled (``features.bant = false``). The remaining
``limits.leads = 15`` quota was therefore informational only — no backend
code rejects lead creation based on it, and the UI never surfaced the
counter on Free since the surface it would render in is hidden.

After this migration:

* Free's ``limits.leads`` becomes ``-1`` (the canonical ``UNLIMITED``
  sentinel used elsewhere in ``plan_entitlements_service``). LeadInfo
  rows continue to be created from chat conversations (visible to the
  Free customer via Insights → Conversations) and from offline-message
  submissions, without an arbitrary monthly ceiling.
* Paid plans are untouched — their numeric ``leads`` cap continues to
  control the leads-dashboard surface they actually have access to.

There is no schema change; only the JSONB value flips. Downgrade
restores the 15 cap that ``d3e4f5a6b7c8_seed_plans_canonical_matrix``
seeded.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "f3a4b5c6d7e8"
down_revision = "e2a3b4c5d6f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    row = bind.execute(
        sa.text("SELECT limits FROM plans WHERE slug = 'free'"),
    ).fetchone()
    if row is None:
        return
    current = dict(row[0] or {})
    current["leads"] = -1
    bind.execute(
        sa.text("UPDATE plans SET limits = CAST(:limits AS JSONB) WHERE slug = 'free'"),
        {"limits": json.dumps(current)},
    )


def downgrade() -> None:
    bind = op.get_bind()
    row = bind.execute(
        sa.text("SELECT limits FROM plans WHERE slug = 'free'"),
    ).fetchone()
    if row is None:
        return
    current = dict(row[0] or {})
    current["leads"] = 15  # canonical pre-migration value
    bind.execute(
        sa.text("UPDATE plans SET limits = CAST(:limits AS JSONB) WHERE slug = 'free'"),
        {"limits": json.dumps(current)},
    )
