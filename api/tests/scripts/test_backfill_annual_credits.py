"""Tests for the one-time annual-credits backfill script (hotfix Task 2).

``bc5a5a7`` fixed ``credit_service.grant_for_subscription`` to scale grants by
billing cycle, but every annual subscription already active before that fix
was granted only ``plan.credits_per_month`` (1 month) for its current period
instead of ``plan.credits_per_month * 12``. ``scripts.backfill_annual_credits``
tops each one up by exactly the shortfall, exactly once.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.db.models import Client, CreditLedger, Plan, Subscription
from app.services import credit_service
from scripts.backfill_annual_credits import MARKER, run_backfill

# ── Factories (mirrors tests/services/test_credit_grant_cycle.py) ────────────


def _make_client(db, email: str, api_key: str) -> Client:
    client = Client(name="c", email=email, api_key=api_key, hashed_password="h")
    db.add(client)
    db.flush()
    return client


def _make_plan(db, slug: str, credits_per_month: int) -> Plan:
    plan = Plan(name=slug, slug=slug, monthly_price_cents=399900, credits_per_month=credits_per_month)
    db.add(plan)
    db.flush()
    return plan


def _make_subscription(
    db,
    client: Client,
    plan: Plan,
    *,
    billing_cycle: str,
    rzp_id: str,
    status: str = "active",
    period_start: datetime | None = None,
    bot_id: int | None = None,
) -> Subscription:
    period_start = period_start or (datetime.now(UTC) - timedelta(days=1))
    period_days = 365 if billing_cycle == "annual" else 30
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=bot_id,
        status=status,
        payment_provider="razorpay",
        billing_cycle=billing_cycle,
        razorpay_subscription_id=rzp_id,
        current_period_start=period_start,
        current_period_end=period_start + timedelta(days=period_days),
    )
    sub.plan = plan
    db.add(sub)
    db.commit()
    return sub


# ── Tests ─────────────────────────────────────────────────────────────────────


def test_annual_backfill_grants_exact_shortfall(db) -> None:
    client = _make_client(db, "backfill-shortfall@e.com", "backfill-shortfall")
    plan = _make_plan(db, "std-backfill-shortfall", 6000)
    sub = _make_subscription(db, client, plan, billing_cycle="annual", rzp_id="sub_backfill_shortfall")

    # Simulate the pre-bc5a5a7 bug: the subscriber's current period only got
    # the flat monthly rate (6,000) instead of 12x (72,000).
    credit_service.grant_plan_credits(db, client.id, 6000, note="pre-fix buggy grant", bot_id=None)
    db.commit()
    assert credit_service.get_balance(db, client.id) == 6000

    result = run_backfill(db, execute=True)
    db.commit()

    assert result == {sub.id: 66000}
    assert credit_service.get_balance(db, client.id) == 72000

    # The backfill grant itself is tagged and attributable.
    backfill_rows = (
        db.query(CreditLedger).filter(CreditLedger.client_id == client.id, CreditLedger.note == MARKER).all()
    )
    assert len(backfill_rows) == 1
    assert backfill_rows[0].delta == 66000
    assert backfill_rows[0].reason == "plan_grant"


def test_annual_backfill_is_idempotent_on_second_run(db) -> None:
    client = _make_client(db, "backfill-idempotent@e.com", "backfill-idempotent")
    plan = _make_plan(db, "std-backfill-idempotent", 6000)
    sub = _make_subscription(db, client, plan, billing_cycle="annual", rzp_id="sub_backfill_idempotent")

    credit_service.grant_plan_credits(db, client.id, 6000, note="pre-fix buggy grant", bot_id=None)
    db.commit()

    first = run_backfill(db, execute=True)
    db.commit()
    assert first == {sub.id: 66000}
    assert credit_service.get_balance(db, client.id) == 72000

    second = run_backfill(db, execute=True)
    db.commit()

    assert sub.id not in second
    assert second == {}
    assert credit_service.get_balance(db, client.id) == 72000


def test_dry_run_writes_nothing(db) -> None:
    client = _make_client(db, "backfill-dryrun@e.com", "backfill-dryrun")
    plan = _make_plan(db, "std-backfill-dryrun", 6000)
    sub = _make_subscription(db, client, plan, billing_cycle="annual", rzp_id="sub_backfill_dryrun")

    credit_service.grant_plan_credits(db, client.id, 6000, note="pre-fix buggy grant", bot_id=None)
    db.commit()

    result = run_backfill(db, execute=False)

    assert result == {sub.id: 66000}
    # Nothing was written: balance is unchanged and no marker row exists.
    assert credit_service.get_balance(db, client.id) == 6000
    backfill_rows = (
        db.query(CreditLedger).filter(CreditLedger.client_id == client.id, CreditLedger.note == MARKER).all()
    )
    assert backfill_rows == []

    # A subsequent real run still finds (and now grants) the same shortfall —
    # proving the dry-run truly left the ledger untouched.
    real_result = run_backfill(db, execute=True)
    db.commit()
    assert real_result == {sub.id: 66000}
    assert credit_service.get_balance(db, client.id) == 72000


def test_monthly_subscription_is_untouched(db) -> None:
    client = _make_client(db, "backfill-monthly@e.com", "backfill-monthly")
    plan = _make_plan(db, "std-backfill-monthly", 6000)
    sub = _make_subscription(db, client, plan, billing_cycle="monthly", rzp_id="sub_backfill_monthly")

    credit_service.grant_plan_credits(db, client.id, 6000, note="normal monthly grant", bot_id=None)
    db.commit()

    result = run_backfill(db, execute=True)
    db.commit()

    assert sub.id not in result
    assert credit_service.get_balance(db, client.id) == 6000


def test_annual_subscription_already_fully_granted_is_untouched(db) -> None:
    client = _make_client(db, "backfill-already-full@e.com", "backfill-already-full")
    plan = _make_plan(db, "std-backfill-already-full", 6000)
    sub = _make_subscription(db, client, plan, billing_cycle="annual", rzp_id="sub_backfill_already_full")

    # Already granted the correct 12x amount for this period (e.g. by
    # grant_for_subscription post-fix) — shortfall is zero.
    credit_service.grant_plan_credits(db, client.id, 72000, note="correct annual grant", bot_id=None)
    db.commit()

    result = run_backfill(db, execute=True)
    db.commit()

    assert sub.id not in result
    assert credit_service.get_balance(db, client.id) == 72000
