"""fix legacy starter/standard plan naming

Some environments carry drifted plan rows where the $19 tier is slugged
``standard`` (should be ``starter``) and the $49 tier is slugged ``pro``
(should be ``standard``). Because the canonical seed matches by slug, it never
realigned these rows, so the platform app and website render "Standard"/"Pro"
instead of the canonical "Starter"/"Standard".

This migration realigns the two drifted rows to the canonical
``free / starter / standard / enterprise`` naming, and repairs the slug-keyed
``marketing`` copy that the earlier backfill (b3d7f1a9c2e5) would have attached
to the wrong tier.

Guarded on the presence of the legacy ``pro`` slug, so it is a safe no-op on
databases that are already canonical (and never touches super-admin edits
there). Renames are safe for existing subscribers — subscriptions reference
``plan_id`` (FK), not ``slug``.

Revision ID: c8e4a1b7d9f2
Revises: b3d7f1a9c2e5
Create Date: 2026-06-30 20:40:00.000000
"""

import json

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "c8e4a1b7d9f2"
down_revision: str = "b3d7f1a9c2e5"
branch_labels = None
depends_on = None

_APP = "https://app.oyechats.com"

# Canonical marketing copy for the two realigned tiers (mirrors the values
# seeded by b3d7f1a9c2e5, re-applied here so the correct copy lands on the
# correct slug after the rename).
_STARTER_MARKETING = {
    "tagline": "For growing teams with live chat needs",
    "accent": "blue",
    "cta_label": "Start free trial",
    "cta_href": f"{_APP}/register?plan=starter",
    "highlight_features": [
        "3,000 credits / month",
        "1 chatbot included (subscribe again to add more)",
        "1 operator seat (+$5/mo each extra, up to 5 total)",
        "Live chat enabled",
        "14-day free trial",
        "Priority email support",
    ],
    "featured": False,
}

_STANDARD_MARKETING = {
    "tagline": "Full AI + BANT sales intelligence",
    "badge": "Most Popular",
    "accent": "blue-gradient",
    "cta_label": "Get started",
    "cta_href": f"{_APP}/register?plan=standard",
    "highlight_features": [
        "10,000 credits / month",
        "1 chatbot included (subscribe again to add more)",
        "2 operator seats included (+$5/mo each extra, up to 10 total)",
        "Live chat enabled",
        "BANT lead qualification scoring",
        "Behavioral tracking & UTM capture",
        "Webhooks (5 event types)",
    ],
    "featured": True,
}


def _has_legacy_pro(conn) -> bool:
    return conn.execute(sa.text("SELECT 1 FROM plans WHERE slug = 'pro' LIMIT 1")).first() is not None


def upgrade() -> None:
    conn = op.get_bind()
    if not _has_legacy_pro(conn):
        # Already canonical (or never drifted) — nothing to do.
        return

    # Step 1: the legacy 'standard' row is really Starter. Rename it first so
    # the 'standard' slug is free for step 2 (slug has a UNIQUE constraint).
    conn.execute(sa.text("UPDATE plans SET slug = 'starter', name = 'Starter' WHERE slug = 'standard'"))

    # Step 2: the legacy 'pro' row is really Standard.
    conn.execute(sa.text("UPDATE plans SET slug = 'standard', name = 'Standard' WHERE slug = 'pro'"))

    # Step 3: repair marketing so the correct copy sits on the correct slug
    # (overwrites any copy the slug-keyed backfill attached to the wrong tier).
    conn.execute(
        sa.text("UPDATE plans SET marketing = CAST(:m AS JSONB) WHERE slug = 'starter'"),
        {"m": json.dumps(_STARTER_MARKETING)},
    )
    conn.execute(
        sa.text("UPDATE plans SET marketing = CAST(:m AS JSONB) WHERE slug = 'standard'"),
        {"m": json.dumps(_STANDARD_MARKETING)},
    )


def downgrade() -> None:
    conn = op.get_bind()
    # Only reverse a database this migration actually realigned: 'starter'
    # present and no legacy 'pro'.
    has_starter = conn.execute(sa.text("SELECT 1 FROM plans WHERE slug = 'starter' LIMIT 1")).first()
    has_pro = conn.execute(sa.text("SELECT 1 FROM plans WHERE slug = 'pro' LIMIT 1")).first()
    if has_starter is None or has_pro is not None:
        return
    conn.execute(
        sa.text("UPDATE plans SET slug = 'pro', name = 'Pro', marketing = '{}'::jsonb WHERE slug = 'standard'")
    )
    conn.execute(
        sa.text("UPDATE plans SET slug = 'standard', name = 'Standard', marketing = '{}'::jsonb WHERE slug = 'starter'")
    )
