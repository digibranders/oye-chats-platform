"""Branding removal is a paid ADD-ON, never a plan inclusion.

Before this change ``features.branding_removable`` was seeded true on Standard,
Professional and Enterprise, so the entitlement came free with the plan price.
It is now sold on its own Razorpay mandate (like operator seats), and these
tests pin the three properties that make that safe:

1. Only an AUTHORIZED mandate grants it. A plan row claiming the feature, or a
   purchase the customer opened and abandoned, must grant nothing.
2. Every teardown path drops it. A cancelled or downgraded subscription must
   not keep a paid feature running.
3. The write boundary holds. ``PATCH /bots/{id}`` must refuse to store a
   branding change the caller has not paid for, rather than storing it and
   relying on the read path to sanitise it.
"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from unittest.mock import MagicMock, patch

import pytest

from app.db.models import Bot, Client, Plan, Subscription
from app.services import plan_entitlements_service, razorpay_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture(autouse=True)
def _branding_plan_configured():
    """Branding billing is env-only with no baked-in default. Configure it so the
    create path runs instead of raising ``RazorpayBillingError``."""
    with patch.object(razorpay_service, "RAZORPAY_BRANDING_PLAN_ID", "plan_test_branding"):
        yield


def _fixture(db, email: str, *, slug: str = "standard", addon_active: bool = False):
    client = Client(name="B", email=email, hashed_password="x", api_key=f"k-{email}")
    db.add(client)
    db.flush()
    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=119900,
        currency="INR",
        credits_per_month=1000,
        # Deliberately claims the feature. The resolver must ignore it: the
        # plan JSONB is not an input to this entitlement any more.
        features={"branding_removable": True},
        is_active=True,
    )
    db.add(plan)
    db.flush()
    bot = Bot(client_id=client.id, name="b", bot_key=f"bot-{email}", is_active=True)
    db.add(bot)
    sub = Subscription(
        client_id=client.id,
        plan_id=plan.id,
        status="active",
        razorpay_subscription_id=f"main_{email}",
        branding_addon_active=addon_active,
        current_period_start=datetime(2026, 1, 1, tzinfo=UTC),
        current_period_end=datetime(2026, 1, 31, tzinfo=UTC),
    )
    db.add(sub)
    db.flush()
    return client, plan, bot, sub


# ── 1. Only an authorized mandate grants the entitlement ────────────────────


def test_plan_features_cannot_grant_branding_removal(db):
    """The seeded/hand-edited plan flag is ignored. Only the add-on grants it."""
    client, _plan, _bot, _sub = _fixture(db, "brand-plan@test.local", addon_active=False)
    db.commit()

    ents = plan_entitlements_service.get_entitlements(client.id, db, use_cache=False)
    assert ents.has_feature("branding_removable") is False


def test_active_addon_grants_branding_removal(db):
    client, _plan, _bot, _sub = _fixture(db, "brand-addon@test.local", addon_active=True)
    db.commit()

    ents = plan_entitlements_service.get_entitlements(client.id, db, use_cache=False)
    assert ents.has_feature("branding_removable") is True


def test_free_plan_never_gets_branding_removal_even_with_a_stale_addon_flag(db):
    """A downgrade to Free must revoke it, even if the mandate flag survives.

    The add-on is sold on top of a paid plan. If a teardown path cleared the
    plan but not the flag, the resolver is the backstop that stops the customer
    keeping a paid feature on a free plan.
    """
    client, _plan, _bot, _sub = _fixture(db, "brand-free@test.local", slug="free", addon_active=True)
    db.commit()

    ents = plan_entitlements_service.get_entitlements(client.id, db, use_cache=False)
    assert ents.has_feature("branding_removable") is False


def test_opening_checkout_does_not_grant_the_entitlement(db):
    """The revenue leak this split exists to prevent: a mandate minted in
    ``created`` state charges nothing, so entitlement must wait for the webhook.
    A customer who opens checkout and dismisses it gets nothing."""
    _client, _plan, _bot, sub = _fixture(db, "brand-pending@test.local")
    rzp = MagicMock()
    rzp.subscription.create.return_value = {"id": "sub_brand"}

    with patch.object(razorpay_service, "_get_razorpay", return_value=rzp):
        checkout = razorpay_service.purchase_branding_addon(db, sub)

    assert checkout is not None and checkout["subscription_id"] == "sub_brand"
    assert sub.branding_addon_subscription_id == "sub_brand"
    assert sub.branding_addon_pending is True
    assert sub.branding_addon_active is False  # NOT entitled until the webhook


def test_repeat_purchase_reopens_the_same_mandate(db):
    """A dismissed checkout must not accumulate mandates. Re-opening returns the
    existing one rather than minting a second the sweep would have to cancel."""
    _client, _plan, _bot, sub = _fixture(db, "brand-repeat@test.local")
    rzp = MagicMock()
    rzp.subscription.create.return_value = {"id": "sub_brand_once"}

    with patch.object(razorpay_service, "_get_razorpay", return_value=rzp):
        razorpay_service.purchase_branding_addon(db, sub)
        again = razorpay_service.purchase_branding_addon(db, sub)

    assert rzp.subscription.create.call_count == 1
    assert again is not None and again["subscription_id"] == "sub_brand_once"


def test_activation_webhook_grants_the_entitlement(db):
    _client, _plan, _bot, sub = _fixture(db, "brand-activate@test.local")
    sub.branding_addon_subscription_id = "sub_brand_act"
    sub.branding_addon_pending = True
    db.commit()

    result = razorpay_service._handle_branding_addon_event(
        db,
        "subscription.activated",
        {"id": "sub_brand_act", "notes": {"purpose": "branding_addon"}},
        {},
    )

    assert "handled" in result
    db.refresh(sub)
    assert sub.branding_addon_active is True
    assert sub.branding_addon_pending is False


def test_cancelled_webhook_revokes_the_entitlement(db):
    _client, _plan, _bot, sub = _fixture(db, "brand-cancelled@test.local", addon_active=True)
    sub.branding_addon_subscription_id = "sub_brand_cancel"
    db.commit()

    razorpay_service._handle_branding_addon_event(
        db,
        "subscription.cancelled",
        {"id": "sub_brand_cancel", "notes": {"purpose": "branding_addon"}},
        {},
    )

    db.refresh(sub)
    assert sub.branding_addon_active is False
    assert sub.branding_addon_subscription_id is None


def test_halted_webhook_suspends_but_keeps_the_mandate_pointer(db):
    """Repeated payment failure suspends the feature. The pointer stays so a
    recovery charge can restore it, and so the mandate is not stranded as an
    orphan the sweep would have to find."""
    _client, _plan, _bot, sub = _fixture(db, "brand-halted@test.local", addon_active=True)
    sub.branding_addon_subscription_id = "sub_brand_halt"
    db.commit()

    razorpay_service._handle_branding_addon_event(
        db,
        "subscription.halted",
        {"id": "sub_brand_halt", "notes": {"purpose": "branding_addon"}},
        {},
    )

    db.refresh(sub)
    assert sub.branding_addon_active is False
    assert sub.branding_addon_subscription_id == "sub_brand_halt"


# ── 2. Teardown drops the entitlement ───────────────────────────────────────


def test_retire_cancels_the_mandate_and_revokes_the_entitlement(db):
    _client, _plan, _bot, sub = _fixture(db, "brand-retire@test.local", addon_active=True)
    sub.branding_addon_subscription_id = "sub_brand_retire"
    db.commit()

    rzp = MagicMock()
    with patch.object(razorpay_service, "_get_razorpay", return_value=rzp):
        ok = razorpay_service.retire_branding_addon_quietly(db, sub, context="test")

    assert ok is True
    rzp.subscription.cancel.assert_called_once()
    assert sub.branding_addon_active is False
    assert sub.branding_addon_subscription_id is None


def test_retire_failure_keeps_the_entitlement_and_does_not_raise(db):
    """A failed gateway cancel means the mandate is STILL CHARGING. Revoking the
    feature there would take away something the customer is still paying for,
    so the entitlement is deliberately left alone for the sweep to resolve."""
    _client, _plan, _bot, sub = _fixture(db, "brand-retire-fail@test.local", addon_active=True)
    sub.branding_addon_subscription_id = "sub_brand_stuck"
    db.commit()

    rzp = MagicMock()
    rzp.subscription.cancel.side_effect = RuntimeError("gateway 500")
    with patch.object(razorpay_service, "_get_razorpay", return_value=rzp):
        ok = razorpay_service.retire_branding_addon_quietly(db, sub, context="test")

    assert ok is False
    assert sub.branding_addon_active is True
    assert sub.branding_addon_subscription_id == "sub_brand_stuck"


# ── 3. Invoicing must not masquerade as a plan charge ───────────────────────


def test_branding_invoice_is_excluded_from_plan_charge_probes(db):
    """A ₹499 branding debit must never evidence a paid PLAN renewal.

    Without the exclusion, an add-on charge on the main subscription's id would
    satisfy the "was the plan paid?" probe and let an unpaid plan grant stand.
    """
    from app.db.models import ADDON_INVOICE_KINDS

    assert "branding" in ADDON_INVOICE_KINDS


# ── 4. The write boundary ───────────────────────────────────────────────────


def test_patch_rejects_hiding_the_badge_without_the_addon(db):
    from app.api import bot_routes as br

    bot = Bot(client_id=1, name="b", bot_key="bot-guard", branding_text=None, branding_url=None)
    offending = br._branding_fields_requiring_addon(bot, {"feature_flags": {"show_branding": False}})
    assert offending == ["feature_flags.show_branding"]


def test_patch_allows_turning_the_badge_back_on_without_the_addon(db):
    """Never trap a customer holding a setting they can no longer switch off."""
    from app.api import bot_routes as br

    bot = Bot(client_id=1, name="b", bot_key="bot-guard2")
    assert br._branding_fields_requiring_addon(bot, {"feature_flags": {"show_branding": True}}) == []


def test_patch_ignores_an_unchanged_branding_field(db):
    """The Experience page saves its whole draft. Resending the stock values
    unchanged is a no-op and must not 403 the entire save."""
    from app.api import bot_routes as br

    bot = Bot(client_id=1, name="b", bot_key="bot-guard3")
    update = {
        "branding_text": br.DEFAULT_BRANDING_TEXT,
        "branding_url": br.DEFAULT_BRANDING_URL,
    }
    assert br._branding_fields_requiring_addon(bot, update) == []


def test_patch_rejects_relabelling_the_badge_without_the_addon(db):
    from app.api import bot_routes as br

    bot = Bot(client_id=1, name="b", bot_key="bot-guard4")
    offending = br._branding_fields_requiring_addon(bot, {"branding_text": "Powered by Acme"})
    assert offending == ["branding_text"]
