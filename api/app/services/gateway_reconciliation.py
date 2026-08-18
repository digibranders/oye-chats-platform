"""Daily gateway reconciliation, the blueprint §7 safety net (Wave 3.5).

Report-only diff of Razorpay's view of the money against ours. Every other
billing safeguard protects a specific path; this job is the catch-all that
proves, once a day, that nothing slipped between them:

* every **captured gateway payment** in the window has a local invoice, and a
  plan-charge invoice has its linked credit grant, a missing invoice is
  undocumented revenue (GST exposure), a missing grant is a customer who paid
  and got nothing;
* every **live gateway subscription** has a live local row, a live mandate
  over a terminal local row keeps DEBITING a customer who gets no service;
* every **live local gateway-backed row** has a live gateway subscription.
  Service keeps running with no money behind it.

Deliberately report-only: reconciliation NEVER mutates money state. Deltas are
ERROR-logged (Sentry) and persisted to ``reconciliation_runs`` for the
superadmin surface. The fetchers are injectable for tests; production wiring
uses the Razorpay SDK with bounded pagination.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import CreditLedger, Invoice, ReconciliationRun, Subscription

logger = logging.getLogger("oyechats.reconciliation")

# Local statuses that still entitle service / can still be billed.
_LOCAL_LIVE = ("active", "trialing", "past_due")
# Gateway statuses under which Razorpay can still charge the mandate.
# ``authenticated`` is live-by-design: deferred starts (resume cutover, launch
# promo) sit there until their first charge.
_GATEWAY_LIVE = ("active", "authenticated", "pending", "halted")
# Gateway terminal states, the mandate can never charge again.
_GATEWAY_DEAD = ("cancelled", "completed", "expired")

# Pagination bounds for the real SDK fetchers: 100 items/page (Razorpay max)
# with a hard page cap so a runaway account list can never wedge the cron.
_PAGE_SIZE = 100
_MAX_PAGES = 200


def _fetch_captured_payments_sdk(window_from: datetime, window_to: datetime) -> list[dict[str, Any]]:
    """All captured payments in the window, via the Razorpay SDK (paginated)."""
    from app.services.razorpay_service import _get_razorpay

    rzp = _get_razorpay()
    items: list[dict[str, Any]] = []
    for page in range(_MAX_PAGES):
        resp = rzp.payment.all(
            {
                "from": int(window_from.timestamp()),
                "to": int(window_to.timestamp()),
                "count": _PAGE_SIZE,
                "skip": page * _PAGE_SIZE,
            }
        )
        batch = resp.get("items") or []
        items.extend(p for p in batch if (p.get("status") or "").lower() == "captured")
        if len(batch) < _PAGE_SIZE:
            break
    else:
        logger.warning("gateway reconciliation: payment pagination hit the %d-page cap", _MAX_PAGES)
    return items


def _fetch_gateway_subscriptions_sdk() -> list[dict[str, Any]]:
    """Every gateway subscription, via the Razorpay SDK (paginated).

    Razorpay's subscription list API has no server-side status filter worth
    trusting across API versions, so we fetch all and classify locally.
    """
    from app.services.razorpay_service import _get_razorpay

    rzp = _get_razorpay()
    items: list[dict[str, Any]] = []
    for page in range(_MAX_PAGES):
        resp = rzp.subscription.all({"count": _PAGE_SIZE, "skip": page * _PAGE_SIZE})
        batch = resp.get("items") or []
        items.extend(batch)
        if len(batch) < _PAGE_SIZE:
            break
    else:
        logger.warning("gateway reconciliation: subscription pagination hit the %d-page cap", _MAX_PAGES)
    return items


def run_gateway_reconciliation(
    session: Session,
    *,
    fetch_captured_payments: Callable[[datetime, datetime], Iterable[dict[str, Any]]] | None = None,
    fetch_gateway_subscriptions: Callable[[], Iterable[dict[str, Any]]] | None = None,
    window_hours: int = 48,
) -> dict[str, Any]:
    """Run the diff, persist a ``ReconciliationRun``, and return the report.

    The 48h window overlaps yesterday's run on purpose, the job is idempotent
    (report-only), and an overlap means a cron outage of up to a day loses no
    coverage. A gateway fetch failure becomes its OWN delta rather than an
    exception: a reconciliation that silently didn't look is worse than one
    that loudly couldn't.
    """
    fetch_captured_payments = fetch_captured_payments or _fetch_captured_payments_sdk
    fetch_gateway_subscriptions = fetch_gateway_subscriptions or _fetch_gateway_subscriptions_sdk

    # Trailing-edge freshness lag: a payment captured seconds before the run
    # whose webhook hasn't landed yet is in-flight, not missing. One hour is
    # generous for Razorpay webhook delivery + dead-letter retry; the window
    # overlap means tomorrow's run still covers this hour.
    window_to = datetime.now(UTC) - timedelta(hours=1)
    window_from = window_to - timedelta(hours=window_hours)
    deltas: dict[str, list[Any]] = {}
    soft_deltas: dict[str, list[Any]] = {}

    # ── 1. Captured payments → invoices → grants ────────────────────────────
    payments: list[dict[str, Any]] = []
    try:
        payments = [p for p in fetch_captured_payments(window_from, window_to) if p.get("id")]
    except Exception as exc:
        deltas["payments_fetch_failed"] = [str(exc)[:300]]

    if payments:
        pay_ids = [str(p["id"]) for p in payments]
        invoices = session.execute(select(Invoice).where(Invoice.razorpay_payment_id.in_(pay_ids))).scalars().all()
        by_pay_id = {inv.razorpay_payment_id: inv for inv in invoices}

        payments_by_id = {str(p["id"]): p for p in payments}
        missing = [pid for pid in pay_ids if pid not in by_pay_id]
        if missing:
            # Split by attribution: a payment whose notes carry no oyechats_*
            # linkage was not created by this platform (₹1 live smoke tests
            # from CHECKOUT_TEST_CLIENT_IDS driven off a dev DB, dashboard
            # payment links, manual charges). Those are a SOFT bucket.
            # Reported, WARNING-logged, but not allowed to poison the ERROR
            # alert whose whole value is that it only fires for real deltas.
            def _is_ours(pid: str) -> bool:
                notes = payments_by_id.get(pid, {}).get("notes") or {}
                return isinstance(notes, dict) and any(str(k).startswith("oyechats_") for k in notes)

            ours = [pid for pid in missing if _is_ours(pid)]
            foreign = [pid for pid in missing if pid not in ours]
            if ours:
                deltas["captured_payment_without_invoice"] = ours
            if foreign:
                soft_deltas["captured_payment_unattributed"] = foreign

        # A plan charge funds a credit grant; the linked ledger row is the
        # proof the customer got what they paid for. Scoped to kind ==
        # "plan_charge". Seat/topup/withheld invoices legitimately grant
        # nothing here (topups grant via their own reconcile path), and
        # NULL-kind legacy rows predate reliable linkage.
        plan_charge_ids = [inv.id for inv in invoices if inv.kind == "plan_charge"]
        if plan_charge_ids:
            granted = set(
                session.execute(
                    select(CreditLedger.reference_id).where(
                        CreditLedger.reference_id.in_(plan_charge_ids),
                        CreditLedger.delta > 0,
                    )
                )
                .scalars()
                .all()
            )
            ungranted = [inv_id for inv_id in plan_charge_ids if inv_id not in granted]
            if ungranted:
                deltas["plan_charge_without_grant"] = ungranted

    # ── 2 & 3. Gateway subscriptions ↔ local rows ───────────────────────────
    gateway_subs: list[dict[str, Any]] = []
    try:
        gateway_subs = [s for s in fetch_gateway_subscriptions() if s.get("id")]
    except Exception as exc:
        deltas["subscriptions_fetch_failed"] = [str(exc)[:300]]

    if gateway_subs or "subscriptions_fetch_failed" not in deltas:
        gw_status = {str(s["id"]): (s.get("status") or "").lower() for s in gateway_subs}
        gw_live_ids = [sid for sid, status in gw_status.items() if status in _GATEWAY_LIVE]

        local_rows = (
            session.execute(
                select(Subscription.razorpay_subscription_id, Subscription.status).where(
                    Subscription.razorpay_subscription_id.is_not(None)
                )
            )
        ).all()
        local_status = {rid: status for rid, status in local_rows}
        # Seat add-ons are REAL gateway subscriptions stored in a different
        # column (one plan sub + one seat sub per seated customer). Without
        # this union every live seat mandate would flag as
        # gateway_sub_without_local on every run. Permanent false accusations
        # that train people to ignore the alert. The owning row's status
        # stands in for the add-on's local liveness (they live and die
        # together; the orphan sweep owns finer-grained seat auditing).
        seat_rows = (
            session.execute(
                select(Subscription.seat_addon_subscription_id, Subscription.status).where(
                    Subscription.seat_addon_subscription_id.is_not(None)
                )
            )
        ).all()
        for rid, status in seat_rows:
            local_status.setdefault(rid, status)

        unknown_locally = [sid for sid in gw_live_ids if sid not in local_status]
        if unknown_locally:
            deltas["gateway_sub_without_local"] = unknown_locally

        # A gateway mandate that can still charge, over a local row that no
        # longer entitles service. `halted` gateway + `past_due`/expired local
        # is the normal dunning shape, so only genuinely chargeable gateway
        # states count here.
        zombie = [
            sid
            for sid in gw_live_ids
            if gw_status[sid] in ("active", "pending") and sid in local_status and local_status[sid] not in _LOCAL_LIVE
        ]
        if zombie:
            deltas["gateway_active_local_terminal"] = zombie

        # Local service running on a mandate the gateway says is dead. Rows
        # whose gateway id was never seen in the listing are NOT flagged.
        # Absence from a paged listing is weaker evidence than a terminal
        # status, and false accusations here train people to ignore the alert.
        dead_backing = [
            rid for rid, status in local_status.items() if status in _LOCAL_LIVE and gw_status.get(rid) in _GATEWAY_DEAD
        ]
        if dead_backing:
            deltas["local_active_gateway_dead"] = dead_backing

    def _capped(bucket: dict[str, list[Any]]) -> dict[str, list[Any]]:
        # A pathological run must not embed tens of thousands of ids in one
        # JSONB row / Sentry line. First 100 of each list plus a count marker.
        capped: dict[str, list[Any]] = {}
        for key, values in bucket.items():
            if len(values) > 100:
                capped[key] = values[:100] + [f"... and {len(values) - 100} more"]
            else:
                capped[key] = values
        return capped

    deltas = _capped(deltas)
    soft_deltas = _capped(soft_deltas)
    delta_count = sum(len(v) for v in deltas.values())
    report = {
        "window_from": window_from.isoformat(),
        "window_to": window_to.isoformat(),
        "payments_checked": len(payments),
        "gateway_subs_checked": len(gateway_subs),
        "deltas": deltas,
        "soft_deltas": soft_deltas,
        "delta_count": delta_count,
    }

    session.add(
        ReconciliationRun(
            window_from=window_from,
            window_to=window_to,
            delta_count=delta_count,
            report=report,
        )
    )
    session.commit()

    if soft_deltas:
        logger.warning("gateway reconciliation soft deltas (unattributed gateway activity): %s", soft_deltas)
    if delta_count:
        logger.error("gateway reconciliation found %d delta(s): %s", delta_count, deltas)
    else:
        logger.info(
            "gateway reconciliation clean: %d payment(s), %d gateway sub(s) checked",
            len(payments),
            len(gateway_subs),
        )
    return report
