"""Seed plans with canonical matrix limits + features.

Updates the four plan rows (Free / Starter / Standard / Enterprise) so the
``limits`` and ``features`` JSONB columns match the locked pricing matrix
that the entitlements service reads. Legacy crawler-config keys
(``max_crawl_depth`` etc.) are preserved alongside the new canonical keys
so existing crawler logic keeps working unchanged.

Canonical limit keys (added):
* ``credits``              — monthly credit allowance
* ``bots``                 — max active bots in the workspace
* ``operators``            — included operator seats
* ``leads``                — lead capture cap (-1 = unlimited)
* ``page_scraping``        — pages-per-month crawl cap
* ``documents``            — docs per bot
* ``chat_history_days``    — message retention window

Canonical feature keys (added):
* ``live_chat``            — handoff feature
* ``bant``                 — qualification extraction
* ``branding_removable``   — "Powered by" removal
* ``webhooks``             — outbound webhooks
* ``api_access``           — REST API key access
* ``online_support``       — both online + offline support paths
* ``custom_sla``           — Enterprise only
* ``dedicated_csm``        — Enterprise only
* ``integrations``         — "all" | "reply_to_only" | "all_plus_custom"
* ``topup_allowed``        — Free has this set to False, paid plans True

The migration is idempotent: each plan row is fetched by slug and updated in
place. Plan rows with unknown slugs are left alone so super admins can add
custom tiers without this migration clobbering them.

Revision ID: d3e4f5a6b7c8
Revises: c2d3e4f5a6b7
Create Date: 2026-06-18
"""

import sqlalchemy as sa

from alembic import op

revision = "d3e4f5a6b7c8"
down_revision = "c2d3e4f5a6b7"
branch_labels = None
depends_on = None


# ── Matrix values, single source of truth ──────────────────────────────────

_PLAN_DATA = {
    "free": {
        "name": "Free",
        "credits_per_month": 200,
        "monthly_price_cents": 0,
        "annual_price_cents": 0,
        "annual_discount_percent": 0,
        "trial_days": 0,
        "limits": {
            # Canonical entitlement keys
            "credits": 200,
            "bots": 1,
            "operators": 0,
            "leads": 15,
            "page_scraping": 20,
            "documents": 5,
            "chat_history_days": 7,
            # Legacy crawler config (preserved)
            "max_crawl_depth": 2,
            "max_crawl_pages": 20,
            "max_crawl_js_pages": 10,
            "max_crawl_concurrency": 2,
        },
        "features": {
            "live_chat": False,
            "bant": False,
            "branding_removable": False,
            "webhooks": False,
            "api_access": False,
            "online_support": False,
            "topup_allowed": False,  # Free cannot top up — must upgrade
            "integrations": "reply_to_only",
        },
        "included_operator_seats": 0,
        "is_active": True,
        "sort_order": 1,
    },
    "starter": {
        "name": "Starter",
        "credits_per_month": 3000,
        "monthly_price_cents": 1900,  # USD display; INR set by Razorpay plan
        "annual_price_cents": 18240,  # 1900 * 12 * 0.8 (20% off)
        "annual_discount_percent": 20,
        "trial_days": 14,
        "limits": {
            "credits": 3000,
            "bots": 1,
            "operators": 1,
            "leads": 35,
            "page_scraping": 300,
            "documents": 15,
            "chat_history_days": 30,
            "max_crawl_depth": 3,
            "max_crawl_pages": 300,
            "max_crawl_js_pages": 60,
            "max_crawl_concurrency": 3,
        },
        "features": {
            "live_chat": True,
            "bant": True,
            "branding_removable": False,
            "webhooks": False,
            "api_access": False,
            "online_support": True,
            "topup_allowed": True,
            "integrations": "all",
        },
        "included_operator_seats": 1,
        "is_active": True,
        "sort_order": 2,
    },
    "standard": {
        "name": "Standard",
        "credits_per_month": 10000,
        "monthly_price_cents": 4900,
        "annual_price_cents": 47040,  # 4900 * 12 * 0.8
        "annual_discount_percent": 20,
        "trial_days": 0,
        "limits": {
            "credits": 10000,
            "bots": 2,
            "operators": 2,
            "leads": -1,  # unlimited
            "page_scraping": 1200,
            "documents": 35,
            "chat_history_days": 90,
            "max_crawl_depth": 4,
            "max_crawl_pages": 1200,
            "max_crawl_js_pages": 150,
            "max_crawl_concurrency": 4,
        },
        "features": {
            "live_chat": True,
            "bant": True,
            "branding_removable": True,
            "webhooks": True,
            "api_access": True,
            "online_support": True,
            "topup_allowed": True,
            "integrations": "all",
        },
        "included_operator_seats": 2,
        "is_active": True,
        "sort_order": 3,
    },
    "enterprise": {
        "name": "Enterprise",
        "credits_per_month": 0,  # Custom — actual amount set per contract
        "monthly_price_cents": 0,
        "annual_price_cents": 0,
        "annual_discount_percent": 0,
        "trial_days": 0,
        "limits": {
            "credits": -1,  # unlimited / custom
            "bots": -1,
            "operators": -1,
            "leads": -1,
            "page_scraping": -1,
            "documents": -1,
            "chat_history_days": -1,
            "max_crawl_depth": 6,
            "max_crawl_pages": 10000,
            "max_crawl_js_pages": 1000,
            "max_crawl_concurrency": 8,
        },
        "features": {
            "live_chat": True,
            "bant": True,
            "branding_removable": True,
            "webhooks": True,
            "api_access": True,
            "online_support": True,
            "custom_sla": True,
            "dedicated_csm": True,
            "topup_allowed": True,
            "integrations": "all_plus_custom",
        },
        "included_operator_seats": 5,
        "is_active": True,
        "sort_order": 4,
    },
}


def upgrade() -> None:
    conn = op.get_bind()

    for slug, data in _PLAN_DATA.items():
        # JSONB columns require ``json.dumps`` because Alembic's text() doesn't
        # auto-serialize dicts the way SQLAlchemy ORM does.
        import json

        limits_json = json.dumps(data["limits"])
        features_json = json.dumps(data["features"])

        # Update if exists; otherwise insert. The four canonical plans are
        # expected to exist (seeded earlier) but this is defensive.
        result = conn.execute(
            sa.text("SELECT id FROM plans WHERE slug = :slug"),
            {"slug": slug},
        ).fetchone()

        if result:
            conn.execute(
                sa.text(
                    """
                    UPDATE plans SET
                        name = :name,
                        credits_per_month = :credits_per_month,
                        monthly_price_cents = :monthly_price_cents,
                        annual_price_cents = :annual_price_cents,
                        annual_discount_percent = :annual_discount_percent,
                        trial_days = :trial_days,
                        limits = CAST(:limits AS JSONB),
                        features = CAST(:features AS JSONB),
                        included_operator_seats = :included_operator_seats,
                        is_active = :is_active,
                        sort_order = :sort_order
                    WHERE slug = :slug
                    """
                ),
                {
                    "slug": slug,
                    "name": data["name"],
                    "credits_per_month": data["credits_per_month"],
                    "monthly_price_cents": data["monthly_price_cents"],
                    "annual_price_cents": data["annual_price_cents"],
                    "annual_discount_percent": data["annual_discount_percent"],
                    "trial_days": data["trial_days"],
                    "limits": limits_json,
                    "features": features_json,
                    "included_operator_seats": data["included_operator_seats"],
                    "is_active": data["is_active"],
                    "sort_order": data["sort_order"],
                },
            )
        else:
            conn.execute(
                sa.text(
                    """
                    INSERT INTO plans
                        (slug, name, credits_per_month, monthly_price_cents,
                         annual_price_cents, annual_discount_percent, trial_days,
                         limits, features, included_operator_seats, is_active,
                         sort_order, currency, pricing_model)
                    VALUES
                        (:slug, :name, :credits_per_month, :monthly_price_cents,
                         :annual_price_cents, :annual_discount_percent, :trial_days,
                         CAST(:limits AS JSONB), CAST(:features AS JSONB),
                         :included_operator_seats, :is_active, :sort_order,
                         'INR', 'per_operator')
                    """
                ),
                {
                    "slug": slug,
                    "name": data["name"],
                    "credits_per_month": data["credits_per_month"],
                    "monthly_price_cents": data["monthly_price_cents"],
                    "annual_price_cents": data["annual_price_cents"],
                    "annual_discount_percent": data["annual_discount_percent"],
                    "trial_days": data["trial_days"],
                    "limits": limits_json,
                    "features": features_json,
                    "included_operator_seats": data["included_operator_seats"],
                    "is_active": data["is_active"],
                    "sort_order": data["sort_order"],
                },
            )

    # Also seed missing pricing_config row for document_upload (was being added
    # ad-hoc; the migration makes it canonical across environments).
    conn.execute(
        sa.text(
            """
            INSERT INTO pricing_config (key, value, updated_at)
            VALUES ('credit_cost.document_upload', '3', NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
            """
        )
    )
    # And update url_scan to 5 (was 3 in earlier seeds).
    conn.execute(
        sa.text(
            """
            INSERT INTO pricing_config (key, value, updated_at)
            VALUES ('credit_cost.url_scan', '5', NOW())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
            """
        )
    )


def downgrade() -> None:
    # Restore the pricing_config keys to their pre-migration values.
    conn = op.get_bind()
    conn.execute(
        sa.text(
            """
            UPDATE pricing_config SET value = '3', updated_at = NOW()
            WHERE key = 'credit_cost.url_scan'
            """
        )
    )
    conn.execute(
        sa.text(
            """
            DELETE FROM pricing_config WHERE key = 'credit_cost.document_upload'
            """
        )
    )
    # Plan rows are NOT rolled back — schema-level rollback would require
    # snapshotting the pre-migration JSONB which isn't worth the complexity
    # for a seed migration. Super admins can re-edit via the admin UI if
    # this is ever downgraded in production.
