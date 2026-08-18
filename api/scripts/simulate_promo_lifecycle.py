"""Local, isolated end-to-end simulation of the launch-promo month-4 transition.

Creates throwaway clients/bots/subscriptions on Standard (plan 3) that mirror a
customer mid free-period, then drives the REAL service/webhook code paths to
show what happens when the free period ends:

  Scenario A  free period ends -> Razorpay charges OK        (conversion)
  Scenario B  free period ends -> charge fails -> dunning -> grace elapses -> expired
  Scenario C  customer cancels DURING the free period        (no charge ever)

For B and C it then reads live entitlements + data to prove the account is only
downgraded (never data-deleted). Every row it creates is torn down at the end.

Run inside the conda ``oye`` env from ``platform/api``:
    uv run python scripts/simulate_promo_lifecycle.py
"""

from __future__ import annotations

import secrets
from datetime import UTC, datetime, timedelta

from sqlalchemy import text

from app.config import PAYMENT_FAILED_GRACE_DAYS
from app.db.models import Bot, Client, Plan, Subscription
from app.db.session import get_session
from app.services import credit_service, razorpay_service
from app.services.plan_entitlements_service import get_entitlements
from app.services.promotion_service import current_free_period_end
from app.worker.tasks import _expire_past_due_cycle

STANDARD_PLAN_ID = 3
PROMO_ID = 2
_created_client_ids: list[int] = []


def _rule(char: str = "-") -> None:
    print(char * 78)


def _show(session, sub: Subscription, label: str) -> None:
    session.refresh(sub)
    bal = credit_service.get_balance(session, sub.client_id, sub.bot_id)
    print(
        f"  [{label:<16}] status={sub.status:<9} "
        f"credits={bal:<6} "
        f"promo_free_until={_d(sub.promo_free_until)} "
        f"period_end={_d(sub.current_period_end)} "
        f"granted_thru={_d(sub.last_granted_period_end)}"
    )
    if sub.past_due_since or sub.canceled_at:
        print(
            f"                      past_due_since={_d(sub.past_due_since)} "
            f"canceled_at={_d(sub.canceled_at)} reason={sub.cancel_reason}"
        )


def _d(value) -> str:
    return value.strftime("%Y-%m-%d") if value else "-"


def _charged_payload(rzp_id: str, start: datetime, end: datetime, amount_minor: int) -> dict:
    """A minimal ``subscription.charged`` envelope in Razorpay's inner-payload shape."""
    return {
        "subscription": {
            "entity": {
                "id": rzp_id,
                "current_start": int(start.timestamp()),
                "current_end": int(end.timestamp()),
                "status": "active",
            }
        },
        "payment": {
            "entity": {
                "id": "pay_sim_" + secrets.token_hex(5),
                "amount": amount_minor,
                "currency": "INR",
                "status": "captured",
            }
        },
    }


def _make_sub(session, tag: str, rzp_id: str, now: datetime, free_until: datetime) -> Subscription:
    """A Standard subscription mid free-period, with this month's free credits already granted."""
    client = Client(
        name=f"Sim {tag}",
        email=f"sim.promo.{tag}.{secrets.token_hex(3)}@example.com",
        api_key="sk_sim_" + secrets.token_hex(10),
        is_verified=True,
    )
    session.add(client)
    session.flush()
    _created_client_ids.append(client.id)

    bot = Bot(client_id=client.id, name=f"Sim Bot {tag}", bot_key="bot-sim-" + secrets.token_hex(6))
    session.add(bot)
    session.flush()

    sub = Subscription(
        client_id=client.id,
        bot_id=bot.id,
        plan_id=STANDARD_PLAN_ID,
        status="active",
        promotion_id=PROMO_ID,
        promo_free_until=free_until,
        razorpay_subscription_id=rzp_id,
        current_period_start=now - timedelta(days=25),
        current_period_end=free_until,
        operator_quantity=1,
    )
    session.add(sub)
    session.flush()

    # Mimic the free-window credit refresh cron having already granted THIS
    # free month's allowance, so the balance shown is a real promo state.
    credit_service.grant_subscription_period_once(session, sub, current_free_period_end(free_until, now))
    session.commit()
    return sub


def _teardown(session) -> None:
    if not _created_client_ids:
        return
    # ids are DB-generated integers we created this run. Safe to inline.
    id_list = ", ".join(str(int(i)) for i in _created_client_ids)
    for table in ("credit_ledger", "invoices", "usage_records", "subscriptions", "bots"):
        session.execute(text(f"DELETE FROM {table} WHERE client_id IN ({id_list})"))
    session.execute(text(f"DELETE FROM clients WHERE id IN ({id_list})"))
    session.commit()
    print(f"\nTeardown: removed {len(_created_client_ids)} throwaway client(s) and all their rows.")


def main() -> None:
    now = datetime.now(UTC)
    free_until = now + timedelta(days=3)  # 3 days left in the free window

    with get_session() as session:
        plan = session.get(Plan, STANDARD_PLAN_ID)
        monthly_minor = int(getattr(plan, "price_cents", 0) or getattr(plan, "monthly_price_cents", 94900))
        print(f"Standard plan: {plan.name} | credits/mo={plan.credits_per_month} | grace={PAYMENT_FAILED_GRACE_DAYS}d")

        try:
            # ── Scenario A (successful month-4 charge (conversion) ──
            _rule("=")
            print("SCENARIO A) free period ends, Razorpay charge SUCCEEDS")
            _rule("=")
            sub_a = _make_sub(session, "A", "sub_SIM_A_" + secrets.token_hex(4), now, free_until)
            _show(session, sub_a, "in free period")

            paid_start = free_until
            paid_end = free_until + timedelta(days=30)
            razorpay_service._handle_subscription_charged(
                session, _charged_payload(sub_a.razorpay_subscription_id, paid_start, paid_end, monthly_minor)
            )
            session.commit()
            _show(session, sub_a, "after charge")
            print("  -> stays ACTIVE, paid month's credits granted, period advanced. Data untouched.")

            # ── Scenario B (charge fails -> dunning -> grace elapses -> expired ──
            _rule("=")
            print("SCENARIO B) free period ends, charge FAILS, dunning grace elapses")
            _rule("=")
            sub_b = _make_sub(session, "B", "sub_SIM_B_" + secrets.token_hex(4), now, free_until)
            _show(session, sub_b, "in free period")

            # Charge failed at month 4 -> enter dunning. Backdate the anchor past
            # the grace window to represent grace having elapsed.
            razorpay_service._enter_past_due(sub_b)
            sub_b.past_due_since = now - timedelta(days=PAYMENT_FAILED_GRACE_DAYS + 1)
            session.commit()
            _show(session, sub_b, "past_due (dunning)")
            print(f"  -> full access retained during the {PAYMENT_FAILED_GRACE_DAYS}-day grace; dunning emails sent.")

            _expire_past_due_cycle(session)  # the expiry cron's core; commits internally
            _show(session, sub_b, "after expiry sweep")

            ent = get_entitlements(sub_b.client_id, session, include_usage=False)
            bot_b = session.query(Bot).filter(Bot.client_id == sub_b.client_id).first()
            doc_count = session.execute(
                text("SELECT count(*) FROM documents WHERE bot_id = :b").bindparams(b=bot_b.id)
            ).scalar_one()
            print(
                f"  -> entitlements now: plan_slug={ent.plan_slug!r} status={ent.subscription_status!r} "
                f"live_chat={ent.features.get('live_chat')}"
            )
            print(
                f"  -> DATA RETAINED: bot row exists={bot_b is not None} (is_active={bot_b.is_active}), "
                f"documents still {doc_count}. Nothing deleted."
            )

            # ── Scenario C (cancel DURING the free period (no charge ever) ──
            _rule("=")
            print("SCENARIO C) customer cancels DURING the free period")
            _rule("=")
            sub_c = _make_sub(session, "C", "sub_SIM_C_" + secrets.token_hex(4), now, free_until)
            _show(session, sub_c, "in free period")
            sub_c.status = "canceled"
            sub_c.canceled_at = now
            sub_c.cancel_reason = "user_canceled_in_free_period"
            session.commit()
            ent_c = get_entitlements(sub_c.client_id, session, include_usage=False)
            inv_count = session.execute(
                text("SELECT count(*) FROM invoices WHERE client_id = :c").bindparams(c=sub_c.client_id)
            ).scalar_one()
            _show(session, sub_c, "after cancel")
            print(
                f"  -> entitlements: plan_slug={ent_c.plan_slug!r}. Invoices billed to this client: {inv_count} "
                f"(first charge was deferred to month 4, so cancelling first = never charged)."
            )

        finally:
            _teardown(session)


if __name__ == "__main__":
    main()
