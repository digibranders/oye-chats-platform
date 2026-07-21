"""Annual subscriptions must grant 12 months of credits per billing period.

``grant_for_subscription`` used to grant a flat ``plan.credits_per_month``
regardless of ``subscription.billing_cycle``. Annual subscriptions advance
their period by 12 months and are only granted once per period, so an annual
subscriber received 1/12th of the credits they paid for (e.g. Standard annual
= 6,000 credits/yr instead of 72,000). ``cycle_months`` fixes the scaling;
these tests pin both the pure helper and the persisted ledger effect.
"""

from __future__ import annotations

from app.db.models import Client, CreditLedger, Plan, Subscription
from app.services import credit_service
from app.services.credit_service import cycle_months

# ── Pure-function tests (no DB) ───────────────────────────────────────────────


def test_cycle_months_monthly() -> None:
    assert cycle_months("monthly") == 1


def test_cycle_months_annual() -> None:
    assert cycle_months("annual") == 12


def test_cycle_months_none_defaults_to_monthly() -> None:
    assert cycle_months(None) == 1


def test_cycle_months_empty_string_defaults_to_monthly() -> None:
    assert cycle_months("") == 1


def test_cycle_months_is_case_insensitive() -> None:
    assert cycle_months("Annual") == 12
    assert cycle_months("ANNUAL") == 12
    assert cycle_months("Monthly") == 1


def test_cycle_months_ignores_surrounding_whitespace() -> None:
    assert cycle_months("  annual  ") == 12


# ── Behavioral tests (real DB session) ────────────────────────────────────────


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


def _make_subscription(db, client: Client, plan: Plan, *, billing_cycle: str, rzp_id: str) -> Subscription:
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        payment_provider="razorpay",
        billing_cycle=billing_cycle,
        razorpay_subscription_id=rzp_id,
    )
    sub.plan = plan
    db.add(sub)
    db.commit()
    return sub


def test_annual_subscription_grants_twelve_months_of_credits(db) -> None:
    client = _make_client(db, "annual-grant@e.com", "annual-grant")
    plan = _make_plan(db, "std-annual-grant", 6000)
    sub = _make_subscription(db, client, plan, billing_cycle="annual", rzp_id="sub_annual_grant")

    ledger = credit_service.grant_for_subscription(db, sub)
    db.commit()

    assert ledger is not None
    assert ledger.delta == 72000
    assert credit_service.get_balance(db, client.id, bot_id=None) == 72000


def test_monthly_subscription_grants_one_month_of_credits(db) -> None:
    client = _make_client(db, "monthly-grant@e.com", "monthly-grant")
    plan = _make_plan(db, "std-monthly-grant", 6000)
    sub = _make_subscription(db, client, plan, billing_cycle="monthly", rzp_id="sub_monthly_grant")

    ledger = credit_service.grant_for_subscription(db, sub)
    db.commit()

    assert ledger is not None
    assert ledger.delta == 6000
    assert credit_service.get_balance(db, client.id, bot_id=None) == 6000


def test_annual_grant_note_reflects_cycle(db) -> None:
    client = _make_client(db, "annual-note@e.com", "annual-note")
    plan = _make_plan(db, "std-annual-note", 1000)
    sub = _make_subscription(db, client, plan, billing_cycle="annual", rzp_id="sub_annual_note")

    ledger = credit_service.grant_for_subscription(db, sub)
    db.commit()

    assert ledger is not None
    assert ledger.note == f"{plan.name} annual grant"

    grants = (
        db.query(CreditLedger).filter(CreditLedger.client_id == client.id, CreditLedger.reason == "plan_grant").all()
    )
    assert len(grants) == 1
    assert grants[0].delta == 12000
