"""Report subscriptions stranded by the old cancel → reactivate flow.

READ-ONLY. This script never writes to the database and never calls a
mutating Razorpay endpoint.

Background: ``/subscriptions/cancel`` used to issue Razorpay's cancel
immediately, ~30 days before the plan actually ended. Razorpay has no
un-cancel, so ``/subscriptions/resume`` had to mint a FRESH subscription.
Which, minted without ``start_at``, Razorpay started and charged in full right
away. Two failure modes came out of that:

1. **Double-charged overlap.** The customer paid a second full cycle for days
   they had already bought on the mandate being replaced. Nothing prorated,
   refunded or rolled the credits over.
2. **Orphan mandate.** If the post-checkout reconcile bailed out (Razorpay
   still reporting ``created``/``pending``, which is normal seconds after a UPI
   mandate closes) *and* the ``subscription.activated`` webhook never landed,
   the new mandate is live at Razorpay with **no local row at all**. It keeps
   debiting monthly, ``subscription.charged`` cannot resolve it, and the
   customer's Billing page still shows the old "won't renew" banner.

Both are fixed going forward, but rows created before the fix need a human
decision (refund the overlap vs adopt the new subscription). This script gives
you the facts to make it.

Usage:
    cd api && uv run python scripts/audit_reactivation_orphans.py

Add ``--json`` to emit machine-readable output for further processing.

Exit code is the number of subscriptions needing attention (0 = nothing found),
so it can be used as a CI/ops check.
"""

import argparse
import json
import sys
from typing import Any

from sqlalchemy import select

from app.db.models import Client, Invoice, Subscription
from app.db.session import get_session
from app.services import credit_service, razorpay_service


def _fetch_gateway_state(razorpay_subscription_id: str) -> dict[str, Any]:
    """Best-effort read of a Razorpay subscription. Never raises."""
    try:
        rzp = razorpay_service._get_razorpay()  # noqa: SLF001. Ops script, read-only
        entity = rzp.subscription.fetch(razorpay_subscription_id)
    except Exception as exc:  # noqa: BLE001, a fetch failure is data, not a crash
        return {"error": str(exc)}
    return {
        "status": entity.get("status"),
        "cancel_at_cycle_end": bool(entity.get("cancel_at_cycle_end")),
        "current_start": entity.get("current_start"),
        "current_end": entity.get("current_end"),
        "paid_count": entity.get("paid_count"),
        "notes": entity.get("notes") or {},
    }


def collect(session) -> list[dict[str, Any]]:
    """Every subscription with a reactivation checkout that never completed."""
    rows = (
        session.execute(
            select(Subscription)
            .where(
                Subscription.cancel_at_period_end.is_(True),
                Subscription.upgrade_pending_subscription_id.isnot(None),
            )
            .order_by(Subscription.client_id)
        )
        .scalars()
        .all()
    )

    findings: list[dict[str, Any]] = []
    for sub in rows:
        client = session.get(Client, sub.client_id)
        pending_id = sub.upgrade_pending_subscription_id

        # Did the pending mandate ever get a local row of its own? If not, it is
        # an orphan: live at Razorpay, invisible to this platform.
        adopted = session.scalars(
            select(Subscription).where(Subscription.razorpay_subscription_id == pending_id)
        ).first()

        # Money actually taken against the pending mandate. Invoices are keyed
        # on the payment id, not the subscription, so match through the local
        # row when there is one; otherwise report what the gateway says.
        paid_invoices = []
        if adopted is not None:
            paid_invoices = (
                session.execute(
                    select(Invoice)
                    .where(Invoice.subscription_id == adopted.id, Invoice.status == "paid")
                    .order_by(Invoice.id)
                )
                .scalars()
                .all()
            )

        gateway = _fetch_gateway_state(pending_id)
        balance = credit_service.get_balance_breakdown(session, sub.client_id)

        findings.append(
            {
                "client_id": sub.client_id,
                "client_email": client.email if client else None,
                "plan": sub.plan.slug if sub.plan else None,
                "billing_cycle": sub.billing_cycle,
                "bot_id": sub.bot_id,
                "old_subscription": {
                    "local_id": sub.id,
                    "razorpay_id": sub.razorpay_subscription_id,
                    "status": sub.status,
                    "current_period_end": (sub.current_period_end.isoformat() if sub.current_period_end else None),
                    "canceled_at": sub.canceled_at.isoformat() if sub.canceled_at else None,
                    "gateway_cancel_executed_at": (
                        sub.gateway_cancel_executed_at.isoformat() if sub.gateway_cancel_executed_at else None
                    ),
                },
                "pending_subscription": {
                    "razorpay_id": pending_id,
                    "adopted_locally": adopted is not None,
                    "local_id": adopted.id if adopted is not None else None,
                    "gateway": gateway,
                },
                "paid_invoices": [
                    {
                        "id": inv.id,
                        "number": inv.invoice_number,
                        "amount_cents": inv.amount_cents,
                        "currency": inv.currency,
                        "razorpay_payment_id": inv.razorpay_payment_id,
                        "paid_at": inv.paid_at.isoformat() if inv.paid_at else None,
                    }
                    for inv in paid_invoices
                ],
                "credit_balance": balance,
                # What a human should look at first.
                "verdict": _verdict(adopted is not None, gateway, bool(paid_invoices)),
            }
        )
    return findings


def _verdict(adopted: bool, gateway: dict[str, Any], has_paid_invoice: bool) -> str:
    if "error" in gateway:
        return "GATEWAY_UNREACHABLE. Could not read Razorpay; re-run before deciding"
    status = (gateway.get("status") or "").lower()
    if not adopted and status in ("active", "authenticated"):
        return "ORPHAN_MANDATE. Live at Razorpay with no local row; will keep debiting. Adopt or cancel."
    if not adopted:
        return f"ABANDONED_CHECKOUT, never authorised (gateway status '{status}'); safe to clear the marker."
    if has_paid_invoice and int(gateway.get("paid_count") or 0) >= 1:
        return "CHARGED. Reactivation was billed. Check the overlap against the old period end for a refund."
    return "ADOPTED. Local row exists; verify the period dates line up."


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="emit JSON instead of a human-readable report")
    args = parser.parse_args()

    with get_session() as session:
        findings = collect(session)

    if args.json:
        print(json.dumps(findings, indent=2, default=str))
        return len(findings)

    if not findings:
        print("No subscriptions with an in-flight reactivation checkout. Nothing to reconcile.")
        return 0

    print(f"{len(findings)} subscription(s) with an in-flight reactivation checkout:\n")
    for f in findings:
        old = f["old_subscription"]
        pending = f["pending_subscription"]
        gw = pending["gateway"]
        print(f"── client {f['client_id']} <{f['client_email']}> · plan {f['plan']} ({f['billing_cycle']})")
        print(f"   old sub  local#{old['local_id']} {old['razorpay_id']} status={old['status']}")
        print(f"            paid through {old['current_period_end']} · cancelled {old['canceled_at']}")
        print(f"            gateway cancel executed: {old['gateway_cancel_executed_at'] or 'NOT RECORDED'}")
        print(f"   new sub  {pending['razorpay_id']} adopted_locally={pending['adopted_locally']}")
        if "error" in gw:
            print(f"            gateway: UNREACHABLE ({gw['error']})")
        else:
            print(
                f"            gateway: status={gw['status']} paid_count={gw['paid_count']} "
                f"cancel_at_cycle_end={gw['cancel_at_cycle_end']}"
            )
        for inv in f["paid_invoices"]:
            print(
                f"   invoice  #{inv['id']} {inv['number'] or '(unnumbered)'} "
                f"{inv['currency'].upper()} {inv['amount_cents'] / 100:.2f} payment={inv['razorpay_payment_id']} "
                f"paid_at={inv['paid_at']}"
            )
        print(f"   credits  {f['credit_balance']}")
        print(f"   → {f['verdict']}\n")

    return len(findings)


if __name__ == "__main__":
    sys.exit(main())
