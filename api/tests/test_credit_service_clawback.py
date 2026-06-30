"""Refund clawback scoping — remediation C2 (real Postgres).

The refund handler must reverse credits from the **same ledger scope** the
payment credited (per-bot ledger vs client pool) and from the **right grant
type** (a subscription refund claws a plan_grant; a top-up refund claws a
topup). The previous implementation always wrote to the client pool and picked
the most-recent grant regardless of type — which left per-bot credits
un-reversed and could drive the client pool negative.

Runs against a throwaway Postgres DB (mirrors test_affiliate_service.py). The
clawback path uses PG advisory locks + real ledger rows, so a real server is
required; the module skips when none is reachable at ``DB_URL``.
"""

from __future__ import annotations

import os

import pytest
from sqlalchemy import create_engine, make_url, select
from sqlalchemy import text as sa_text
from sqlalchemy.orm import Session

from app.db.models import Base, Client, Invoice, Plan, Subscription
from app.services import credit_service
from app.services import razorpay_service as rzp

_TEST_DB_SUFFIX = "_clawtest"


def _server_url():
    raw = os.getenv("DB_URL")
    return make_url(raw) if raw else None


def _server_reachable(url) -> bool:
    try:
        engine = create_engine(url, connect_args={"connect_timeout": 2})
        with engine.connect():
            pass
        engine.dispose()
        return True
    except Exception:
        return False


_BASE_URL = _server_url()

pytestmark = pytest.mark.skipif(
    _BASE_URL is None or not _server_reachable(_BASE_URL),
    reason="credit clawback integration tests need a reachable Postgres at DB_URL",
)


@pytest.fixture(scope="module")
def pg_engine():
    test_db = (_BASE_URL.database or "postgres") + _TEST_DB_SUFFIX
    admin = create_engine(_BASE_URL.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{test_db}"')
        conn.exec_driver_sql(f'CREATE DATABASE "{test_db}"')
    admin.dispose()

    engine = create_engine(_BASE_URL.set(database=test_db))
    with engine.connect() as conn:
        conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS citext")
        conn.exec_driver_sql("CREATE EXTENSION IF NOT EXISTS vector")
        conn.commit()
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()

    admin = create_engine(_BASE_URL.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{test_db}"')
    admin.dispose()


@pytest.fixture()
def db(pg_engine):
    session = Session(pg_engine)
    yield session
    session.rollback()
    # Clean slate between tests — TRUNCATE … CASCADE sidesteps FK-cycle ordering.
    names = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    session.execute(sa_text(f"TRUNCATE {names} RESTART IDENTITY CASCADE"))
    session.commit()
    session.close()


# ── helpers ──────────────────────────────────────────────────────────────────


def _client(db, n=1):
    c = Client(name=f"C{n}", email=f"c{n}@e.com", api_key=f"k{n}", hashed_password="h")
    db.add(c)
    db.flush()
    return c


def _bot(db, client, key="bot-claw1"):
    from app.db.models import Bot

    b = Bot(client_id=client.id, bot_key=key, name="B", is_legacy_pooled=False)
    db.add(b)
    db.flush()
    return b


def _refund_payload(payment_id: str, amount_minor: int, refund_id="rfnd_1"):
    return {"refund": {"entity": {"id": refund_id, "payment_id": payment_id, "amount": amount_minor}}}


def _balances(db, client_id, bot_id):
    return credit_service.get_balance(db, client_id, bot_id)


# ── tests ────────────────────────────────────────────────────────────────────


def test_topup_refund_claws_topup_in_bot_scope_not_client_pool(db):
    client = _client(db)
    bot = _bot(db, client)
    # A plan grant AND a top-up, both in the bot's isolated ledger.
    credit_service.grant_plan_credits(db, client.id, 1000, bot_id=bot.id)
    credit_service.grant_topup(db, client.id, 500, bot_id=bot.id)
    db.commit()

    # Top-up invoice: subscription_id is None, scope is the bot ledger.
    inv = Invoice(
        client_id=client.id,
        subscription_id=None,
        bot_id=bot.id,
        amount_cents=3999,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_topup_1",
    )
    db.add(inv)
    db.commit()

    rzp._handle_refund_created(db, _refund_payload("pay_topup_1", 3999))
    db.commit()

    # The top-up (500) is clawed back inside the bot ledger; the plan grant
    # (1000) is untouched, and the client pool never goes negative.
    assert _balances(db, client.id, bot.id) == 1000  # 1500 - 500 topup
    assert _balances(db, client.id, None) == 0  # client pool untouched


def test_subscription_refund_claws_plan_grant_in_bot_scope(db):
    client = _client(db)
    bot = _bot(db, client, key="bot-claw2")
    plan = Plan(name="Starter", slug="starter-claw", monthly_price_cents=3999, credits_per_month=1000)
    db.add(plan)
    db.flush()
    sub = Subscription(
        client_id=client.id, plan_id=plan.id, bot_id=bot.id, status="active", payment_provider="razorpay"
    )
    db.add(sub)
    db.flush()

    credit_service.grant_plan_credits(db, client.id, 1000, bot_id=bot.id)
    credit_service.grant_topup(db, client.id, 500, bot_id=bot.id)
    db.commit()

    inv = Invoice(
        client_id=client.id,
        subscription_id=sub.id,
        bot_id=bot.id,
        amount_cents=3999,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_sub_1",
    )
    db.add(inv)
    db.commit()

    rzp._handle_refund_created(db, _refund_payload("pay_sub_1", 3999))
    db.commit()

    # Subscription refund claws the PLAN grant (1000), not the top-up (500).
    assert _balances(db, client.id, bot.id) == 500
    assert _balances(db, client.id, None) == 0


def test_no_ledger_scope_goes_negative_after_partial_refund(db):
    client = _client(db)
    bot = _bot(db, client, key="bot-claw3")
    credit_service.grant_topup(db, client.id, 1000, bot_id=bot.id)
    db.commit()

    inv = Invoice(
        client_id=client.id,
        bot_id=bot.id,
        amount_cents=4000,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_topup_3",
    )
    db.add(inv)
    db.commit()

    # 50% partial refund → claw ~50% of the grant, never below zero.
    rzp._handle_refund_created(db, _refund_payload("pay_topup_3", 2000))
    db.commit()

    assert _balances(db, client.id, bot.id) >= 0
    assert _balances(db, client.id, bot.id) == 500  # 1000 - round(1000 * 0.5)
    assert _balances(db, client.id, None) == 0


def test_payment_captured_fetches_order_notes_when_absent(db, monkeypatch):
    """payment.captured carries only the payment entity; top-up metadata lives on
    the order's notes. The handler must fetch the order so a top-up grants from
    payment.captured alone, not only from order.paid (H5)."""
    client = _client(db)
    bot = _bot(db, client, key="bot-h5")
    db.commit()

    # payment.captured shape: payment entity with an order_id but no notes.
    payload = {"payment": {"entity": {"id": "pay_h5", "order_id": "order_h5", "amount": 399900, "currency": "INR"}}}
    fetched_order = {
        "id": "order_h5",
        "amount": 399900,
        "currency": "INR",
        "notes": {
            "purpose": "topup",
            "client_id": str(client.id),
            "credits": "2000",
            "amount_inr": "3999",
            "bot_id": str(bot.id),
        },
    }

    class _FakeRzp:
        class order:
            @staticmethod
            def fetch(order_id):
                assert order_id == "order_h5"
                return fetched_order

    monkeypatch.setattr(rzp, "_get_razorpay", lambda: _FakeRzp())

    rzp._handle_payment_captured(db, payload)
    db.commit()

    inv = db.execute(select(Invoice).where(Invoice.razorpay_payment_id == "pay_h5")).scalars().first()
    assert inv is not None
    assert inv.bot_id == bot.id
    assert _balances(db, client.id, bot.id) == 2000


def test_refund_claws_once_across_created_and_processed_events(db):
    """refund.created and refund.processed are distinct webhook events for the
    same refund. A grant that lands between them must not be clawed twice (N2)."""
    client = _client(db)
    bot = _bot(db, client, key="bot-n2")
    credit_service.grant_topup(db, client.id, 500, bot_id=bot.id)
    db.commit()

    inv = Invoice(
        client_id=client.id,
        bot_id=bot.id,
        amount_cents=4000,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_n2",
    )
    db.add(inv)
    db.commit()

    # refund.created → claws the 500 top-up (full refund of a ₹40 charge).
    rzp._handle_refund_created(db, _refund_payload("pay_n2", 4000, refund_id="rfnd_n2"))
    db.commit()
    assert _balances(db, client.id, bot.id) == 0

    # A NEW top-up grant arrives before the bank settles the refund.
    credit_service.grant_topup(db, client.id, 500, bot_id=bot.id)
    db.commit()

    # refund.processed (same refund id, different webhook event) must be a
    # no-op — the new grant is untouched.
    rzp._handle_refund_created(db, _refund_payload("pay_n2", 4000, refund_id="rfnd_n2"))
    db.commit()
    assert _balances(db, client.id, bot.id) == 500


def _dispute_payload(payment_id, dispute_id="dp_1", amount=None, status="lost"):
    ent = {"id": dispute_id, "payment_id": payment_id, "status": status}
    if amount is not None:
        ent["amount"] = amount
    return {"dispute": {"entity": ent}}


def test_dispute_lost_claws_back_credits(db):
    client = _client(db)
    bot = _bot(db, client, key="bot-h6")
    credit_service.grant_topup(db, client.id, 500, bot_id=bot.id)
    db.commit()
    inv = Invoice(
        client_id=client.id,
        bot_id=bot.id,
        amount_cents=4000,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_h6",
    )
    db.add(inv)
    db.commit()

    rzp._handle_dispute_lost(db, _dispute_payload("pay_h6", amount=4000))
    db.commit()

    assert _balances(db, client.id, bot.id) == 0
    db.refresh(inv)
    assert inv.status == "dispute_lost"


def test_dispute_created_flags_invoice_without_clawing(db):
    client = _client(db)
    bot = _bot(db, client, key="bot-h6b")
    credit_service.grant_topup(db, client.id, 500, bot_id=bot.id)
    db.commit()
    inv = Invoice(
        client_id=client.id,
        bot_id=bot.id,
        amount_cents=4000,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_h6b",
    )
    db.add(inv)
    db.commit()

    rzp._handle_dispute_created(db, _dispute_payload("pay_h6b", dispute_id="dp_b", status="open"))
    db.commit()

    assert _balances(db, client.id, bot.id) == 500  # not clawed yet
    db.refresh(inv)
    assert inv.status == "disputed"


def test_dispute_lost_is_idempotent(db):
    client = _client(db)
    bot = _bot(db, client, key="bot-h6c")
    credit_service.grant_topup(db, client.id, 500, bot_id=bot.id)
    db.commit()
    inv = Invoice(
        client_id=client.id,
        bot_id=bot.id,
        amount_cents=4000,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_h6c",
    )
    db.add(inv)
    db.commit()

    rzp._handle_dispute_lost(db, _dispute_payload("pay_h6c", dispute_id="dp_c", amount=4000))
    db.commit()
    assert _balances(db, client.id, bot.id) == 0

    # A new grant arrives, then the same dispute event replays → no second claw.
    credit_service.grant_topup(db, client.id, 500, bot_id=bot.id)
    db.commit()
    rzp._handle_dispute_lost(db, _dispute_payload("pay_h6c", dispute_id="dp_c", amount=4000))
    db.commit()
    assert _balances(db, client.id, bot.id) == 500


def test_topup_captured_stamps_bot_id_on_invoice(db):
    """The top-up handler records the bot ledger scope on the invoice so a later
    refund can claw credits back from that same scope (wiring for C2)."""
    client = _client(db)
    bot = _bot(db, client, key="bot-wire1")
    db.commit()

    payload = {
        "payment": {
            "entity": {
                "id": "pay_wire1",
                "order_id": "order_wire1",
                "amount": 399900,
                "currency": "INR",
                "notes": {
                    "purpose": "topup",
                    "client_id": str(client.id),
                    "credits": "2000",
                    "amount_inr": "3999",
                    "bot_id": str(bot.id),
                },
            }
        }
    }
    rzp._handle_payment_captured(db, payload)
    db.commit()

    inv = db.execute(select(Invoice).where(Invoice.razorpay_payment_id == "pay_wire1")).scalars().first()
    assert inv is not None
    assert inv.bot_id == bot.id
    # Credits landed in the bot's isolated ledger, not the client pool.
    assert _balances(db, client.id, bot.id) == 2000
    assert _balances(db, client.id, None) == 0


def test_topup_amount_mismatch_refuses_grant(db):
    """NV2 — the grant trusts notes['credits'], but the money actually captured
    must match the notes' declared price. A captured amount that disagrees with
    notes.amount_inr must refuse to grant (no invoice, no credits)."""
    client = _client(db)
    bot = _bot(db, client, key="bot-nv2")
    db.commit()

    # Notes declare a ₹3999 pack, but only ₹39 (3900 paise) was captured.
    payload = {
        "payment": {
            "entity": {
                "id": "pay_nv2",
                "order_id": "order_nv2",
                "amount": 3900,
                "currency": "INR",
                "notes": {
                    "purpose": "topup",
                    "client_id": str(client.id),
                    "credits": "2000",
                    "amount_inr": "3999",
                    "bot_id": str(bot.id),
                },
            }
        }
    }
    with pytest.raises(rzp.RazorpayBillingError, match="amount mismatch"):
        rzp._handle_payment_captured(db, payload)
    db.rollback()

    assert db.execute(select(Invoice).where(Invoice.razorpay_payment_id == "pay_nv2")).scalars().first() is None
    assert _balances(db, client.id, bot.id) == 0


def _fake_rzp_for_topup(order, payment):
    class _FakeRzp:
        class order:
            @staticmethod
            def fetch(_):
                return order

        class payment:
            @staticmethod
            def fetch(_):
                return payment

    return _FakeRzp()


def test_reconcile_topup_grants_when_webhook_dropped(db, monkeypatch):
    """L3 — if the capture webhook is dropped, the browser's topup/verify call
    reconciles the grant. A second reconcile (or the late webhook) is a no-op."""
    client = _client(db)
    bot = _bot(db, client, key="bot-l3")
    db.commit()

    order = {
        "id": "order_l3",
        "amount": 399900,
        "currency": "INR",
        "notes": {
            "purpose": "topup",
            "client_id": str(client.id),
            "credits": "2000",
            "amount_inr": "3999",
            "bot_id": str(bot.id),
        },
    }
    payment = {"id": "pay_l3", "order_id": "order_l3", "amount": 399900, "currency": "INR", "status": "captured"}
    monkeypatch.setattr(rzp, "_get_razorpay", lambda: _fake_rzp_for_topup(order, payment))

    assert rzp.reconcile_topup_from_razorpay(db, "order_l3", "pay_l3", expected_client_id=client.id) is True
    db.commit()
    assert _balances(db, client.id, bot.id) == 2000

    # Idempotent: a second reconcile must not double-grant.
    rzp.reconcile_topup_from_razorpay(db, "order_l3", "pay_l3", expected_client_id=client.id)
    db.commit()
    assert _balances(db, client.id, bot.id) == 2000


def test_reconcile_topup_rejects_foreign_client(db, monkeypatch):
    """L2/L3 — a caller must not reconcile a top-up whose notes name another client."""
    owner = _client(db, n=1)
    attacker = _client(db, n=2)
    db.commit()

    order = {
        "id": "order_x",
        "amount": 399900,
        "currency": "INR",
        "notes": {"purpose": "topup", "client_id": str(owner.id), "credits": "2000", "amount_inr": "3999"},
    }
    payment = {"id": "pay_x", "order_id": "order_x", "amount": 399900, "currency": "INR", "status": "captured"}
    monkeypatch.setattr(rzp, "_get_razorpay", lambda: _fake_rzp_for_topup(order, payment))

    with pytest.raises(rzp.RazorpayBillingError, match="does not belong"):
        rzp.reconcile_topup_from_razorpay(db, "order_x", "pay_x", expected_client_id=attacker.id)
    db.rollback()
    assert _balances(db, owner.id, None) == 0
