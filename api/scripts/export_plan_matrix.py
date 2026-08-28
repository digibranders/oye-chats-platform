"""Export the plan entitlement matrix for the public documentation site.

The docs used to restate plan gating in prose, and it drifted. Twice in one
review. Two of the misses were not even in ``seed_plans``: delta re-crawl and
visitor intelligence are gated by separate slug sets in the services layer, so
reading the plan matrix alone would still have got them wrong.

This collects BOTH sources into one artifact the docs render directly:

* ``seed_plans._PLANS``, the canonical per-tier limits and ``features`` flags.
* The slug sets in ``plan_entitlements_service`` / ``plan_service`` that gate
  capabilities outside the ``features`` column.

Prices are deliberately excluded. They are geo-gated and live on the pricing
page; the docs link there rather than restating figures that would drift.

Usage (from ``platform/api``):

    uv run python scripts/export_plan_matrix.py \
        --out ../../oyechats-website/src/lib/docs/plan-matrix.generated.json

``--check`` exits non-zero when the destination is stale, for CI.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any

sys.path.append(os.path.join(os.path.dirname(__file__), ".."))


def _load_seed_plans() -> list[dict[str, Any]]:
    """Import ``_PLANS`` from the seed script without running the seeder."""
    spec = importlib.util.spec_from_file_location("_seed_plans_for_export", Path(__file__).with_name("seed_plans.py"))
    if spec is None or spec.loader is None:  # pragma: no cover - import plumbing
        raise RuntimeError("could not load seed_plans.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return list(module._PLANS)


# Capabilities gated OUTSIDE ``Plan.features``. Each entry names the constant it
# is read from so a reader can verify the claim at source, and so a rename
# breaks this export loudly instead of silently shipping a stale matrix.
def _external_capabilities() -> list[dict[str, Any]]:
    from app.services.plan_entitlements_service import (
        EMAIL_VERIFICATION_SLUGS,
        JOURNEY_ANALYTICS_SLUGS,
        LEAD_SOURCE_ATTRIBUTION_SLUGS,
        VISITOR_INTELLIGENCE_SLUGS,
    )
    from app.services.plan_service import _DELTA_RECRAWL_PLAN_SLUGS

    return [
        {
            "key": "journey_analytics",
            "label": "Visitor journey analytics",
            "source": "plan_entitlements_service.JOURNEY_ANALYTICS_SLUGS",
            "slugs": sorted(JOURNEY_ANALYTICS_SLUGS),
        },
        {
            "key": "lead_source_attribution",
            "label": "Lead source attribution (UTM, referrer, landing page)",
            "source": "plan_entitlements_service.LEAD_SOURCE_ATTRIBUTION_SLUGS",
            "slugs": sorted(LEAD_SOURCE_ATTRIBUTION_SLUGS),
        },
        {
            "key": "email_verification",
            "label": "Background email verification of leads",
            "source": "plan_entitlements_service.EMAIL_VERIFICATION_SLUGS",
            "slugs": sorted(EMAIL_VERIFICATION_SLUGS),
        },
        {
            "key": "visitor_intelligence",
            "label": "Visitor company / network identification",
            "source": "plan_entitlements_service.VISITOR_INTELLIGENCE_SLUGS",
            "slugs": sorted(VISITOR_INTELLIGENCE_SLUGS),
        },
        {
            "key": "delta_recrawl",
            "label": "Re-crawl updated pages only (instead of the whole site)",
            "source": "plan_service._DELTA_RECRAWL_PLAN_SLUGS",
            "slugs": sorted(_DELTA_RECRAWL_PLAN_SLUGS),
        },
    ]


# Human labels for the ``Plan.features`` booleans worth showing publicly.
# Anything not listed here is omitted from the docs matrix. `sso`,
# `advanced_analytics`, `custom_sla`, `dedicated_csm` and `whitelabel` exist on
# the model's server_default but are not seeded per tier, and `api_access` is
# declared but not enforced anywhere, so publishing them would be a promise.
#
# `branding_removable` is deliberately absent: it is no longer a plan
# inclusion. It is a paid add-on any paid tier can buy, resolved from the
# subscription's add-on mandate rather than from `Plan.features`, so a matrix
# row keyed off the plan JSONB would publish an all-dashes row (it is `false`
# on every tier) and read as "no plan can remove branding". Add-ons are
# published separately, next to extra operator seats.
_FEATURE_LABELS: dict[str, str] = {
    "live_chat": "Live chat with human operators",
    "bant": "Lead qualification scoring",
    "webhooks": "Webhooks",
    "auto_recrawl": "Automatic weekly re-crawl",
    "topup_allowed": "Credit top-ups",
}

# Limits worth publishing, in display order. Crawl-engine knobs
# (`max_crawl_concurrency`, `max_crawl_js_pages`) are omitted: they describe
# how the crawler is tuned, not something a customer chooses.
_LIMIT_LABELS: list[tuple[str, str]] = [
    ("credits", "Credits per month"),
    ("bots", "Chatbots"),
    ("operators", "Included operator seats"),
    ("leads", "Leads stored"),
    ("page_scraping", "Crawlable pages"),
    ("documents", "Uploaded documents"),
    ("knowledge_characters", "Knowledge base size (characters)"),
    ("chat_history_days", "Chat history window (days)"),
    ("max_crawl_depth", "Maximum crawl depth"),
]


def build_matrix() -> dict[str, Any]:
    # Non-public rows are excluded wholesale. This feed renders the public
    # documentation's plan and capability tables, and the signup trial is
    # seeded ``is_public: False`` precisely so it never appears anywhere a
    # reader would take it for a tier they can choose. Capability rows are
    # clamped to the same set below, because a ladder constant that names the
    # trial (it carries Professional's entitlements) would otherwise leak the
    # slug into a published column with no plan row to explain it.
    plans = [p for p in _load_seed_plans() if p["is_public"]]
    published = {p["slug"] for p in plans}
    paid_slugs = [p["slug"] for p in plans if p["slug"] != "free"]

    capabilities: list[dict[str, Any]] = [
        {
            "key": key,
            "label": label,
            "source": "seed_plans._PLANS[].features",
            "slugs": [p["slug"] for p in plans if p["features"].get(key) is True],
        }
        for key, label in _FEATURE_LABELS.items()
    ]

    # Lead intelligence is a predicate, not a slug set: every paid tier gets it
    # (``is_lead_intelligence_enabled`` returns True for any non-"free" plan).
    capabilities.append(
        {
            "key": "lead_intelligence",
            "label": "Lead score, tier, dimension breakdown and CSV export",
            "source": "plan_entitlements_service.is_lead_intelligence_enabled (any non-free plan)",
            "slugs": paid_slugs,
        }
    )
    capabilities.extend(
        {**capability, "slugs": [slug for slug in capability["slugs"] if slug in published]}
        for capability in _external_capabilities()
    )

    return {
        "$comment": (
            "GENERATED by platform/api/scripts/export_plan_matrix.py. Do not edit by hand. "
            "re-run the exporter instead. Prices are deliberately excluded; they live on /pricing."
        ),
        "plans": [
            {
                "slug": p["slug"],
                "name": p["name"],
                "tagline": (p.get("marketing") or {}).get("tagline"),
                "trial_days": p["trial_days"],
                "included_operator_seats": p["included_operator_seats"],
                "limits": {key: p["limits"].get(key) for key, _ in _LIMIT_LABELS},
            }
            for p in plans
        ],
        "limit_labels": [{"key": k, "label": v} for k, v in _LIMIT_LABELS],
        "capabilities": capabilities,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="Destination JSON file.")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Exit non-zero if the destination differs from freshly generated output.",
    )
    args = parser.parse_args()

    rendered = json.dumps(build_matrix(), indent=2) + "\n"
    destination = Path(args.out).resolve()

    if args.check:
        current = destination.read_text() if destination.exists() else ""
        if current != rendered:
            print(f"{destination} is stale. Re-run without --check.", file=sys.stderr)
            return 1
        print(f"{destination} is up to date.")
        return 0

    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(rendered)
    matrix = json.loads(rendered)
    print(
        f"Wrote {destination}\n"
        f"  plans        : {len(matrix['plans'])}\n"
        f"  limits       : {len(matrix['limit_labels'])}\n"
        f"  capabilities : {len(matrix['capabilities'])}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
