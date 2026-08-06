"""Unit tests for the ``subscription.authenticated`` promo grant handler.

Verified live (§4): a deferred launch-promo subscription sits in
``authenticated`` and Razorpay does not fire ``subscription.activated`` until the
free period ends. So the handler must grant on ``authenticated`` — but ONLY for
promo subs, leaving the ordinary money-path untouched.
"""

from __future__ import annotations

from app.services import razorpay_service as rs


def _payload(notes: dict) -> dict:
    return {"subscription": {"entity": {"id": "sub_test", "notes": notes}}}


def test_non_promo_acks_without_granting(monkeypatch):
    calls: list[int] = []
    monkeypatch.setattr(rs, "_handle_subscription_activated", lambda s, p: calls.append(1))
    out = rs._handle_subscription_authenticated(None, _payload({"oyechats_client_id": "5"}))
    # An ordinary immediate-start sub is a benign no-op — the exact wording is
    # shared with the deferred-resume path ("ignored … awaiting activated").
    assert "ignored" in out
    assert calls == []  # ordinary subs are NOT granted here — activated handles them


def test_promo_delegates_to_activation(monkeypatch):
    monkeypatch.setattr(rs, "_handle_subscription_activated", lambda s, p: "granted-sentinel")
    out = rs._handle_subscription_authenticated(
        None,
        _payload({"oyechats_promotion_id": "7", "oyechats_client_id": "5", "oyechats_plan_id": "2"}),
    )
    assert out == "granted-sentinel"


def test_missing_entity_acks(monkeypatch):
    calls: list[int] = []
    monkeypatch.setattr(rs, "_handle_subscription_activated", lambda s, p: calls.append(1))
    out = rs._handle_subscription_authenticated(None, {})
    assert out == "subscription entity missing"
    assert calls == []


def test_authenticated_registered_in_dispatch():
    # The event must be wired so Razorpay's authenticated webhook reaches the
    # handler — a promo customer whose ``authenticated`` never dispatches gets
    # ZERO access for the whole free period. The dispatch dict is local to
    # ``handle_webhook_event``, so assert on its source rather than a live call
    # (which would need a DB + signed payload).
    import inspect

    src = inspect.getsource(rs.handle_webhook_event)
    assert '"subscription.authenticated": _handle_subscription_authenticated' in src
