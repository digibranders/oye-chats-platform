"""Report clients holding more than one live Razorpay subscription in one scope.

READ-ONLY. This script never writes to the database and never calls a mutating
Razorpay endpoint, it cannot cancel anything. Duplicates are a money problem
in both directions (a stranded mandate keeps debiting; the "wrong" one of a
pair may be the one the customer actually authorised), so the decision stays
with a human. The report gives them the facts.

Background: ``/subscriptions/change-plan`` Branch 3 minted a first mandate with
no idempotency marker, so a retry while the first was still ``created`` minted a
SECOND authorizable subscription. Prod client 18 authorised both and paid
₹11,998 for one ₹5,999 month. The mint path is fixed (``pending_checkout_service``
now reuses the in-flight mandate and cancels a superseded one), but any pair
created BEFORE the fix (in Live as well as Test) is still out there, and a
duplicate is invisible locally at the moment it is most dangerous: seconds after
minting, neither subscription has a local row yet.

So the scan starts at the GATEWAY, which is the only complete view, and joins
the local DB onto it rather than the other way round.

What counts as a duplicate: two non-terminal subscriptions for the same client
IN THE SAME BILLING SCOPE. Scope matters because concurrency is legitimate in
some shapes and never in others:

* ``account``  . ``bot_id IS NULL``. At most one, ever
                  (``ix_subscriptions_client_legacy_active``). Two = CONFIRMED.
* ``bot:<id>`` , a named existing agent (resume / revive-in-place). One per
                  agent. Two = CONFIRMED.
* ``bot:new``  , a per-bot purchase that has not yet minted its Bot row, so it
                  names no agent. Two of these are indistinguishable from a
                  customer legitimately buying two agents in the same minute →
                  reported as REVIEW, not asserted as a defect.
* ``seat_addon``. Billed on its own mandate alongside the plan by design.
                  Excluded entirely.

Usage:
    cd api && uv run python scripts/audit_duplicate_gateway_subscriptions.py

    --json          machine-readable output
    --max-pages N   widen the gateway scan (default 50 pages × 100)

Exit code is the number of CONFIRMED duplicate groups (0 = clean), so it can be
wired to a cron/CI check that pages someone the first time it goes non-zero.
"""

import argparse
import json
import sys
from collections import defaultdict
from typing import Any

from sqlalchemy import select

from app.db.models import Client, Invoice, Subscription
from app.db.session import get_session
from app.services import razorpay_service

# Razorpay states in which a subscription can still take the customer's money:
# ``created``/``authenticated``/``pending`` are on their way up, ``active`` and
# ``halted`` are live. ``cancelled``/``completed``/``expired`` are terminal and
# harmless.
LIVE_STATES = frozenset({"created", "authenticated", "pending", "active", "halted"})

CONFIRMED = "CONFIRMED"
REVIEW = "REVIEW"


def _scope_of(notes: dict[str, Any]) -> str:
    """Billing scope key for a gateway subscription, from the notes we stamp."""
    purpose = str(notes.get("purpose") or "").lower()
    if purpose == "seat_addon":
        return "seat_addon"
    for key in ("oyechats_bot_id", "bot_id"):
        raw = notes.get(key)
        if raw:
            return f"bot:{raw}"
    if purpose == "per_bot_subscription":
        return "bot:new"
    return "account"


def _client_id_of(notes: dict[str, Any]) -> int | None:
    raw = notes.get("oyechats_client_id")
    try:
        return int(raw) if raw is not None else None
    except (TypeError, ValueError):
        return None


def _collect_gateway_groups(max_pages: int) -> dict[tuple[int, str], list[dict[str, Any]]]:
    """Group every LIVE gateway subscription by (client, billing scope)."""
    groups: dict[tuple[int, str], list[dict[str, Any]]] = defaultdict(list)
    for entity in razorpay_service.iter_gateway_subscriptions(
        max_pages=max_pages, caller="audit_duplicate_gateway_subscriptions"
    ):
        status = str(entity.get("status") or "").lower()
        if status not in LIVE_STATES:
            continue
        notes = entity.get("notes") or {}
        scope = _scope_of(notes)
        if scope == "seat_addon":
            continue
        client_id = _client_id_of(notes)
        if client_id is None:
            # No client in the notes: nothing to group it against, and it is a
            # separate (orphan) problem that audit_reactivation_orphans covers.
            continue
        groups[(client_id, scope)].append(
            {
                "razorpay_id": entity.get("id"),
                "status": status,
                "plan_id": entity.get("plan_id"),
                "paid_count": entity.get("paid_count"),
                "total_count": entity.get("total_count"),
                "created_at": entity.get("created_at"),
                "current_end": entity.get("current_end"),
                "cancel_at_cycle_end": entity.get("cancel_at_cycle_end"),
                "notes_plan_id": notes.get("oyechats_plan_id"),
                "billing_cycle": notes.get("billing_cycle"),
            }
        )
    return groups


def _local_view(session, client_id: int, razorpay_ids: list[str]) -> dict[str, Any]:
    """What our own DB believes about these ids, never the source of truth here."""
    client = session.get(Client, client_id)
    rows = (
        session.execute(select(Subscription).where(Subscription.razorpay_subscription_id.in_(razorpay_ids)))
        .scalars()
        .all()
    )
    by_id = {row.razorpay_subscription_id: row for row in rows}
    invoices = (
        session.execute(
            select(Invoice)
            .where(Invoice.client_id == client_id, Invoice.status == "paid")
            .order_by(Invoice.id.desc())
            .limit(10)
        )
        .scalars()
        .all()
    )
    return {
        "client_email": client.email if client else None,
        "local_rows": {
            rzp_id: (
                {
                    "local_id": by_id[rzp_id].id,
                    "status": by_id[rzp_id].status,
                    "bot_id": by_id[rzp_id].bot_id,
                    "plan_id": by_id[rzp_id].plan_id,
                    "current_period_end": by_id[rzp_id].current_period_end,
                }
                if rzp_id in by_id
                else None
            )
            for rzp_id in razorpay_ids
        },
        "recent_paid_invoices": [
            {
                "id": inv.id,
                "subscription_id": inv.subscription_id,
                "amount_cents": inv.amount_cents,
                "currency": inv.currency,
                "razorpay_payment_id": inv.razorpay_payment_id,
                "paid_at": inv.paid_at,
            }
            for inv in invoices
        ],
    }


def _build_findings(max_pages: int) -> list[dict[str, Any]]:
    groups = _collect_gateway_groups(max_pages)
    findings: list[dict[str, Any]] = []
    with get_session() as session:
        for (client_id, scope), subs in sorted(groups.items()):
            if len(subs) < 2:
                continue
            severity = REVIEW if scope == "bot:new" else CONFIRMED
            razorpay_ids = [s["razorpay_id"] for s in subs if s["razorpay_id"]]
            charged = [s for s in subs if int(s.get("paid_count") or 0) > 0]
            findings.append(
                {
                    "severity": severity,
                    "client_id": client_id,
                    "scope": scope,
                    "subscriptions": sorted(subs, key=lambda s: s.get("created_at") or 0),
                    "charged_count": len(charged),
                    **_local_view(session, client_id, razorpay_ids),
                }
            )
    # Loudest first: a pair where BOTH have already taken money is a refund.
    findings.sort(key=lambda f: (f["severity"] != CONFIRMED, -f["charged_count"], f["client_id"]))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    parser.add_argument("--max-pages", type=int, default=50, help="gateway pages to scan (100 subscriptions each)")
    args = parser.parse_args()

    findings = _build_findings(args.max_pages)
    confirmed = [f for f in findings if f["severity"] == CONFIRMED]

    if args.json:
        print(json.dumps(findings, indent=2, default=str))
        return len(confirmed)

    if not findings:
        print("No client holds more than one live Razorpay subscription in a single billing scope.")
        return 0

    print(f"{len(findings)} duplicate group(s) - {len(confirmed)} confirmed:\n")
    for f in findings:
        print(f"── [{f['severity']}] client {f['client_id']} <{f['client_email']}> · scope {f['scope']}")
        for s in f["subscriptions"]:
            local = f["local_rows"].get(s["razorpay_id"])
            local_txt = (
                f"local#{local['local_id']} status={local['status']} bot={local['bot_id']}" if local else "NO LOCAL ROW"
            )
            print(
                f"   {s['razorpay_id']} status={s['status']} paid_count={s['paid_count']} "
                f"plan={s['plan_id']} cycle={s['billing_cycle']} · {local_txt}"
            )
        if f["charged_count"] > 1:
            print(f"   !! {f['charged_count']} of these have ALREADY CHARGED. Expect a refund, not just a cancel")
        for inv in f["recent_paid_invoices"]:
            print(
                f"   invoice #{inv['id']} sub={inv['subscription_id']} "
                f"{str(inv['currency']).upper()} {inv['amount_cents'] / 100:.2f} "
                f"payment={inv['razorpay_payment_id']} paid_at={inv['paid_at']}"
            )
        print("   → decide by hand: which mandate the customer meant to keep, then cancel + refund the other.\n")

    return len(confirmed)


if __name__ == "__main__":
    sys.exit(main())
