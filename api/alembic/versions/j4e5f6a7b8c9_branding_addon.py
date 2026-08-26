"""add the branding-removal add-on columns to subscriptions

Branding removal stops being a bundled plan feature and becomes a standalone
paid add-on, sold on its own Razorpay mandate the way extra operator seats
already are. Three columns mirror the seat add-on trio, minus the quantity
(the add-on is a boolean, one mandate per subscription):

* ``branding_addon_subscription_id`` - the Razorpay add-on mandate.
* ``branding_addon_active`` - the AUTHORIZED entitlement. The only input to
  ``features.branding_removable`` from now on.
* ``branding_addon_pending`` - purchase opened but the mandate is not yet
  authorized. Keeps a dismissed checkout from granting the feature for free.

The companion data change (every plan tier's ``features.branding_removable``
forced to false) also runs here rather than in ``seed_plans.py`` alone, so an
existing deployment loses the bundled grant at migrate time instead of waiting
for someone to re-run the seed script. Downgrade restores the historical
Standard/Professional/Enterprise grant.

Revision ID: j4e5f6a7b8c9
Revises: i3d4e5f6a7b8
Create Date: 2026-08-26
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "j4e5f6a7b8c9"
down_revision: str | Sequence[str] | None = "i3d4e5f6a7b8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Tiers that bundled branding removal before it became an add-on. Named
# explicitly so ``downgrade`` restores exactly what ``upgrade`` revoked and
# cannot accidentally grant the feature to Free or Starter.
_PREVIOUSLY_BUNDLED_SLUGS = ("standard", "professional", "enterprise")


def upgrade() -> None:
    op.add_column("subscriptions", sa.Column("branding_addon_subscription_id", sa.String(), nullable=True))
    op.add_column(
        "subscriptions",
        sa.Column("branding_addon_active", sa.Boolean(), nullable=False, server_default="false"),
    )
    op.add_column(
        "subscriptions",
        sa.Column("branding_addon_pending", sa.Boolean(), nullable=False, server_default="false"),
    )
    # Webhooks arrive keyed by the add-on's Razorpay id and must find their
    # owning row in one hit, same access pattern as the seat add-on lookup.
    op.create_index(
        "ix_subscriptions_branding_addon_subscription_id",
        "subscriptions",
        ["branding_addon_subscription_id"],
        unique=True,
        postgresql_where=sa.text("branding_addon_subscription_id IS NOT NULL"),
    )

    # Revoke the bundled grant. ``jsonb_set`` preserves every other feature key.
    op.execute(
        sa.text(
            "UPDATE plans SET features = jsonb_set("
            "COALESCE(features, '{}'::jsonb), '{branding_removable}', 'false'::jsonb, true"
            ")"
        )
    )


def downgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE plans SET features = jsonb_set("
            "COALESCE(features, '{}'::jsonb), '{branding_removable}', 'true'::jsonb, true"
            ") WHERE slug IN :slugs"
        ).bindparams(sa.bindparam("slugs", value=_PREVIOUSLY_BUNDLED_SLUGS, expanding=True))
    )
    op.drop_index("ix_subscriptions_branding_addon_subscription_id", table_name="subscriptions")
    op.drop_column("subscriptions", "branding_addon_pending")
    op.drop_column("subscriptions", "branding_addon_active")
    op.drop_column("subscriptions", "branding_addon_subscription_id")
