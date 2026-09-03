"""``/subscriptions/resume`` must not throw away its own self-heal.

Mode 1 asks Razorpay whether the mandate is still live. When the gateway says it
is not, the route stamps ``gateway_cancel_executed_at`` so the cancellation
sweep stops chasing a dead mandate, then falls through to re-authorisation. That
write was only ``flush``ed, and the ``reuse_pending_upgrade`` branch returns
without committing, so ``get_session`` (which rolls back on exit, never commits)
discarded it: the customer got the right checkout back and the row silently
stayed in the state the self-heal had just corrected, on every retry.

The sibling branch in ``/change-plan`` commits on exactly this shape. These
tests drive the route with a MagicMock session and assert on ``.commit()``,
because the property under test is that the unit of work is committed at all,
which is invisible to a real session that some later assertion commits anyway.
"""

from __future__ import annotations

from contextlib import contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.api import subscription_routes


@contextmanager
def _session_cm(session):
    yield session


def _sub() -> SimpleNamespace:
    """A subscription cancelled locally whose mandate is dead at the gateway."""
    plan = SimpleNamespace(id=3, slug="standard", name="Standard", currency="INR")
    return SimpleNamespace(
        id=11,
        client_id=1,
        bot_id=None,
        plan=plan,
        billing_cycle="monthly",
        cancel_at_period_end=True,
        canceled_at=datetime(2026, 1, 5, tzinfo=UTC),
        cancel_reason="too expensive",
        gateway_cancel_executed_at=None,
        razorpay_subscription_id="sub_dead",
        current_period_end=datetime(2026, 2, 28, tzinfo=UTC),
        upgrade_credit_pending_cents=None,
    )


def _drive_resume(session: MagicMock, sub: SimpleNamespace) -> dict:
    client = SimpleNamespace(id=1, email="resume@e.com", billing_country="IN")
    reused_checkout = {"subscription_id": "sub_pending", "provider": "razorpay"}

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(session)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *_a, **_k: None),
        patch.object(subscription_routes, "_resolve_target_subscription", lambda *_a, **_k: sub),
        patch.object(subscription_routes, "_require_precharge_gates", lambda *_a, **_k: "IN"),
        patch("app.services.razorpay_service.is_subscription_live", return_value=False),
        patch(
            "app.services.pending_checkout_service.reuse_pending_upgrade",
            return_value=reused_checkout,
        ),
    ):
        return subscription_routes.resume_subscription(
            http_request=MagicMock(),
            request=subscription_routes.ResumeSubscriptionRequest(),
            client=client,
        )


def test_reusing_a_pending_mandate_commits_the_gateway_cancel_self_heal():
    session = MagicMock()
    sub = _sub()

    response = _drive_resume(session, sub)

    assert response["status"] == "reauthorise_required"
    assert sub.gateway_cancel_executed_at is not None
    assert session.commit.called, "the self-heal is rolled back unless this branch commits"


def test_the_reused_checkout_is_still_returned_to_the_caller():
    session = MagicMock()

    response = _drive_resume(session, _sub())

    assert response["checkout"] == {"subscription_id": "sub_pending", "provider": "razorpay"}
    assert response["mandate_action"] == "reauthorise_required"


def test_mode_1_still_commits_when_the_mandate_is_live():
    """Guard the branch that already committed, the fix must not move it."""
    session = MagicMock()
    sub = _sub()
    client = SimpleNamespace(id=1, email="resume-live@e.com", billing_country="IN")

    with (
        patch.object(subscription_routes, "get_session", lambda: _session_cm(session)),
        patch.object(subscription_routes, "lock_client_for_billing", lambda *_a, **_k: None),
        patch.object(subscription_routes, "_resolve_target_subscription", lambda *_a, **_k: sub),
        patch("app.services.razorpay_service.is_subscription_live", return_value=True),
    ):
        response = subscription_routes.resume_subscription(
            http_request=MagicMock(),
            request=subscription_routes.ResumeSubscriptionRequest(),
            client=client,
        )

    assert response["status"] == "resumed"
    assert sub.cancel_at_period_end is False
    assert session.commit.called
