"""Razorpay service tests.

These tests stay fully offline — every external Razorpay SDK call is mocked
via ``unittest.mock``. They lock down the contract our code expects from the
SDK so any future SDK upgrade or refactor surfaces immediately.

What we cover here:

* Top-up Order request shape (amount in paise, currency, notes structure).
* Subscription create request shape (plan_id selection by billing cycle,
  total_count, notes propagation, quantity).
* Webhook dispatcher routing (every supported event type lands in the
  matching handler).
* Webhook idempotency (duplicate ``x-razorpay-event-id`` is a no-op).
* Failure paths — ``ValueError`` for missing plan IDs / missing pack amounts.

Live API + signature crypto are exercised separately by
``scripts/razorpay_smoke_test.py`` once the user pastes test keys.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _razorpay_keys(monkeypatch):
    """Provide dummy keys so ``RAZORPAY_ENABLED`` flips on for service init.

    The Razorpay SDK itself is mocked elsewhere — we only need
    ``app.config.RAZORPAY_ENABLED`` to be ``True`` so :func:`_get_razorpay`
    proceeds past its env-var guard.
    """
    monkeypatch.setenv("RAZORPAY_KEY_ID", "rzp_test_dummy")
    monkeypatch.setenv("RAZORPAY_KEY_SECRET", "secret_dummy")
    monkeypatch.setenv("RAZORPAY_WEBHOOK_SECRET", "whsec_dummy")
    # Force a fresh import so the module-level constants pick up the patched env.
    from importlib import reload

    import app.config

    reload(app.config)
    import app.services.razorpay_service as svc

    reload(svc)
    yield


def _make_client(client_id: int = 42) -> SimpleNamespace:
    return SimpleNamespace(id=client_id, name="Acme Pvt Ltd", email="ops@acme.example")


def _make_plan(**overrides) -> SimpleNamespace:
    base = {
        "id": 7,
        "name": "Starter",
        "slug": "starter",
        "currency": "INR",
        "monthly_price_cents": 149900,
        "annual_price_cents": 1259000,
        "credits_per_month": 2000,
        "included_operator_seats": 1,
        "extra_seat_price_cents": 119900,
        "razorpay_plan_id_monthly": "plan_starter_inr_monthly",
        "razorpay_plan_id_annual": "plan_starter_inr_annual",
    }
    base.update(overrides)
    return SimpleNamespace(**base)


# ── create_topup_order ────────────────────────────────────────────────────────


def test_create_topup_order_sends_paise_inr_and_notes():
    from app.services import razorpay_service

    fake_client = MagicMock()
    fake_client.order.create.return_value = {"id": "order_test123", "status": "created"}

    pack = {
        "amount": 1599,  # rupees
        "credits": 2000,
        "bonus_pct": 0,
        "currency": "INR",
    }

    with patch.object(razorpay_service, "_get_razorpay", return_value=fake_client):
        result = razorpay_service.create_topup_order(MagicMock(), _make_client(7), pack)

    fake_client.order.create.assert_called_once()
    sent = fake_client.order.create.call_args.kwargs["data"]
    assert sent["amount"] == 159900  # rupees → paise
    assert sent["currency"] == "INR"
    assert sent["payment_capture"] == 1
    assert sent["notes"] == {
        "purpose": "topup",
        "client_id": "7",
        "credits": "2000",
        "amount_inr": "1599",
        "bonus_pct": "0",
    }
    assert sent["receipt"].startswith("topup_c7_")

    assert result["provider"] == "razorpay"
    assert result["order_id"] == "order_test123"
    assert result["amount"] == 159900
    assert result["currency"] == "INR"
    assert result["credits"] == 2000
    assert result["key_id"] == "rzp_test_dummy"
    assert result["prefill"]["email"] == "ops@acme.example"


def test_create_topup_order_rejects_pack_without_amount():
    from app.services import razorpay_service

    with pytest.raises(ValueError, match="amount"):
        razorpay_service.create_topup_order(
            MagicMock(),
            _make_client(),
            {"credits": 2000},  # no amount
        )


def test_create_topup_order_propagates_bonus_in_description():
    from app.services import razorpay_service

    fake = MagicMock()
    fake.order.create.return_value = {"id": "order_xyz", "status": "created"}
    pack = {"amount": 7999, "credits": 12000, "bonus_pct": 20}

    with patch.object(razorpay_service, "_get_razorpay", return_value=fake):
        result = razorpay_service.create_topup_order(MagicMock(), _make_client(), pack)

    assert "20% bonus" in result["description"]
    assert result["bonus_pct"] == 20


# ── create_subscription ───────────────────────────────────────────────────────


def test_create_subscription_picks_monthly_plan_id_by_default():
    from app.services import razorpay_service

    fake = MagicMock()
    fake.subscription.create.return_value = {
        "id": "sub_starter_test",
        "short_url": "https://rzp.io/i/test",
        "status": "created",
    }

    with patch.object(razorpay_service, "_get_razorpay", return_value=fake):
        result = razorpay_service.create_subscription(
            MagicMock(), _make_client(13), _make_plan(), billing_cycle="monthly"
        )

    sent = fake.subscription.create.call_args.kwargs["data"]
    assert sent["plan_id"] == "plan_starter_inr_monthly"
    assert sent["customer_notify"] == 1
    assert sent["quantity"] == 1
    assert sent["total_count"] == 120
    assert sent["notes"] == {
        "oyechats_client_id": "13",
        "oyechats_plan_id": "7",
        "billing_cycle": "monthly",
    }
    assert result["provider"] == "razorpay"
    assert result["subscription_id"] == "sub_starter_test"


def test_create_subscription_picks_annual_plan_id():
    from app.services import razorpay_service

    fake = MagicMock()
    fake.subscription.create.return_value = {"id": "sub_a", "short_url": "x", "status": "created"}

    with patch.object(razorpay_service, "_get_razorpay", return_value=fake):
        razorpay_service.create_subscription(MagicMock(), _make_client(), _make_plan(), billing_cycle="annual")

    sent = fake.subscription.create.call_args.kwargs["data"]
    assert sent["plan_id"] == "plan_starter_inr_annual"


def test_create_subscription_rejects_invalid_billing_cycle():
    from app.services import razorpay_service

    with pytest.raises(ValueError):
        razorpay_service.create_subscription(MagicMock(), _make_client(), _make_plan(), billing_cycle="quarterly")


def test_create_subscription_rejects_missing_plan_id():
    from app.services import razorpay_service

    plan = _make_plan(razorpay_plan_id_monthly=None)
    with pytest.raises(ValueError, match=r"(?i)razorpay plan id"):
        razorpay_service.create_subscription(MagicMock(), _make_client(), plan)


def test_base_subscription_quantity_is_one_for_multi_seat_plan():
    """Standard plan (2 included seats) must still send quantity=1.

    Razorpay `quantity` multiplies the WHOLE plan amount, so passing
    included_operator_seats=2 would bill ₹4,599×2 = ₹9,198 instead of
    ₹4,599. Extra seats are billed via a separate add-on subscription.
    """
    from app.services import razorpay_service

    fake = MagicMock()
    fake.subscription.create.return_value = {"id": "sub_std", "short_url": "u", "status": "created"}

    standard = _make_plan(
        id=2, name="Standard", slug="standard",
        razorpay_plan_id_monthly="plan_standard_inr_monthly",
        razorpay_plan_id_annual="plan_standard_inr_annual",
        included_operator_seats=2,
    )
    with patch.object(razorpay_service, "_get_razorpay", return_value=fake):
        razorpay_service.create_subscription(MagicMock(), _make_client(), standard, "monthly")

    sent = fake.subscription.create.call_args.kwargs["data"]
    assert sent["quantity"] == 1, f"Expected quantity=1, got {sent['quantity']}"


def test_create_seat_addon_subscription():
    """Seat add-on creates a separate Razorpay subscription at ₹499 × N."""
    from app.services import razorpay_service

    fake = MagicMock()
    fake.subscription.create.return_value = {"id": "sub_seats", "status": "created"}

    with patch.object(razorpay_service, "_get_razorpay", return_value=fake):
        result = razorpay_service.create_seat_addon_subscription(
            MagicMock(), _make_client(), extra_seats=3
        )

    sent = fake.subscription.create.call_args.kwargs["data"]
    assert sent["plan_id"] == razorpay_service.RAZORPAY_SEAT_PLAN_ID
    assert sent["quantity"] == 3
    assert sent["total_count"] == 120
    assert sent["notes"]["purpose"] == "seat_addon"
    assert result["provider"] == "razorpay"
    assert result["subscription_id"] == "sub_seats"
    assert "3 extra seat" in result["description"]


def test_create_seat_addon_rejects_zero_seats():
    from app.services import razorpay_service

    with pytest.raises(ValueError, match="extra_seats"):
        razorpay_service.create_seat_addon_subscription(MagicMock(), _make_client(), extra_seats=0)


# ── resolve_discounted_plan ───────────────────────────────────────────────────


def test_resolve_discounted_plan_creates_and_caches(monkeypatch):
    """Cache miss: creates a discounted Razorpay plan at the right paise amount."""
    from app.services import razorpay_service as rs

    rzp = MagicMock()
    rzp.plan.create.return_value = {"id": "plan_disc_15pct"}
    monkeypatch.setattr(rs, "_get_razorpay", lambda: rzp)

    session = MagicMock()
    session.scalars.return_value.first.return_value = None  # cache miss

    base = _make_plan(
        id=2, name="Standard", slug="standard",
        monthly_price_cents=459900, annual_price_cents=4409900,
    )
    result = rs.resolve_discounted_plan(session, base, "monthly", 1500)

    assert result == "plan_disc_15pct"
    sent = rzp.plan.create.call_args.kwargs["data"]
    # 459900 - (459900 * 1500) // 10000 = 459900 - 68985 = 390915
    assert sent["item"]["amount"] == 390915
    assert sent["item"]["currency"] == "INR"
    assert sent["period"] == "monthly"
    assert rzp.plan.create.call_count == 1
    session.add.assert_called_once()
    session.flush.assert_called_once()


def test_resolve_discounted_plan_reuses_cached(monkeypatch):
    """Cache hit: returns stored plan_id without calling Razorpay."""
    from app.services import razorpay_service as rs

    rzp = MagicMock()
    monkeypatch.setattr(rs, "_get_razorpay", lambda: rzp)

    session = MagicMock()
    cached = SimpleNamespace(razorpay_plan_id="plan_already_exists")
    session.scalars.return_value.first.return_value = cached

    base = _make_plan(id=2, name="Standard", slug="standard",
                      monthly_price_cents=459900, annual_price_cents=4409900)
    result = rs.resolve_discounted_plan(session, base, "monthly", 1500)

    assert result == "plan_already_exists"
    rzp.plan.create.assert_not_called()


def test_resolve_discounted_plan_annual_uses_annual_price(monkeypatch):
    """Annual cycle uses annual_price_cents as the base amount."""
    from app.services import razorpay_service as rs

    rzp = MagicMock()
    rzp.plan.create.return_value = {"id": "plan_disc_annual"}
    monkeypatch.setattr(rs, "_get_razorpay", lambda: rzp)

    session = MagicMock()
    session.scalars.return_value.first.return_value = None

    base = _make_plan(id=2, name="Standard", slug="standard",
                      monthly_price_cents=459900, annual_price_cents=4409900)
    rs.resolve_discounted_plan(session, base, "annual", 1000)

    sent = rzp.plan.create.call_args.kwargs["data"]
    # 4409900 - (4409900 * 1000) // 10000 = 4409900 - 440990 = 3968910
    assert sent["item"]["amount"] == 3968910
    assert sent["period"] == "yearly"


def test_resolve_discounted_plan_rejects_invalid_bps():
    from app.services import razorpay_service as rs

    with pytest.raises(ValueError, match="discount_bps"):
        rs.resolve_discounted_plan(MagicMock(), _make_plan(), "monthly", 0)

    with pytest.raises(ValueError, match="discount_bps"):
        rs.resolve_discounted_plan(MagicMock(), _make_plan(), "monthly", 10000)


def test_resolve_discounted_plan_rejects_invalid_cycle():
    from app.services import razorpay_service as rs

    with pytest.raises(ValueError, match="billing_cycle"):
        rs.resolve_discounted_plan(MagicMock(), _make_plan(), "weekly", 500)


# ── Webhook dispatcher ────────────────────────────────────────────────────────


def test_webhook_dispatcher_routes_known_events_to_handlers():
    """Every supported event name routes into the right handler.

    We patch the handlers to no-ops so we're testing the routing table alone.
    """
    from app.services import razorpay_service

    routed: list[str] = []

    def _capture(name):
        def _handler(_session, _payload):
            routed.append(name)
            return f"ok-{name}"

        return _handler

    patch_targets = {
        "_handle_subscription_activated": _capture("subscription.activated"),
        "_handle_subscription_charged": _capture("subscription.charged"),
        "_handle_subscription_cancelled": _capture("subscription.cancelled"),
        "_handle_subscription_completed": _capture("subscription.completed"),
        "_handle_subscription_halted": _capture("subscription.halted"),
        "_handle_subscription_pending": _capture("subscription.pending"),
        "_handle_payment_captured": _capture("payment.captured"),
        "_handle_payment_failed": _capture("payment.failed"),
    }
    with (
        patch.multiple(razorpay_service, **patch_targets),
        patch.object(razorpay_service, "_record_or_skip_event", return_value=True),
    ):
        for event_name in [
            "subscription.activated",
            "subscription.charged",
            "subscription.cancelled",
            "subscription.completed",
            "subscription.halted",
            "subscription.pending",
            "payment.captured",
            "payment.failed",
            "order.paid",  # alias for payment.captured
        ]:
            res = razorpay_service.handle_webhook_event(
                MagicMock(),
                {"event": event_name, "payload": {}},
                event_id=f"evt_{event_name}",
            )
            assert "ok-" in res or "ignored" in res or "logged" in res, (
                f"{event_name} produced unexpected result: {res!r}"
            )

    # subscription.activated AND subscription.resumed both go through activated;
    # payment.captured AND order.paid both go through captured.
    assert routed.count("subscription.activated") == 1
    assert routed.count("payment.captured") == 2  # payment.captured + order.paid


def test_webhook_dispatcher_unknown_event_is_safe_noop():
    from app.services import razorpay_service

    with patch.object(razorpay_service, "_record_or_skip_event", return_value=True):
        result = razorpay_service.handle_webhook_event(
            MagicMock(), {"event": "subscription.unicorn", "payload": {}}, event_id="evt_x"
        )
    assert "Unhandled" in result


def test_webhook_dispatcher_skips_replay():
    """A second delivery with the same ``x-razorpay-event-id`` is a no-op.

    The idempotency layer now uses ``INSERT … ON CONFLICT DO NOTHING`` and
    keys off ``result.rowcount``: 1 means our INSERT actually wrote a row
    (first delivery), 0 means another worker already recorded this event_id
    (duplicate delivery). Simulate the duplicate-delivery case by stubbing
    ``session.execute`` to return a result with ``rowcount=0``.
    """
    from app.services import razorpay_service

    session = MagicMock()
    # Simulate "already in processed_webhooks": ON CONFLICT swallowed the row.
    duplicate_result = MagicMock()
    duplicate_result.rowcount = 0
    session.execute.return_value = duplicate_result

    result = razorpay_service.handle_webhook_event(
        session, {"event": "payment.captured", "payload": {}}, event_id="evt_replay"
    )
    assert "Duplicate" in result and "skipped" in result


# ── Topup capture handler ────────────────────────────────────────────────────


def test_payment_captured_grants_topup_when_purpose_marker_present():
    """``payment.captured`` with ``notes.purpose='topup'`` triggers grant_topup."""
    from app.services import razorpay_service

    payload = {
        "payment": {
            "entity": {
                "id": "pay_test001",
                "order_id": "order_test001",
                "amount": 159900,
                "currency": "INR",
                "notes": {
                    "purpose": "topup",
                    "client_id": "9",
                    "credits": "2000",
                    "amount_inr": "1599",
                },
            }
        }
    }
    session = MagicMock()
    # Pretend no existing invoice → grant runs.
    session.execute.return_value.scalars.return_value.first.return_value = None

    with patch("app.services.credit_service.grant_topup") as grant:
        razorpay_service._handle_payment_captured(session, payload)

    grant.assert_called_once()
    args, kwargs = grant.call_args
    # grant_topup(session, client_id, amount, note=...)
    assert args[1] == 9
    assert args[2] == 2000
    assert "Top-up ₹1599 pack" in kwargs.get("note", "")


def test_payment_captured_ignored_for_non_topup_payments():
    """Subscription cycle payments arrive via ``subscription.charged``;
    ``payment.captured`` without the topup marker should NOT grant credits."""
    from app.services import razorpay_service

    payload = {"payment": {"entity": {"id": "pay_x", "amount": 1000, "notes": {}}}}
    with patch("app.services.credit_service.grant_topup") as grant:
        result = razorpay_service._handle_payment_captured(MagicMock(), payload)

    grant.assert_not_called()
    assert "ignored" in result


# ── Webhook signature roundtrip ───────────────────────────────────────────────


def test_webhook_signature_roundtrip_accepts_valid_hmac():
    """Sign a synthetic payload with HMAC-SHA256(secret, body) and confirm
    our :func:`verify_webhook_signature` accepts it.

    Razorpay's webhook signature is exactly this construction (we call into
    the SDK utility, which the SDK implements as ``hmac.new(secret, body,
    sha256).hexdigest()`` — same as Stripe but with their secret). This test
    locks down the contract end-to-end without any network call.
    """
    import hashlib
    import hmac as _hmac

    from app.services import razorpay_service

    secret = "whsec_dummy"
    payload = b'{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_x"}}}}'
    sig = _hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()

    # Should not raise
    razorpay_service.verify_webhook_signature(payload=payload, signature=sig)


def test_webhook_signature_roundtrip_rejects_tampered_body():
    """Flipping a single byte in the body must invalidate the signature."""
    import hashlib
    import hmac as _hmac

    from app.services import razorpay_service

    secret = "whsec_dummy"
    payload = b'{"event":"payment.captured"}'
    sig = _hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()
    tampered = payload.replace(b"captured", b"failed   ")

    with pytest.raises(razorpay_service.SignatureMismatch):
        razorpay_service.verify_webhook_signature(payload=tampered, signature=sig)


def test_webhook_signature_roundtrip_rejects_wrong_secret():
    """A signature computed with the wrong secret must be rejected."""
    import hashlib
    import hmac as _hmac

    from app.services import razorpay_service

    payload = b'{"event":"payment.captured"}'
    bad_sig = _hmac.new(b"WRONG_SECRET", payload, hashlib.sha256).hexdigest()

    with pytest.raises(razorpay_service.SignatureMismatch):
        razorpay_service.verify_webhook_signature(payload=payload, signature=bad_sig)
