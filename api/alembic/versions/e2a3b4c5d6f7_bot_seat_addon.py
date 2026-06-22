"""Bot seat add-on: per-client extra_bot_seats + per-plan max_bots_cap.

Adds the data model and seed values that let paid plans (Starter / Standard)
purchase additional bots beyond their included quota at a configurable
per-seat price. Mirrors the operator-seat add-on pattern that already ships
in the canonical plan matrix (``included_operator_seats`` +
``extra_seat_price_cents``).

Schema additions:

* ``clients.extra_bot_seats`` (INTEGER NOT NULL DEFAULT 0) — count of paid
  bot seats this client has on top of their plan's included ``limits.bots``.
  Lives on Client (not Subscription) so it survives plan changes the same
  way ``Client.max_bots`` does: a customer downgrading from Standard to
  Starter doesn't lose their paid add-on seats — they just hit the new
  plan's ``max_bots_cap`` ceiling sooner.

* ``plans.limits["max_bots_cap"]`` (JSONB key) — absolute ceiling including
  paid add-ons. ``limits["bots"]`` continues to mean *included* bots; the
  effective limit a client can create is
  ``min(limits["bots"] + client.extra_bot_seats, limits["max_bots_cap"])``.
  ``-1`` means unlimited (Enterprise only).

Plan matrix after this migration:

| Plan       | included (limits.bots) | hard cap (max_bots_cap) | purchasable |
|------------|-----------------------:|------------------------:|------------:|
| Free       |                      1 |                       1 |           0 |
| Starter    |                      1 |                       3 |           2 |
| Standard   |                      1 |                       5 |           4 |
| Enterprise |                     -1 |                      -1 |   unlimited |

Note: Standard's included quota drops from 2 → 1 in this migration per the
2026-06 product decision. Existing Standard customers with 2 active bots
are unaffected because the cap is 5 — they just no longer have a "free"
second seat the next time they delete and re-add.

Pricing seed (super-admin tunable via ``PricingConfig``):

* ``bot_seat_price_usd_cents`` → ``500``  (\\$5.00 / month / seat)
* ``bot_seat_price_inr_paise``  → ``41500`` (≈₹415 / month / seat — \\$5 at
  ~₹83/USD). The INR value is configurable: super admin can adjust without
  a redeploy via the existing PricingConfig surface.

Both keys are loaded by the entitlements service and surfaced in
``/me/entitlements`` so the upgrade modal can show region-correct pricing.
"""

from __future__ import annotations

import json

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision = "e2a3b4c5d6f7"
down_revision = "d3e4f5a6b7c8"
branch_labels = None
depends_on = None


# Per-plan updates. ``bots`` overrides are spelled out per slug because
# Standard's included count drops; the other three keep their existing
# ``limits.bots`` value. ``max_bots_cap`` is added to every plan.
_PLAN_UPDATES: dict[str, dict[str, int]] = {
    "free": {"bots": 1, "max_bots_cap": 1},
    "starter": {"bots": 1, "max_bots_cap": 3},
    "standard": {"bots": 1, "max_bots_cap": 5},
    "enterprise": {"bots": -1, "max_bots_cap": -1},
}

# Pre-migration values for the keys we mutate, so downgrade restores the
# canonical state set by ``d3e4f5a6b7c8_seed_plans_canonical_matrix``.
_PLAN_DOWNGRADES: dict[str, int] = {
    "free": 1,
    "starter": 1,
    "standard": 2,  # Standard included was 2 before this migration
    "enterprise": -1,
}

_PRICING_KEYS: list[tuple[str, int]] = [
    ("bot_seat_price_usd_cents", 500),
    ("bot_seat_price_inr_paise", 41500),
]


def upgrade() -> None:
    bind = op.get_bind()

    # 1. clients.extra_bot_seats — int default 0, never null. Backfilled to
    # 0 for every existing client (the column default handles this).
    op.add_column(
        "clients",
        sa.Column(
            "extra_bot_seats",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )

    # 2. Patch each plan's JSONB ``limits`` map. Read-modify-write per row
    # so we preserve every other key the seed migration set (credits,
    # documents, page_scraping, etc.) — overwriting ``limits`` wholesale
    # would clobber them.
    for slug, patch in _PLAN_UPDATES.items():
        row = bind.execute(
            sa.text("SELECT limits FROM plans WHERE slug = :slug"),
            {"slug": slug},
        ).fetchone()
        if row is None:
            # Plan row missing — production runs guarantee the four
            # canonical plans exist (seeded by d3e4f5a6b7c8); skip
            # silently for dev environments mid-bootstrap.
            continue

        current = dict(row[0] or {})
        current.update(patch)
        bind.execute(
            sa.text("UPDATE plans SET limits = CAST(:limits AS JSONB) WHERE slug = :slug"),
            {"slug": slug, "limits": json.dumps(current)},
        )

    # 3. PricingConfig — UPSERT so re-running on a partially-applied env
    # doesn't blow up. ``updated_at`` defaults to NOW() via the column.
    for key, value in _PRICING_KEYS:
        bind.execute(
            sa.text(
                """
                INSERT INTO pricing_config (key, value)
                VALUES (:key, CAST(:value AS JSONB))
                ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
                """,
            ),
            {"key": key, "value": json.dumps(value)},
        )


def downgrade() -> None:
    bind = op.get_bind()

    # Reverse the PricingConfig seed.
    for key, _ in _PRICING_KEYS:
        bind.execute(sa.text("DELETE FROM pricing_config WHERE key = :key"), {"key": key})

    # Revert the plan JSONB patches: restore Standard's bots count and
    # drop ``max_bots_cap`` from every plan. Per-row read-modify-write
    # for the same reason as upgrade.
    for slug, original_bots in _PLAN_DOWNGRADES.items():
        row = bind.execute(
            sa.text("SELECT limits FROM plans WHERE slug = :slug"),
            {"slug": slug},
        ).fetchone()
        if row is None:
            continue
        current = dict(row[0] or {})
        current["bots"] = original_bots
        current.pop("max_bots_cap", None)
        bind.execute(
            sa.text("UPDATE plans SET limits = CAST(:limits AS JSONB) WHERE slug = :slug"),
            {"slug": slug, "limits": json.dumps(current)},
        )

    op.drop_column("clients", "extra_bot_seats")
