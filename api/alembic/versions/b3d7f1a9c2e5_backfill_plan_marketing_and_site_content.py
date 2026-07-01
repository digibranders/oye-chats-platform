"""backfill plan marketing and pricing site content

One-time data backfill so the marketing website renders identically the moment
it switches to the live ``/public/pricing-catalog`` feed. Populates:

* ``plans.marketing`` for the four canonical slugs (tagline, badge, accent,
  CTA, highlight bullets, featured) — only when still empty, so it never
  clobbers edits a super-admin already made from the admin panel.
* the four ``pricing_config`` content blobs (FAQ, feature matrix, top-up packs,
  credit costs) — only when still the empty ``[]`` seed.

Values mirror the previously-hardcoded constants in the website's
``src/lib/pricing.ts`` at cutover time.

Revision ID: b3d7f1a9c2e5
Revises: d8db16e4aea3
Create Date: 2026-06-30 20:10:00.000000
"""

import json

import sqlalchemy as sa

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "b3d7f1a9c2e5"
down_revision: str = "d8db16e4aea3"
branch_labels = None
depends_on = None

_APP = "https://app.oyechats.com"

_PLAN_MARKETING: dict[str, dict] = {
    "free": {
        "tagline": "Start exploring AI-powered chat",
        "accent": "blue",
        "cta_label": "Get started",
        "cta_href": f"{_APP}/register",
        "highlight_features": [
            "200 credits / month",
            "1 chatbot",
            "Basic widget customization",
            "Lead capture forms",
        ],
        "featured": False,
    },
    "starter": {
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
    },
    "standard": {
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
    },
    "enterprise": {
        "tagline": "Custom credits, dedicated support",
        "accent": "indigo",
        "cta_label": "Contact sales",
        "cta_href": "/contact?intent=enterprise",
        "highlight_features": [
            "Custom credit allocation",
            "Unlimited chatbots",
            "Unlimited operator seats",
            "BANT lead qualification scoring",
            "Dedicated account manager",
            "Custom SLA & uptime guarantee",
        ],
        "featured": False,
    },
}

_FEATURE_MATRIX = [
    {
        "label": "Monthly price",
        "category": "usage",
        "values": {"free": "Free", "starter": "$19 / month", "standard": "$49 / month", "enterprise": "Custom"},
    },
    {
        "label": "Annual price (save ~20%)",
        "category": "usage",
        "values": {
            "free": "-",
            "starter": "$15/mo ($180/yr)",
            "standard": "$39/mo ($468/yr)",
            "enterprise": "Contact us",
        },
    },
    {
        "label": "Monthly credits",
        "category": "usage",
        "values": {"free": "200", "starter": "3,000", "standard": "10,000", "enterprise": "Custom"},
    },
    {
        "label": "Chatbots included",
        "category": "usage",
        "values": {
            "free": "1",
            "starter": "1 (subscribe again to add more)",
            "standard": "1 (subscribe again to add more)",
            "enterprise": "Unlimited under one subscription",
        },
    },
    {
        "label": "Operator seats included",
        "category": "usage",
        "values": {"free": "-", "starter": "1", "standard": "2", "enterprise": "Unlimited"},
    },
    {
        "label": "Extra operator seats",
        "category": "usage",
        "values": {
            "free": "-",
            "starter": "$5/mo each (up to 5 total)",
            "standard": "$5/mo each (up to 10 total)",
            "enterprise": "Custom",
        },
    },
    {
        "label": "Top-up packs available",
        "category": "usage",
        "values": {"free": False, "starter": True, "standard": True, "enterprise": True},
    },
    {
        "label": "Live operator chat",
        "category": "features",
        "values": {"free": False, "starter": True, "standard": True, "enterprise": True},
    },
    {
        "label": "BANT lead qualification",
        "category": "features",
        "values": {"free": False, "starter": True, "standard": True, "enterprise": True},
    },
    {
        "label": "Webhooks",
        "category": "features",
        "values": {"free": False, "starter": False, "standard": "5 event types", "enterprise": "All events"},
    },
    {
        "label": "Dedicated account manager",
        "category": "features",
        "values": {"free": False, "starter": False, "standard": False, "enterprise": True},
    },
    {
        "label": "Custom SLA & uptime",
        "category": "security",
        "values": {"free": False, "starter": False, "standard": False, "enterprise": True},
    },
]

_FAQ = [
    {
        "q": "What's a credit?",
        "a": "Credits are how OyeChats meters work. Each AI chat reply uses 1 credit, each URL page we crawl + ingest "
        "uses 3 credits, and each customer-facing email (lead alerts, conversation summaries) uses 1 credit. "
        "System emails like password resets and operator notifications are always free.",
    },
    {
        "q": "How do I pay?",
        "a": "We use Razorpay for Indian customers, UPI, cards, NetBanking, and wallets are all supported. Stripe is "
        "available for international payments. You can switch payment methods any time from the Billing page.",
    },
    {
        "q": "Is there a free trial?",
        "a": "Yes, Starter and Standard plans include a 14-day free trial with full access to all features. No credit "
        "card required.",
    },
    {
        "q": "What happens when I run out of credits?",
        "a": "Your bot pauses new conversations until your monthly credits reset, or you can buy a top-up pack any time "
        "from the Billing page. We never let costs run away, we hard-cap at zero, with a friendly message to "
        "visitors.",
    },
    {
        "q": "Do unused credits roll over?",
        "a": "Plan credits reset at the start of each billing cycle (use-it-or-lose-it). Top-up credits roll over for "
        "12 months from purchase, oldest first, so larger packs always pay off if you keep using the product.",
    },
    {
        "q": "Can I add more operator seats?",
        "a": "Yes, extra seats are $5 / month each, and you can add or remove them with one click from the Billing "
        "page in your dashboard.",
    },
    {
        "q": "How do I run multiple chatbots on one account?",
        "a": 'Each chatbot is its own subscription. From the dashboard, click "Add Bot" and pick a plan for that bot '
        "— credits, billing, and usage stay isolated per bot so a busy chatbot can never drain a quieter one. "
        "Enterprise accounts can run unlimited bots under a single master subscription.",
    },
    {
        "q": "Can I change plans at any time?",
        "a": "Absolutely. Upgrade, downgrade, or cancel any time from your dashboard. Downgrades take effect at the end "
        "of the billing cycle.",
    },
    {
        "q": "How does BANT scoring work?",
        "a": "OyeChats analyzes every conversation across Budget, Authority, Need, and Timeline, scoring each 0-100. "
        "The composite score drives webhook notifications and lead-tier assignments.",
    },
    {
        "q": "Is annual billing charged upfront?",
        "a": "Yes, annual billing is charged as a single payment at the start of the year, giving you approximately "
        "20% savings versus monthly.",
    },
    {
        "q": "Do you offer discounts for startups or non-profits?",
        "a": "Yes, contact us at support@oyechats.com and we'll work out the right pricing.",
    },
]

_TOPUP_PACKS = [
    {"usd": 19, "credits": 2000, "bonusPct": 0, "perThousandUsd": 9.5},
    {"usd": 49, "credits": 5500, "bonusPct": 10, "perThousandUsd": 8.91},
    {"usd": 99, "credits": 12000, "bonusPct": 20, "badge": "Best value", "perThousandUsd": 8.25},
    {"usd": 239, "credits": 32500, "bonusPct": 30, "perThousandUsd": 7.35},
]

_CREDIT_COSTS = [
    {"action": "1 AI chat reply", "credits": 1},
    {"action": "1 URL page crawl + ingest", "credits": 3},
    {"action": "1 customer-facing email (lead alert / summary)", "credits": 1},
]

_CONTENT = {
    "pricing_faq": _FAQ,
    "pricing_feature_matrix": _FEATURE_MATRIX,
    "pricing_topup_packs": _TOPUP_PACKS,
    "pricing_credit_costs": _CREDIT_COSTS,
}


def upgrade() -> None:
    conn = op.get_bind()

    # Backfill per-plan marketing only where still empty (never clobber edits).
    for slug, marketing in _PLAN_MARKETING.items():
        conn.execute(
            sa.text(
                "UPDATE plans SET marketing = CAST(:v AS JSONB) "
                "WHERE slug = :slug AND (marketing IS NULL OR marketing = '{}'::jsonb)"
            ),
            {"v": json.dumps(marketing), "slug": slug},
        )

    # Populate site-content blobs only where still the empty [] seed.
    for key, value in _CONTENT.items():
        conn.execute(
            sa.text(
                "INSERT INTO pricing_config (key, value) VALUES (:k, CAST(:v AS JSONB)) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value "
                "WHERE pricing_config.value = '[]'::jsonb"
            ),
            {"k": key, "v": json.dumps(value)},
        )


def downgrade() -> None:
    conn = op.get_bind()
    for slug in _PLAN_MARKETING:
        conn.execute(
            sa.text("UPDATE plans SET marketing = '{}'::jsonb WHERE slug = :slug"),
            {"slug": slug},
        )
    for key in _CONTENT:
        conn.execute(
            sa.text("UPDATE pricing_config SET value = '[]'::jsonb WHERE key = :k"),
            {"k": key},
        )
