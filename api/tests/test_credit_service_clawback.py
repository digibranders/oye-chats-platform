"""Refund clawback scoping. Remediation C2 (real Postgres).

The refund handler must reverse credits from the **same ledger scope** the
payment credited (per-bot ledger vs client pool) and from the **right grant
type** (a subscription refund claws a plan_grant; a top-up refund claws a
topup). The previous implementation always wrote to the client pool and picked
the most-recent grant regardless of type, which left per-bot credits
un-reversed and could drive the client pool negative.

Runs on the shared throwaway Postgres from ``conftest.py``: the ``db`` fixture
there resets between tests. The clawback path uses PG advisory locks + real
ledger rows, so a real server is required; the module skips when none is
reachable at ``DB_URL``.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, func, make_url, select

from app.db.models import Client, CreditLedger, Invoice, Plan, Subscription
from app.services import credit_service
from app.services import razorpay_service as rzp


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


def test_full_refund_claws_across_all_invoice_linked_grant_rows(db):
    """Finding #3: a single invoice's entitlement can span MORE THAN ONE grant
    row (e.g. an annual grant the backfill split into two). A full refund must
    reverse ALL of them, not just the most recent one."""
    client = _client(db)
    bot = _bot(db, client, key="bot-split")
    sub = Subscription(
        client_id=client.id,
        plan_id=None,
        bot_id=bot.id,
        status="active",
        payment_provider="razorpay",
    )
    plan = Plan(name="Annual", slug="annual-split", monthly_price_cents=94900, credits_per_month=6000)
    db.add(plan)
    db.flush()
    sub.plan_id = plan.id
    db.add(sub)
    db.flush()

    inv = Invoice(
        client_id=client.id,
        subscription_id=sub.id,
        bot_id=bot.id,
        amount_cents=910800,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_split",
    )
    db.add(inv)
    db.flush()

    # Two plan_grant rows BOTH linked to this invoice (the split-annual shape):
    # the buggy original 6,000 + the backfill 66,000 = 72,000 total.
    credit_service.grant_plan_credits(db, client.id, 6000, bot_id=bot.id, reference_id=inv.id)
    credit_service.grant_plan_credits(db, client.id, 66000, bot_id=bot.id, reference_id=inv.id)
    db.commit()
    assert _balances(db, client.id, bot.id) == 72000

    # Full refund → BOTH linked grant rows reversed (72,000), not just one.
    rzp._handle_refund_created(db, _refund_payload("pay_split", 910800, refund_id="rf_split"))
    db.commit()
    assert _balances(db, client.id, bot.id) == 0


def test_cumulative_partial_refunds_flip_status_to_refunded(db):
    """Finding #5: an invoice fully refunded via SEVERAL partial refunds must end
    up ``refunded``, not stay ``partially_refunded``. The handler accumulates
    each refund event's amount (deduped on refund id) into refunded_minor."""
    client = _client(db)
    bot = _bot(db, client, key="bot-cumul")
    credit_service.grant_topup(db, client.id, 1000, bot_id=bot.id)
    db.commit()

    inv = Invoice(
        client_id=client.id,
        bot_id=bot.id,
        amount_cents=4000,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_cumul",
    )
    db.add(inv)
    db.commit()

    # First 50% refund → partially_refunded.
    rzp._handle_refund_created(db, _refund_payload("pay_cumul", 2000, refund_id="rf_c1"))
    db.commit()
    db.refresh(inv)
    assert inv.status == "partially_refunded"
    assert inv.refunded_minor == 2000

    # Second 50% refund (distinct refund id) → cumulative 4000 == charge → refunded.
    rzp._handle_refund_created(db, _refund_payload("pay_cumul", 2000, refund_id="rf_c2"))
    db.commit()
    db.refresh(inv)
    assert inv.status == "refunded"
    assert inv.refunded_minor == 4000


def test_duplicate_refund_event_does_not_double_accumulate(db):
    """The refund-id dedup must keep refunded_minor exact: a redelivered
    refund.created (same refund id) claws once and accumulates once."""
    client = _client(db)
    bot = _bot(db, client, key="bot-cumul-dup")
    credit_service.grant_topup(db, client.id, 1000, bot_id=bot.id)
    db.commit()

    inv = Invoice(
        client_id=client.id,
        bot_id=bot.id,
        amount_cents=4000,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_cumul_dup",
    )
    db.add(inv)
    db.commit()

    rzp._handle_refund_created(db, _refund_payload("pay_cumul_dup", 2000, refund_id="rf_dup"))
    rzp._handle_refund_created(db, _refund_payload("pay_cumul_dup", 2000, refund_id="rf_dup"))
    db.commit()
    db.refresh(inv)
    assert inv.refunded_minor == 2000  # accumulated once, not 4000
    assert inv.status == "partially_refunded"


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
    # no-op, the new grant is untouched.
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
    """NV2, the grant trusts notes['credits'], but the money actually captured
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
    """L3. If the capture webhook is dropped, the browser's topup/verify call
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
    """L2/L3, a caller must not reconcile a top-up whose notes name another client."""
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


def test_refund_claws_invoice_linked_topup_not_most_recent(db):
    """C2 precision, with two same-bot top-ups, refunding the OLDER invoice must
    claw the grant LINKED to it (via reference_id), not the most-recent grant."""
    client = _client(db)
    bot = _bot(db, client, key="bot-c2p")

    inv_a = Invoice(
        client_id=client.id,
        bot_id=bot.id,
        amount_cents=4000,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_A",
    )
    db.add(inv_a)
    db.flush()
    credit_service.grant_topup(db, client.id, 500, bot_id=bot.id, reference_id=inv_a.id)

    inv_b = Invoice(
        client_id=client.id,
        bot_id=bot.id,
        amount_cents=8000,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_B",
    )
    db.add(inv_b)
    db.flush()
    credit_service.grant_topup(db, client.id, 900, bot_id=bot.id, reference_id=inv_b.id)
    db.commit()
    assert _balances(db, client.id, bot.id) == 1400

    # Fully refund the OLDER invoice A → claws its linked 500 grant, leaving 900.
    rzp._handle_refund_created(db, _refund_payload("pay_A", 4000, refund_id="rf_A"))
    db.commit()
    assert _balances(db, client.id, bot.id) == 900


def test_refund_failed_restores_clawed_credits(db):
    """N1. Refund.created claws on initiation; if the refund then FAILS at the
    gateway, the clawed credits must be restored (idempotently)."""
    client = _client(db)
    bot = _bot(db, client, key="bot-n1")
    inv = Invoice(
        client_id=client.id,
        bot_id=bot.id,
        amount_cents=4000,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_n1",
    )
    db.add(inv)
    db.flush()
    credit_service.grant_topup(db, client.id, 500, bot_id=bot.id, reference_id=inv.id)
    db.commit()

    rzp._handle_refund_created(db, _refund_payload("pay_n1", 4000, refund_id="rf_n1"))
    db.commit()
    assert _balances(db, client.id, bot.id) == 0
    assert db.get(Invoice, inv.id).status == "refunded"

    failed = {"refund": {"entity": {"id": "rf_n1", "payment_id": "pay_n1", "amount": 4000}}}
    rzp._handle_refund_failed(db, failed)
    db.commit()
    assert _balances(db, client.id, bot.id) == 500
    assert db.get(Invoice, inv.id).status == "paid"

    # Idempotent: a duplicate refund.failed must not over-restore.
    rzp._handle_refund_failed(db, failed)
    db.commit()
    assert _balances(db, client.id, bot.id) == 500


def _raw_pool_sum(db, client_id):
    """Raw ledger sum for the account pool scope (``bot_id IS NULL``)."""
    return int(
        db.scalar(
            select(func.coalesce(func.sum(CreditLedger.delta), 0)).where(
                CreditLedger.client_id == client_id,
                CreditLedger.bot_id.is_(None),
            )
        )
        or 0
    )


def test_expire_old_topups_scopes_expiry_debit_to_the_bot_ledger(db):
    """P2-expiry, a per-bot top-up expiry must debit the bot's ledger, not the pool.

    The offsetting ``expiry`` row was previously written without ``bot_id``, so an
    expired per-bot top-up landed in the account pool (``bot_id IS NULL``): the
    bot's balance stayed inflated (expired credits still spendable there) while
    the pool was driven negative. The debit must carry the grant's ``bot_id``.
    """
    client = _client(db)
    bot = _bot(db, client, key="bot-expiry1")

    # Per-bot top-up, then backdate its expiry into the past so the cron sweeps it.
    grant = credit_service.grant_topup(db, client.id, 400, bot_id=bot.id)
    grant.expires_at = datetime.now(UTC) - timedelta(days=1)
    db.commit()

    pool_before = _raw_pool_sum(db, client.id)

    expired = credit_service.expire_old_topups(db)
    db.commit()

    assert expired == 400

    expiry_row = db.scalar(
        select(CreditLedger).where(
            CreditLedger.grant_id == grant.id,
            CreditLedger.reason == "expiry",
        )
    )
    assert expiry_row is not None
    # The debit must be scoped to the bot ledger, NOT the account pool.
    assert expiry_row.bot_id == bot.id

    # Bot balance is drained to zero; the account pool raw sum is untouched.
    assert _balances(db, client.id, bot.id) == 0
    assert _raw_pool_sum(db, client.id) == pool_before


# ── P0-1: clawback misattribution by invoice kind ────────────────────────────
# A refund/dispute must claw back only what the refunded invoice actually
# funded. Seat add-on invoices and withheld-credit charges carry a
# subscription_id but granted NOTHING. Deriving intent from subscription_id
# presence made a ₹449 seat refund wipe the customer's entire plan allowance
# via the most-recent-grant fallback. ``Invoice.kind`` now records what the
# charge was for; the fallback is reserved for legacy (kind IS NULL) rows.


def _sub_with_plan(db, client, bot, *, slug):
    plan = Plan(name=slug.title(), slug=slug, monthly_price_cents=44900, credits_per_month=10000)
    db.add(plan)
    db.flush()
    sub = Subscription(
        client_id=client.id, plan_id=plan.id, bot_id=bot.id, status="active", payment_provider="razorpay"
    )
    db.add(sub)
    db.flush()
    return sub


def test_seat_invoice_refund_claws_nothing(db):
    """Refunding a seat add-on invoice must not touch the plan grant."""
    client = _client(db)
    bot = _bot(db, client, key="bot-seat1")
    sub = _sub_with_plan(db, client, bot, slug="pro-seat1")
    # Activation-style plan grant with NO invoice link, exactly the shape the
    # legacy fallback would have (wrongly) clawed.
    credit_service.grant_plan_credits(db, client.id, 10000, bot_id=bot.id)
    db.commit()

    inv = Invoice(
        client_id=client.id,
        subscription_id=sub.id,
        bot_id=bot.id,
        amount_cents=44900,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_seat_1",
        description="Operator seat add-on",
        kind="seat",
    )
    db.add(inv)
    db.commit()

    rzp._handle_refund_created(db, _refund_payload("pay_seat_1", 44900, refund_id="rfnd_seat_1"))
    db.commit()

    assert _balances(db, client.id, bot.id) == 10000  # plan grant untouched
    db.refresh(inv)
    assert inv.status == "refunded"  # money bookkeeping still happens


def test_withheld_charge_refund_claws_nothing(db):
    """A charged-after-cancellation invoice granted no credits; refunding it
    (the operationally PRESCRIBED action) must not reverse an older grant."""
    client = _client(db)
    bot = _bot(db, client, key="bot-withheld1")
    sub = _sub_with_plan(db, client, bot, slug="pro-withheld1")
    credit_service.grant_plan_credits(db, client.id, 10000, bot_id=bot.id)
    db.commit()

    inv = Invoice(
        client_id=client.id,
        subscription_id=sub.id,
        bot_id=bot.id,
        amount_cents=44900,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_withheld_1",
        kind="withheld_charge",
    )
    db.add(inv)
    db.commit()

    rzp._handle_refund_created(db, _refund_payload("pay_withheld_1", 44900, refund_id="rfnd_wh_1"))
    db.commit()

    assert _balances(db, client.id, bot.id) == 10000


def test_dispute_lost_on_seat_invoice_claws_nothing(db):
    client = _client(db)
    bot = _bot(db, client, key="bot-seatdisp")
    sub = _sub_with_plan(db, client, bot, slug="pro-seatdisp")
    credit_service.grant_plan_credits(db, client.id, 10000, bot_id=bot.id)
    db.commit()

    inv = Invoice(
        client_id=client.id,
        subscription_id=sub.id,
        bot_id=bot.id,
        amount_cents=44900,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_seat_disp",
        kind="seat",
    )
    db.add(inv)
    db.commit()

    rzp._handle_dispute_lost(db, _dispute_payload("pay_seat_disp", dispute_id="disp_seat_1", amount=44900))
    db.commit()

    assert _balances(db, client.id, bot.id) == 10000
    db.refresh(inv)
    assert inv.status == "dispute_lost"


def test_kind_stamped_invoice_without_link_never_falls_back(db):
    """A kind-stamped plan charge with no linked grant claws NOTHING, the
    most-recent-grant guess is reserved for pre-kind legacy rows. A missed
    clawback is recoverable by ops; a wrong one is not."""
    client = _client(db)
    bot = _bot(db, client, key="bot-nolink")
    sub = _sub_with_plan(db, client, bot, slug="pro-nolink")
    # Unlinked grant from a LATER period than the refunded invoice.
    credit_service.grant_plan_credits(db, client.id, 10000, bot_id=bot.id)
    db.commit()

    inv = Invoice(
        client_id=client.id,
        subscription_id=sub.id,
        bot_id=bot.id,
        amount_cents=44900,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_nolink_1",
        kind="plan_charge",
    )
    db.add(inv)
    db.commit()

    rzp._handle_refund_created(db, _refund_payload("pay_nolink_1", 44900, refund_id="rfnd_nolink_1"))
    db.commit()

    assert _balances(db, client.id, bot.id) == 10000


def test_legacy_null_kind_keeps_fallback_behavior(db):
    """Pre-kind rows (kind IS NULL) keep the historical most-recent-grant
    fallback, for them the heuristic is usually right and C2 linking never
    existed."""
    client = _client(db)
    bot = _bot(db, client, key="bot-legacy1")
    sub = _sub_with_plan(db, client, bot, slug="pro-legacy1")
    credit_service.grant_plan_credits(db, client.id, 10000, bot_id=bot.id)
    db.commit()

    inv = Invoice(
        client_id=client.id,
        subscription_id=sub.id,
        bot_id=bot.id,
        amount_cents=44900,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_legacy_1",
        kind=None,
    )
    db.add(inv)
    db.commit()

    rzp._handle_refund_created(db, _refund_payload("pay_legacy_1", 44900, refund_id="rfnd_legacy_1"))
    db.commit()

    assert _balances(db, client.id, bot.id) == 0  # fallback clawed the grant


def test_backfill_reference_skips_negative_reset_rows(db):
    """_backfill_plan_grant_reference must link the invoice to a POSITIVE grant
    row, never a reset row, even when the reset row is newer and shares the
    same server-side created_at (same transaction)."""
    client = _client(db)
    bot = _bot(db, client, key="bot-backfill1")
    sub = _sub_with_plan(db, client, bot, slug="pro-backfill1")

    # Positive grant first (lower id), negative reset row second (higher id),
    # both flushed in ONE transaction so created_at (func.now()) is identical.
    grant = CreditLedger(client_id=client.id, bot_id=bot.id, delta=10000, reason="plan_grant")
    db.add(grant)
    db.flush()
    reset = CreditLedger(client_id=client.id, bot_id=bot.id, delta=-4000, reason="plan_grant", grant_id=grant.id)
    db.add(reset)
    db.flush()

    inv = Invoice(
        client_id=client.id,
        subscription_id=sub.id,
        bot_id=bot.id,
        amount_cents=44900,
        currency="inr",
        status="paid",
        razorpay_payment_id="pay_backfill_1",
        kind="plan_charge",
    )
    db.add(inv)
    db.flush()

    credit_service._backfill_plan_grant_reference(db, sub, inv.id)
    db.commit()

    db.refresh(grant)
    db.refresh(reset)
    assert grant.reference_id == inv.id  # positive row linked
    assert reset.reference_id is None  # reset row untouched


def test_reconcile_topup_before_capture_does_not_burn_idempotency_key(db, monkeypatch):
    """P1-5. Checkout's success handler can fire while the payment is still
    ``authorized`` (payment_capture=1 captures asynchronously). That early
    verify must NOT burn ``reconcile:topup:<order_id>``: burning it made every
    later verify short-circuit as \"already handled\" while no credits were ever
    granted. Paid-but-no-credits with the webhook as the only (possibly
    dropped) remaining path."""
    client = _client(db)
    db.commit()

    order = {
        "id": "order_early",
        "amount": 399900,
        "currency": "INR",
        "notes": {"purpose": "topup", "client_id": str(client.id), "credits": "2000", "amount_inr": "3999"},
    }
    authorized = {
        "id": "pay_early",
        "order_id": "order_early",
        "amount": 399900,
        "currency": "INR",
        "status": "authorized",
    }
    monkeypatch.setattr(rzp, "_get_razorpay", lambda: _fake_rzp_for_topup(order, authorized))

    # Verify races auto-capture: nothing granted, and crucially nothing burned.
    assert rzp.reconcile_topup_from_razorpay(db, "order_early", "pay_early", expected_client_id=client.id) is False
    db.commit()
    assert _balances(db, client.id, None) == 0

    # Capture completes; the retried verify must now grant.
    captured = {**authorized, "status": "captured"}
    monkeypatch.setattr(rzp, "_get_razorpay", lambda: _fake_rzp_for_topup(order, captured))
    assert rzp.reconcile_topup_from_razorpay(db, "order_early", "pay_early", expected_client_id=client.id) is True
    db.commit()
    assert _balances(db, client.id, None) == 2000


def test_refund_failed_reverses_refunded_minor_and_recomputes_status(db):
    """P1-6b. Refund.failed must subtract the failed amount from
    ``refunded_minor`` and recompute status from what still stands, or a later
    genuine partial refund flips the invoice to \"refunded\" though less money
    was returned."""
    client = _client(db)
    credit_service.grant_topup(db, client.id, 1000)
    db.commit()

    inv = Invoice(
        client_id=client.id,
        amount_cents=4000,
        currency="inr",
        status="paid",
        kind="topup",
        razorpay_payment_id="pay_rf_1",
    )
    db.add(inv)
    db.commit()

    # Two partial refunds initiated (1000 each), the SECOND then fails.
    rzp._handle_refund_created(db, _refund_payload("pay_rf_1", 1000, refund_id="rfnd_a"))
    rzp._handle_refund_created(db, _refund_payload("pay_rf_1", 1000, refund_id="rfnd_b"))
    db.commit()
    db.refresh(inv)
    assert inv.refunded_minor == 2000
    assert inv.status == "partially_refunded"

    rzp._handle_refund_failed(db, _refund_payload("pay_rf_1", 1000, refund_id="rfnd_b"))
    db.commit()
    db.refresh(inv)
    # Only refund A still stands.
    assert inv.refunded_minor == 1000
    assert inv.status == "partially_refunded"

    # A full-reversal failure clears back to paid.
    rzp._handle_refund_failed(db, _refund_payload("pay_rf_1", 1000, refund_id="rfnd_a"))
    db.commit()
    db.refresh(inv)
    assert inv.refunded_minor == 0
    assert inv.status == "paid"


def test_captured_replay_after_refund_is_acked_not_errored(db, monkeypatch):
    """P1-6d, an order.paid alias redelivered AFTER a refund (invoice status
    no longer \"paid\") must early-return, not attempt a duplicate insert that
    5xx-loops on the unique payment-id index until Razorpay gives up."""
    client = _client(db)
    db.commit()

    inv = Invoice(
        client_id=client.id,
        amount_cents=399900,
        currency="inr",
        status="refunded",
        refunded_minor=399900,
        kind="topup",
        razorpay_payment_id="pay_replay_1",
    )
    db.add(inv)
    db.commit()

    payload = {
        "payment": {
            "entity": {
                "id": "pay_replay_1",
                "order_id": "order_replay_1",
                "amount": 399900,
                "currency": "INR",
                "status": "captured",
                "notes": {"purpose": "topup", "client_id": str(client.id), "credits": "2000", "amount_inr": "3999"},
            }
        }
    }
    result = rzp._handle_payment_captured(db, payload)
    db.commit()

    assert "already recorded" in result
    assert _balances(db, client.id, None) == 0  # refunded charge grants nothing


def test_charged_without_payment_entity_on_canceled_row_does_not_error(db):
    """Review fix, a charged payload WITHOUT payment.entity is legal; the
    withheld-charge stamp branches must not NameError on the unbound invoice
    (in the backstop branch that raise landed AFTER the irreversible gateway
    cancel, wedging the row in a dead-letter loop)."""
    client = _client(db)
    bot = _bot(db, client, key="bot-noent")
    sub = _sub_with_plan(db, client, bot, slug="pro-noent")
    sub.razorpay_subscription_id = "sub_noent"
    sub.status = "canceled"
    db.commit()

    result = rzp._handle_subscription_charged(
        db, {"subscription": {"entity": {"id": "sub_noent", "current_end": 1780000000}}}
    )
    db.commit()
    assert "not reactivated" in result


def test_withheld_stamp_never_overwrites_a_funded_invoice(db):
    """Review fix, a delayed charged webhook must not re-label an invoice
    whose charge DID fund a linked grant: that would disable its clawback."""
    client = _client(db)
    bot = _bot(db, client, key="bot-funded")
    sub = _sub_with_plan(db, client, bot, slug="pro-funded")
    sub.razorpay_subscription_id = "sub_funded"
    sub.status = "canceled"
    db.commit()

    inv = Invoice(
        client_id=client.id,
        subscription_id=sub.id,
        bot_id=bot.id,
        amount_cents=44900,
        currency="inr",
        status="paid",
        kind="plan_charge",
        razorpay_payment_id="pay_funded_1",
    )
    db.add(inv)
    db.flush()
    credit_service.grant_plan_credits(db, client.id, 10000, bot_id=bot.id, reference_id=inv.id)
    db.commit()

    rzp._handle_subscription_charged(
        db,
        {
            "subscription": {"entity": {"id": "sub_funded", "current_end": 1780000000}},
            "payment": {"entity": {"id": "pay_funded_1", "amount": 44900, "currency": "INR"}},
        },
    )
    db.commit()
    db.refresh(inv)
    assert inv.kind == "plan_charge"  # NOT re-labelled withheld_charge

    # And an unfunded fresh charge on the same canceled row DOES get stamped.
    rzp._handle_subscription_charged(
        db,
        {
            "subscription": {"entity": {"id": "sub_funded", "current_end": 1780000001}},
            "payment": {"entity": {"id": "pay_funded_2", "amount": 44900, "currency": "INR"}},
        },
    )
    db.commit()
    fresh = db.execute(select(Invoice).where(Invoice.razorpay_payment_id == "pay_funded_2")).scalars().first()
    assert fresh is not None
    assert fresh.kind == "withheld_charge"


# ── The refund/dispute dedup key must not be burned before the work happens ──
#
# ``_handle_refund_created`` records ``refund:{id}`` and only THEN looks up the
# invoice. When the invoice is not there yet (its ``subscription.charged`` is
# still being retried, and ops refunded from the dashboard meanwhile) the
# handler ACKed with the key burned, so the clawback could never run: every
# later ``refund.processed`` — which delegates to this same function — and every
# superadmin replay short-circuits on "already clawed back". The customer keeps
# a full allowance AND their money, and no reconcile job covers it.
#
# Nothing was persisted on that path, so the key must be RELEASED, exactly as
# the pooled-plan sink refusal does.


def test_refund_for_an_unknown_payment_releases_its_dedup_key(db):
    client = _client(db, n=91)
    bot = _bot(db, client, key="bot-claw-late")
    credit_service.grant_topup(db, client.id, 500, bot_id=bot.id)
    db.commit()

    # The invoice has not landed yet: the refund arrives first.
    rzp._handle_refund_created(db, _refund_payload("pay_late_invoice", 3999, refund_id="rf_late"))
    db.commit()
    assert _balances(db, client.id, bot.id) == 500, "nothing to claw yet"

    # The charge finally materialises (webhook redelivery).
    db.add(
        Invoice(
            client_id=client.id,
            subscription_id=None,
            bot_id=bot.id,
            amount_cents=3999,
            currency="inr",
            status="paid",
            razorpay_payment_id="pay_late_invoice",
        )
    )
    db.commit()

    # The SAME refund, redelivered as refund.processed, must now claw.
    rzp._handle_refund_created(db, _refund_payload("pay_late_invoice", 3999, refund_id="rf_late"))
    db.commit()
    assert _balances(db, client.id, bot.id) == 0, "the redelivered refund must claw once the invoice exists"


def test_dispute_lost_for_an_unknown_payment_releases_its_dedup_key(db):
    client = _client(db, n=92)
    bot = _bot(db, client, key="bot-claw-disp")
    credit_service.grant_topup(db, client.id, 500, bot_id=bot.id)
    db.commit()

    payload = {
        "payment": {"entity": {"id": "pay_late_dispute"}},
        "dispute": {"entity": {"id": "disp_late", "payment_id": "pay_late_dispute", "amount": 3999}},
    }
    rzp._handle_dispute_lost(db, payload)
    db.commit()
    assert _balances(db, client.id, bot.id) == 500

    db.add(
        Invoice(
            client_id=client.id,
            subscription_id=None,
            bot_id=bot.id,
            amount_cents=3999,
            currency="inr",
            status="paid",
            razorpay_payment_id="pay_late_dispute",
        )
    )
    db.commit()

    rzp._handle_dispute_lost(db, payload)
    db.commit()
    assert _balances(db, client.id, bot.id) == 0, "the redelivered dispute must claw once the invoice exists"
