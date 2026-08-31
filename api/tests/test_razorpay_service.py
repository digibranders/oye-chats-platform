"""Razorpay service tests.

These tests stay fully offline. Every external Razorpay SDK call is mocked
via ``unittest.mock``. They lock down the contract our code expects from the
SDK so any future SDK upgrade or refactor surfaces immediately.

What we cover here:

* Top-up Order request shape (amount in paise, currency, notes structure).
* Subscription create request shape (plan_id selection by billing cycle,
  total_count, notes propagation, quantity).
* Webhook dispatcher routing (every supported event type lands in the
  matching handler).
* Webhook idempotency (duplicate ``x-razorpay-event-id`` is a no-op).
* Failure paths. ``ValueError`` for missing plan IDs / missing pack amounts.

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

    The Razorpay SDK itself is mocked elsewhere. We only need
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


@pytest.fixture(autouse=True)
def _seller_tax_rate():
    """Pin the GST rate these tests compute charges against.

    Every published price is a BASE price, so the charge sites uplift by
    ``charge_tax_rate_bps``, which returns 0 for a profile with no GSTIN. The
    sessions in this module are ``MagicMock``s, which resolve to an
    unconfigured profile and therefore to a 0% rate. Pin the live 18% so the
    expected charges below are real arithmetic rather than a silent no-op.
    """
    from app.services import razorpay_service as svc

    with patch.object(svc, "charge_tax_rate_bps", return_value=1800):
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
    # ₹1,599 base + 18% GST. Published prices are exclusive of tax, so the
    # order collects base + GST (188682 paise = ₹1,886.82).
    assert sent["amount"] == 188682
    assert sent["currency"] == "INR"
    assert sent["payment_capture"] == 1
    assert sent["notes"] == {
        "purpose": "topup",
        "client_id": "7",
        "credits": "2000",
        # BASE rupees: the advertised pack price and the taxable value.
        "amount_inr": "1599",
        # What is actually captured. The capture handler reconciles against
        # THIS, not against amount_inr.
        "charge_paise": "188682",
        "bonus_pct": "0",
    }
    assert sent["receipt"].startswith("topup_c7_")

    assert result["provider"] == "razorpay"
    assert result["order_id"] == "order_test123"
    # The payload the checkout sheet opens with quotes the CHARGE, so the sheet
    # and the debit can never disagree.
    assert result["amount"] == 188682
    assert result["currency"] == "INR"
    assert result["credits"] == 2000
    assert result["key_id"] == "rzp_test_dummy"
    assert result["prefill"]["email"] == "ops@acme.example"


def test_create_topup_order_reads_inr_key_and_never_charges_usd():
    """Regression: packs carry the INR price under ``inr`` (config schema), with
    ``usd`` as a display-only figure. The order must charge the INR rupees as
    paise (never the USD number) and stamp the USD price in notes."""
    from app.services import razorpay_service

    fake_client = MagicMock()
    fake_client.order.create.return_value = {"id": "order_inr", "status": "created"}

    # Matches the live pricing_config.topup_packs shape exactly.
    pack = {"inr": 1599, "usd": 19, "credits": 2000, "bonus_pct": 0}

    with patch.object(razorpay_service, "_get_razorpay", return_value=fake_client):
        result = razorpay_service.create_topup_order(MagicMock(), _make_client(7), pack)

    sent = fake_client.order.create.call_args.kwargs["data"]
    # ₹1,599 base + 18% GST, NOT the $19 figure. ``amount_inr`` in notes stays
    # the BASE rupees, which is what the pack advertises and the invoice carves.
    assert sent["amount"] == 188682
    assert sent["currency"] == "INR"
    assert sent["notes"]["amount_inr"] == "1599"
    assert sent["notes"]["display_price"] == "$19"  # usd carried as display-only
    assert result["amount"] == 188682


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
    """A missing plan id refuses as ``PlanNotCheckoutable``, NOT as a ValueError.

    The type is the contract. A tier with no gateway plan id stays listed and
    quotes contact-sales, so the charge path has to refuse in that same shape,
    and the money routes' ``except ValueError -> 400 str(exc)`` handlers would
    have handed the buyer the operator instruction verbatim. Staying outside
    ``ValueError`` is what routes it to the app-level 409 handler instead.
    """
    from app.services import razorpay_service

    plan = _make_plan(razorpay_plan_id_monthly=None)
    with pytest.raises(razorpay_service.PlanNotCheckoutable) as excinfo:
        razorpay_service.create_subscription(MagicMock(), _make_client(), plan)

    assert not isinstance(excinfo.value, ValueError)
    assert excinfo.value.reason == "inr_plan_unconfigured"
    assert "Razorpay plan id" in excinfo.value.ops_detail
    assert "Razorpay" not in str(excinfo.value)


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
        id=2,
        name="Standard",
        slug="standard",
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

    # The seat plan is minted on demand and cached by charged amount rather than
    # pinned in the environment, so what is stubbed here is the resolver, not
    # ``RAZORPAY_SEAT_PLAN_ID`` (which this path no longer reads).
    with (
        patch.object(razorpay_service, "resolve_addon_plan_id", return_value="plan_test_seat"),
        patch.object(razorpay_service, "charge_tax_rate_bps", return_value=1800),
        patch.object(razorpay_service, "_get_razorpay", return_value=fake),
    ):
        result = razorpay_service.create_seat_addon_subscription(MagicMock(), _make_client(), extra_seats=3)

    sent = fake.subscription.create.call_args.kwargs["data"]
    assert sent["plan_id"] == "plan_test_seat"
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
        id=2,
        name="Standard",
        slug="standard",
        monthly_price_cents=459900,
        annual_price_cents=4409900,
    )
    result = rs.resolve_discounted_plan(session, base, "monthly", 1500)

    assert result == "plan_disc_15pct"
    sent = rzp.plan.create.call_args.kwargs["data"]
    # Base after discount: 459900 - (459900 * 1500) // 10000 = 390915.
    # Charged with 18% GST on top: 461280 paise.
    assert sent["item"]["amount"] == 461280
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
    # A hit is valid only when the cached amount still matches the price the
    # current base plan produces (F34): 459900 − 15% = 390915.
    # The cache stores the CHARGED amount (base 390915 + 18% GST = 461280), so
    # a GST rate change invalidates it instead of reusing a stale mandate.
    cached = SimpleNamespace(razorpay_plan_id="plan_already_exists", amount_paise=461280)
    session.scalars.return_value.first.return_value = cached

    base = _make_plan(id=2, name="Standard", slug="standard", monthly_price_cents=459900, annual_price_cents=4409900)
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

    base = _make_plan(id=2, name="Standard", slug="standard", monthly_price_cents=459900, annual_price_cents=4409900)
    rs.resolve_discounted_plan(session, base, "annual", 1000)

    sent = rzp.plan.create.call_args.kwargs["data"]
    # Base after discount: 4409900 - (4409900 * 1000) // 10000 = 3968910.
    # Charged with 18% GST on top: 4683314 paise.
    assert sent["item"]["amount"] == 4683314
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


# ── create_subscription + discount_bps ───────────────────────────────────────


def test_create_subscription_uses_discounted_plan_when_bps_given(monkeypatch):
    """With discount_bps set, create_subscription swaps in the discounted plan_id."""
    from app.services import razorpay_service as rs

    rzp = MagicMock()
    rzp.subscription.create.return_value = {"id": "sub_disc", "short_url": "u", "status": "created"}
    monkeypatch.setattr(rs, "_get_razorpay", lambda: rzp)
    monkeypatch.setattr(rs, "resolve_discounted_plan", lambda *a, **kw: "plan_disc_15pct")

    plan = _make_plan(
        id=2,
        name="Standard",
        slug="standard",
        razorpay_plan_id_monthly="plan_base",
        razorpay_plan_id_annual="plan_base_y",
        included_operator_seats=2,
    )
    result = rs.create_subscription(MagicMock(), _make_client(), plan, "monthly", discount_bps=1500)

    sent = rzp.subscription.create.call_args.kwargs["data"]
    assert sent["plan_id"] == "plan_disc_15pct"
    assert result["billing_plan_id"] == "plan_disc_15pct"


def test_create_subscription_no_discount_uses_base_plan(monkeypatch):
    """Without discount_bps, the base plan_id is used and billing_plan_id matches."""
    from app.services import razorpay_service as rs

    rzp = MagicMock()
    rzp.subscription.create.return_value = {"id": "sub_base", "short_url": "u", "status": "created"}
    monkeypatch.setattr(rs, "_get_razorpay", lambda: rzp)

    plan = _make_plan(razorpay_plan_id_monthly="plan_starter_inr_monthly")
    result = rs.create_subscription(MagicMock(), _make_client(), plan, "monthly")

    sent = rzp.subscription.create.call_args.kwargs["data"]
    assert sent["plan_id"] == "plan_starter_inr_monthly"
    assert result["billing_plan_id"] == "plan_starter_inr_monthly"


def test_create_subscription_auto_resolves_referral_discount(monkeypatch):
    """Regression (bug B): when the caller passes no ``discount_bps``, a referred
    customer's standing discount is auto-resolved and applied. This is what keeps
    the discount on the change-plan, upgrade, downgrade-cutover and per-bot paths
    (which all call create_subscription without an explicit discount), so a
    referred customer keeps their discount on every future payment.
    """
    from app.services import razorpay_service as rs

    rzp = MagicMock()
    rzp.subscription.create.return_value = {"id": "sub_auto", "short_url": "u", "status": "created"}
    monkeypatch.setattr(rs, "_get_razorpay", lambda: rzp)
    monkeypatch.setattr(rs, "resolve_discounted_plan", lambda *a, **kw: "plan_disc_auto")
    monkeypatch.setattr(
        "app.services.discount_service.resolve_customer_discount_bps",
        lambda *a, **kw: (1500, {"referral_code": "PRIYA20"}),
    )

    referred = SimpleNamespace(id=55, name="Ref", email="r@e.com", referral_code_id=99)
    # No discount_bps passed. Mirrors the change-plan / upgrade / per-bot calls.
    result = rs.create_subscription(MagicMock(), referred, _make_plan(), "monthly")

    sent = rzp.subscription.create.call_args.kwargs["data"]
    assert sent["plan_id"] == "plan_disc_auto"
    assert result["billing_plan_id"] == "plan_disc_auto"


def test_create_subscription_explicit_zero_skips_auto_discount(monkeypatch):
    """An explicit ``discount_bps=0`` forces full price even for a referred
    client. Auto-resolution only triggers on the ``None`` default, so callers
    can still opt out deliberately.
    """
    from app.services import razorpay_service as rs

    rzp = MagicMock()
    rzp.subscription.create.return_value = {"id": "sub_full", "short_url": "u", "status": "created"}
    monkeypatch.setattr(rs, "_get_razorpay", lambda: rzp)

    called = {"resolve": False, "disc": False}
    monkeypatch.setattr(
        "app.services.discount_service.resolve_customer_discount_bps",
        lambda *a, **kw: called.__setitem__("resolve", True) or (1500, {}),
    )
    monkeypatch.setattr(
        rs,
        "resolve_discounted_plan",
        lambda *a, **kw: called.__setitem__("disc", True) or "plan_should_not_be_used",
    )

    referred = SimpleNamespace(id=55, name="Ref", email="r@e.com", referral_code_id=99)
    result = rs.create_subscription(MagicMock(), referred, _make_plan(), "monthly", discount_bps=0)

    assert called["resolve"] is False
    assert called["disc"] is False
    sent = rzp.subscription.create.call_args.kwargs["data"]
    assert sent["plan_id"] == "plan_starter_inr_monthly"
    assert result["billing_plan_id"] == "plan_starter_inr_monthly"


# ── Webhook dispatcher ────────────────────────────────────────────────────────


def test_webhook_dispatcher_routes_known_events_to_handlers():
    """Every supported event name routes into the right handler.

    We patch the handlers to no-ops so we're testing the routing table alone.
    """
    from app.services import razorpay_service

    routed: list[str] = []

    def _capture(name):
        # ``**_kwargs`` because the dispatcher hands ``event_id`` to the
        # activation handler specifically, it is the only one that can refuse an
        # already-charged event without persisting anything, and it needs the key
        # to release it (``_release_idempotency_key``). Routing is what's under
        # test here, so the fakes accept whatever the dispatcher passes.
        def _handler(_session, _payload, **_kwargs):
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


def _topup_capture_payload(*, amount: int, notes: dict) -> dict:
    return {
        "payment": {
            "entity": {
                "id": "pay_topup_tax",
                "order_id": "order_topup_tax",
                "amount": amount,
                "currency": "INR",
                "notes": {"purpose": "topup", "client_id": "9", "credits": "2000", **notes},
            }
        }
    }


def test_payment_captured_reconciles_against_the_charged_amount_not_the_base():
    """Regression: the capture guard must compare against what was CHARGED.

    Prices are published exclusive of GST, so a domestic top-up captures
    base + tax while ``amount_inr`` stays the base. Comparing the capture to
    ``amount_inr × 100`` rejected every real top-up: the customer was debited,
    the credits were never granted, and the webhook retry-looped until Razorpay
    gave up. ``charge_paise`` is stamped at order creation for exactly this.
    """
    from app.services import razorpay_service

    payload = _topup_capture_payload(
        amount=188682,  # ₹1,599 base + 18% GST
        notes={"amount_inr": "1599", "charge_paise": "188682"},
    )
    session = MagicMock()
    session.execute.return_value.scalars.return_value.first.return_value = None

    with patch("app.services.credit_service.grant_topup") as grant:
        razorpay_service._handle_payment_captured(session, payload)

    grant.assert_called_once()
    assert grant.call_args[0][2] == 2000


def test_payment_captured_still_refuses_a_genuine_amount_mismatch():
    """The anti-tamper guard must survive the fix, not be loosened by it."""
    from app.services import razorpay_service

    payload = _topup_capture_payload(
        amount=100000,  # not what the order was created for
        notes={"amount_inr": "1599", "charge_paise": "188682"},
    )
    session = MagicMock()
    session.execute.return_value.scalars.return_value.first.return_value = None

    with (
        patch("app.services.credit_service.grant_topup") as grant,
        pytest.raises(razorpay_service.RazorpayBillingError, match="mismatch"),
    ):
        razorpay_service._handle_payment_captured(session, payload)
    grant.assert_not_called()


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
    # The description names the SUPPLY, not the marketing SKU, no price in
    # the label at all (see the invoice-presentation review).
    assert "Credits top-up - 2,000 credits" in kwargs.get("note", "")


def test_payment_captured_topup_never_puts_a_display_price_on_the_document():
    """``notes.display_price`` must NOT reach the invoice description.

    This previously rendered "Credits top-up ($249 pack" on an INR tax invoice
    charging ₹19,999) a figure that is neither the taxable value, nor the
    total, nor the currency of supply. On a Rule 46 document that invites
    exactly one question in an audit or a customer dispute: what was supplied,
    and for how much? The amount column already carries the price, so the
    credit quantity is the whole description.

    Reversal of a deliberate earlier choice; the display price stays in the
    checkout UI where it belongs, not on the statutory document."""
    from app.services import razorpay_service

    payload = {
        "payment": {
            "entity": {
                "id": "pay_test002",
                "order_id": "order_test002",
                "amount": 1999900,
                "currency": "INR",
                "notes": {
                    "purpose": "topup",
                    "client_id": "9",
                    "credits": "32500",
                    "amount_inr": "19999",
                    "display_price": "$249",
                },
            }
        }
    }
    session = MagicMock()
    session.execute.return_value.scalars.return_value.first.return_value = None

    with patch("app.services.credit_service.grant_topup") as grant:
        razorpay_service._handle_payment_captured(session, payload)

    grant.assert_called_once()
    _, kwargs = grant.call_args
    # The ledger note appends the Razorpay reference for reconciliation;
    # what matters is that no display price appears in either string.
    note = kwargs.get("note", "")
    assert note.startswith("Credits top-up - 32,500 credits")
    assert "$" not in note and "249" not in note
    invoice = session.add.call_args[0][0]
    assert invoice.description == "Credits top-up - 32,500 credits"
    assert "$" not in invoice.description
    assert invoice.amount_cents == 1999900  # legal value stays INR paise


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
    sha256).hexdigest()``). This test
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


# ── Add-on checkout sheets quote what is DEBITED ────────────────────────────


def _client_in(country: str = "IN"):
    return SimpleNamespace(id=77, name="Acme Pvt Ltd", email="ops@acme.example", billing_country=country)


def test_charged_price_display_leads_with_the_gross_and_names_the_split():
    from app.services import razorpay_service as rs

    # ₹499 base + 18% GST = ₹588.82 debited.
    out = rs.charged_price_display(_client_in(), 49900, 1800)
    assert "588.82" in out
    assert "499" in out and "GST" in out


def test_charged_price_display_symbol_can_be_pinned_to_the_amount_s_rail():
    """Regression: an INR amount must never be rendered with a dollar sign.

    The dunning and pre-charge emails read the plan's INR columns for every
    customer, so deriving the symbol from the buyer's country printed
    "the $1,799 charge failed" to a foreign customer. The override fixes the
    symbol without changing the tax treatment: an export is still untaxed.
    """
    from app.services import razorpay_service as rs

    out = rs.charged_price_display(_client_in("US"), 179900, 1800, currency="INR")
    assert out.startswith("₹")
    assert "$" not in out
    assert "GST" not in out  # still an export, still untaxed


def test_charged_price_display_leaves_an_export_bare():
    """No Indian GST on an export, and no misleading parenthetical either."""
    from app.services import razorpay_service as rs

    out = rs.charged_price_display(_client_in("US"), 500, 1800)
    assert "GST" not in out


def test_seat_checkout_sheet_quotes_the_gross_not_the_base():
    """The sheet is one click from the Razorpay modal, so its number has to be
    the number Razorpay is about to show. It quoted the ex-GST base."""
    from app.services import razorpay_service as rs

    payload = rs._seat_checkout_payload("sub_seat", _client_in(), 2, rate_bps=1800)
    assert "588.82" in payload["description"], payload["description"]


def test_branding_checkout_sheet_quotes_the_gross_not_the_base():
    from app.services import razorpay_service as rs

    # ₹499 base + 18% GST = ₹588.82 debited.
    payload = rs._branding_checkout_payload("sub_brand", _client_in(), rate_bps=1800)
    assert "588.82" in payload["description"], payload["description"]
