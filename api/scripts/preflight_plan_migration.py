"""Pre-deploy verification for the matrix-seed migration (d3e4f5a6b7c8).

Before running ``alembic upgrade head`` in production, this script reports:

1. The current limits/features per plan vs. the values the migration will set.
2. The active-subscription headcount per plan (what gets affected).
3. Customers who'd be over their NEW plan limit right after the migration
   (i.e. they have 6 documents but the new Free limit is 5) so support
   knows who to notify proactively.
4. The current ``pricing_config`` rows for credit costs vs. what the
   migration will set.
5. Whether the four canonical plan slugs even exist (catches the
   misconfigured-environment scenario).

Output is plain text + a final summary banner that says either
``READY TO DEPLOY`` or ``REVIEW REQUIRED`` so a deployer can quickly
decide whether to proceed.

## Usage

    python -m scripts.preflight_plan_migration

    # Scope to a single client (dry-validate a specific customer record):
    python -m scripts.preflight_plan_migration --client-id 42

    # Output JSON (for CI consumption):
    python -m scripts.preflight_plan_migration --json

The script never mutates anything. Safe to run against production
read-replicas.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))

from sqlalchemy import distinct, func, select, text  # noqa: E402

from app.db.models import (  # noqa: E402
    Bot,
    Document,
    LeadInfo,
    Operator,
    Plan,
    Subscription,
)
from app.db.session import get_session  # noqa: E402

# ── Expected post-migration values (mirror of d3e4f5a6b7c8) ────────────────
#
# Kept in sync with the migration's _PLAN_DATA constant. Single source of
# truth would be nice but a deploy-safety script that depends on the same
# Python module it's verifying is too clever — better to maintain two
# slightly-redundant maps and reconcile manually when the matrix shifts.

EXPECTED_PLAN_LIMITS = {
    "free": {"credits": 250, "bots": 1, "operators": 0, "leads": 15, "page_scraping": 30, "documents": 5},
    "starter": {"credits": 3000, "bots": 1, "operators": 1, "leads": 35, "page_scraping": 300, "documents": 15},
    "standard": {"credits": 10000, "bots": 2, "operators": 2, "leads": -1, "page_scraping": 1200, "documents": 35},
    "enterprise": {"credits": -1, "bots": -1, "operators": -1, "leads": -1, "page_scraping": -1, "documents": -1},
}

EXPECTED_PLAN_FEATURES = {
    "free": {"live_chat": False, "bant": False, "topup_allowed": False, "webhooks": False, "api_access": False},
    "starter": {"live_chat": True, "bant": True, "topup_allowed": True, "webhooks": False, "api_access": False},
    "standard": {"live_chat": True, "bant": True, "topup_allowed": True, "webhooks": True, "api_access": True},
    "enterprise": {"live_chat": True, "bant": True, "topup_allowed": True, "webhooks": True, "api_access": True},
}

EXPECTED_PRICING = {
    "credit_cost.ai_chat": 1,
    "credit_cost.url_scan": 5,
    "credit_cost.document_upload": 3,
    "credit_cost.email_send": 1,
}


# ── Reporting ──────────────────────────────────────────────────────────────


def collect_plan_diff(session) -> list[dict]:
    """For each canonical plan, return a per-key diff between current and expected."""
    report = []
    for slug, expected_limits in EXPECTED_PLAN_LIMITS.items():
        plan = session.execute(select(Plan).where(Plan.slug == slug)).scalar_one_or_none()
        if plan is None:
            report.append({"slug": slug, "missing": True})
            continue

        cur_limits = plan.limits or {}
        cur_features = plan.features or {}
        expected_features = EXPECTED_PLAN_FEATURES.get(slug, {})

        limit_diffs = {
            key: {"current": cur_limits.get(key), "expected": expected}
            for key, expected in expected_limits.items()
            if cur_limits.get(key) != expected
        }
        feature_diffs = {
            key: {"current": cur_features.get(key), "expected": expected}
            for key, expected in expected_features.items()
            if cur_features.get(key) != expected
        }

        report.append(
            {
                "slug": slug,
                "plan_id": plan.id,
                "missing": False,
                "limit_diffs": limit_diffs,
                "feature_diffs": feature_diffs,
                "active_subs": session.execute(
                    select(func.count(Subscription.id)).where(
                        Subscription.plan_id == plan.id,
                        Subscription.status.in_(("trialing", "active", "past_due")),
                    )
                ).scalar_one(),
            }
        )
    return report


def collect_pricing_diff(session) -> dict:
    """Compare each expected pricing key vs the live DB value."""
    cur_rows = session.execute(text("SELECT key, value FROM pricing_config WHERE key LIKE 'credit_cost%'")).all()
    cur = {row[0]: row[1] for row in cur_rows}
    out = {}
    for key, expected in EXPECTED_PRICING.items():
        cur_val = cur.get(key)
        try:
            cur_val_int = int(cur_val) if cur_val is not None else None
        except (TypeError, ValueError):
            cur_val_int = cur_val
        out[key] = {
            "current": cur_val_int,
            "expected": expected,
            "matches": cur_val_int == expected,
        }
    return out


def collect_over_limit_customers(session, client_id: int | None) -> list[dict]:
    """Customers whose current usage would exceed the new plan limits.

    These customers won't be deleted or downgraded — the new limits stop
    them from CREATING more, not from KEEPING what they already have.
    But support should notify them proactively so they know their next
    add will be blocked.
    """
    out = []
    for slug, expected_limits in EXPECTED_PLAN_LIMITS.items():
        # Find clients on this plan
        plan = session.execute(select(Plan).where(Plan.slug == slug)).scalar_one_or_none()
        if plan is None:
            continue

        sub_stmt = select(Subscription.client_id).where(
            Subscription.plan_id == plan.id,
            Subscription.status.in_(("trialing", "active", "past_due")),
        )
        if client_id is not None:
            sub_stmt = sub_stmt.where(Subscription.client_id == client_id)

        client_ids = list(session.execute(sub_stmt).scalars().all())

        for cid in client_ids:
            usage = {
                "bots": int(
                    session.execute(
                        select(func.count(Bot.id)).where(Bot.client_id == cid, Bot.is_active.is_(True))
                    ).scalar_one()
                    or 0
                ),
                "operators": int(
                    session.execute(
                        select(func.count(Operator.id)).where(Operator.client_id == cid, Operator.is_active.is_(True))
                    ).scalar_one()
                    or 0
                ),
                "documents": int(
                    session.execute(
                        select(func.count(distinct(Document.document_name))).where(Document.client_id == cid)
                    ).scalar_one()
                    or 0
                ),
                "leads": int(
                    session.execute(
                        select(func.count(LeadInfo.id)).join(Bot, LeadInfo.bot_id == Bot.id).where(Bot.client_id == cid)
                    ).scalar_one()
                    or 0
                ),
            }
            violations = {
                key: {"current_usage": usage[key], "new_limit": expected_limits.get(key)}
                for key in ("bots", "operators", "documents", "leads")
                if expected_limits.get(key, -1) != -1 and usage[key] > expected_limits[key]
            }
            if violations:
                out.append(
                    {
                        "client_id": cid,
                        "plan": slug,
                        "violations": violations,
                    }
                )
    return out


# ── Main ──────────────────────────────────────────────────────────────────


def render_text(plan_diffs, pricing_diffs, over_limit) -> str:
    lines = []
    lines.append("\n=== PLAN ROWS ===")
    for d in plan_diffs:
        if d["missing"]:
            lines.append(f"  [{d['slug']:<10}] ❌ MISSING — migration will INSERT this plan")
            continue
        marker = "✓" if not d["limit_diffs"] and not d["feature_diffs"] else "Δ"
        lines.append(f"  [{d['slug']:<10}] {marker}  active_subs={d['active_subs']}")
        for key, diff in d["limit_diffs"].items():
            lines.append(f"      limit  {key}: {diff['current']!r} → {diff['expected']!r}")
        for key, diff in d["feature_diffs"].items():
            lines.append(f"      feat   {key}: {diff['current']!r} → {diff['expected']!r}")

    lines.append("\n=== PRICING CONFIG ===")
    for key, info in pricing_diffs.items():
        marker = "✓" if info["matches"] else "Δ"
        lines.append(f"  {marker} {key}: {info['current']!r} → {info['expected']!r}")

    lines.append("\n=== CUSTOMERS OVER NEW LIMITS ===")
    if not over_limit:
        lines.append("  ✓ None — no customer would be over-limit after migration")
    else:
        for v in over_limit[:25]:
            lines.append(f"  client={v['client_id']} plan={v['plan']}")
            for key, detail in v["violations"].items():
                lines.append(f"      {key}: usage={detail['current_usage']} > new_limit={detail['new_limit']}")
        if len(over_limit) > 25:
            lines.append(f"  ...and {len(over_limit) - 25} more")

    # Verdict
    any_missing_plan = any(d.get("missing") for d in plan_diffs)
    any_diff = any(d.get("limit_diffs") or d.get("feature_diffs") for d in plan_diffs if not d.get("missing"))
    any_pricing_diff = any(not info["matches"] for info in pricing_diffs.values())

    if any_missing_plan:
        verdict = "BLOCKED — missing plan rows; investigate before running migration"
    elif over_limit:
        verdict = "REVIEW REQUIRED — customers above new limits; notify support team"
    elif any_diff or any_pricing_diff:
        verdict = "READY TO DEPLOY — migration will apply the listed diffs"
    else:
        verdict = "NO-OP — production already matches the matrix"

    lines.append("\n" + "=" * 60)
    lines.append(f"VERDICT: {verdict}")
    lines.append("=" * 60)

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Verify the matrix-seed migration before applying it.")
    parser.add_argument("--client-id", type=int, default=None, help="Scope over-limit check to one client.")
    parser.add_argument("--json", action="store_true", help="Output machine-readable JSON.")
    args = parser.parse_args()

    with get_session() as session:
        plan_diffs = collect_plan_diff(session)
        pricing_diffs = collect_pricing_diff(session)
        over_limit = collect_over_limit_customers(session, client_id=args.client_id)

    if args.json:
        print(json.dumps({"plans": plan_diffs, "pricing": pricing_diffs, "over_limit": over_limit}, indent=2))
    else:
        print(render_text(plan_diffs, pricing_diffs, over_limit))


if __name__ == "__main__":
    main()
