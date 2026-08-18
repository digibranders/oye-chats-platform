"""Email-verification gate (B2). ``require_verified_email`` + workspace variant.

A freshly registered client starts un-verified (``is_verified=False``). B2 adds
two FastAPI dependencies that defer (never wall) the small set of sensitive
mutations that shouldn't run before the account proves ownership of its email:

* ``require_verified_email``. Strict (``X-API-Key`` only) variant, attached to
  the paid-subscription checkout mutation.
* ``require_verified_email_for_workspace``. Accepts client OR operator callers
  and gates on the *workspace owner's* verification, attached to invite-send.
  Mirrors the existing ``require_active_subscription`` / ``…_for_workspace`` pair.

Both raise a structured ``403 {"error": "email_verification_required", …}`` the
admin dashboard branches on to route the user into the verify-email step.

The pure-dependency unit tests need no database. The route-level integration
tests drive real routers against the shared ``db`` fixture (mirrors
tests/test_checkout_country_gate.py) and skip cleanly without ``DB_URL``.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.db.models import Client, Plan

_needs_db = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="verified-email route tests need a reachable Postgres at DB_URL",
)


@contextmanager
def _session_cm(session):
    yield session


# ── unit: require_verified_email (strict variant) ────────────────────────────


def test_require_verified_email_rejects_unverified_client():
    from app.api.auth import require_verified_email

    client = Client(name="c", email="unv@e.com", api_key="k", hashed_password="h", is_verified=False)

    with pytest.raises(HTTPException) as exc:
        require_verified_email(client=client)

    assert exc.value.status_code == 403
    assert exc.value.detail["error"] == "email_verification_required"
    assert exc.value.detail["verify_url"] == "/verify-email"


def test_require_verified_email_admits_verified_client():
    from app.api.auth import require_verified_email

    client = Client(name="c", email="ok@e.com", api_key="k", hashed_password="h", is_verified=True)

    assert require_verified_email(client=client) is client


def test_require_verified_email_bypasses_for_superadmin():
    """A superadmin provisioned outside the email-verify OAuth path keeps
    ``is_verified=False`` but must never be 403'd by the strict gate."""
    from app.api.auth import require_verified_email

    admin = Client(name="a", email="root@e.com", api_key="k", hashed_password="h", is_verified=False)
    admin.is_superadmin = True

    assert require_verified_email(client=admin) is admin


# ── unit: require_verified_email_for_workspace (client/operator variant) ──────


def test_workspace_gate_rejects_unverified_owner():
    from app.api.auth import require_verified_email_for_workspace

    owner = Client(name="o", email="o@e.com", api_key="k", hashed_password="h", is_verified=False)
    auth = {"type": "client", "entity": owner, "client_id": 1, "operator_id": None}

    with (
        patch("app.api.auth.get_session", lambda: _session_cm(_FakeSession(owner))),
        pytest.raises(HTTPException) as exc,
    ):
        require_verified_email_for_workspace(auth=auth)

    assert exc.value.status_code == 403
    assert exc.value.detail["error"] == "email_verification_required"


def test_workspace_gate_admits_verified_owner():
    from app.api.auth import require_verified_email_for_workspace

    owner = Client(name="o", email="o2@e.com", api_key="k", hashed_password="h", is_verified=True)
    auth = {"type": "client", "entity": owner, "client_id": 1, "operator_id": None}

    with patch("app.api.auth.get_session", lambda: _session_cm(_FakeSession(owner))):
        assert require_verified_email_for_workspace(auth=auth) is None


def test_workspace_gate_admits_superadmin_without_db():
    from app.api.auth import require_verified_email_for_workspace

    admin = Client(name="a", email="a@e.com", api_key="k", hashed_password="h", is_verified=False)
    admin.is_superadmin = True
    auth = {"type": "client", "entity": admin, "client_id": 1, "operator_id": None}

    # Superadmins bypass before any DB lookup. Patch get_session to explode if
    # it were consulted, proving the short-circuit.
    def _boom():
        raise AssertionError("superadmin must bypass before resolving the owner")

    with patch("app.api.auth.get_session", _boom):
        assert require_verified_email_for_workspace(auth=auth) is None


def test_workspace_gate_operator_denied_when_owner_unverified():
    from app.api.auth import require_verified_email_for_workspace

    owner = Client(name="o", email="o3@e.com", api_key="k", hashed_password="h", is_verified=False)
    # Operator caller carries no client entity; the gate resolves the owner by id.
    auth = {"type": "operator", "entity": object(), "client_id": 7, "operator_id": 3}

    with (
        patch("app.api.auth.get_session", lambda: _session_cm(_FakeSession(owner))),
        pytest.raises(HTTPException) as exc,
    ):
        require_verified_email_for_workspace(auth=auth)

    assert exc.value.detail["error"] == "email_verification_required"


class _FakeSession:
    """Minimal stand-in exposing ``.get(Client, id)`` for the workspace gate."""

    def __init__(self, client):
        self._client = client

    def get(self, model, ident):  # noqa: ARG002  Signature parity with Session.get
        return self._client


# ── integration: gated billing checkout route ───────────────────────────────


@_needs_db
def test_checkout_route_blocks_unverified_client(db):
    from app.api import auth, subscription_routes

    client = Client(name="c", email="gate-unverified@e.com", api_key="gate-unv", hashed_password="h", is_verified=False)
    db.add(client)
    db.flush()
    plan = Plan(
        name="Starter",
        slug="starter-verify-gate",
        monthly_price_cents=179900,
        annual_price_cents=1799000,
        monthly_price_usd_cents=179900,
        credits_per_month=1000,
        included_operator_seats=1,
        is_active=True,
        razorpay_plan_id_monthly="plan_verify_inr_m",
        razorpay_plan_id_annual="plan_verify_inr_a",
    )
    db.add(plan)
    db.flush()
    db.commit()

    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    api = TestClient(app, raise_server_exceptions=False)

    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.post(
            "/subscriptions/checkout",
            json={"plan_id": plan.id, "billing_cycle": "monthly", "billing_country": "IN"},
        )

    assert res.status_code == 403, res.text
    assert res.json()["detail"]["error"] == "email_verification_required"


# ── integration: gated invite-send route (workspace variant) ─────────────────


@_needs_db
def test_invite_send_route_blocks_unverified_owner(db):
    from app.api import auth, invite_routes

    owner = Client(name="o", email="invite-unverified@e.com", api_key="inv-unv", hashed_password="h", is_verified=False)
    db.add(owner)
    db.flush()
    db.commit()

    app = FastAPI()
    app.include_router(invite_routes.router)
    app.dependency_overrides[auth.get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": owner,
        "client_id": owner.id,
        "operator_id": None,
    }
    api = TestClient(app, raise_server_exceptions=False)

    with patch.object(auth, "get_session", lambda: _session_cm(db)):
        res = api.post("/invites", json={"email": "newbie@e.com", "role": "operator"})

    assert res.status_code == 403, res.text
    assert res.json()["detail"]["error"] == "email_verification_required"


@_needs_db
def test_invite_send_route_admits_verified_owner_past_the_gate(db):
    """A verified owner clears the gate. Proving the block is verification, not a
    blanket wall. We stop at the gate boundary by letting invite creation run;
    a verified owner must NOT get a 403 ``email_verification_required``."""
    from app.api import auth, invite_routes

    owner = Client(name="o", email="invite-verified@e.com", api_key="inv-ok", hashed_password="h", is_verified=True)
    db.add(owner)
    db.flush()
    db.commit()

    app = FastAPI()
    app.include_router(invite_routes.router)
    app.dependency_overrides[auth.get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": owner,
        "client_id": owner.id,
        "operator_id": None,
    }
    api = TestClient(app, raise_server_exceptions=False)

    with (
        patch.object(auth, "get_session", lambda: _session_cm(db)),
        patch.object(invite_routes, "get_session", lambda: _session_cm(db)),
        patch.object(invite_routes, "_dispatch_invite_email", lambda **k: None),
    ):
        res = api.post("/invites", json={"email": "newbie2@e.com", "role": "operator"})

    # The gate passed: whatever the downstream outcome, it is never the
    # verification 403.
    if res.status_code == 403:
        assert res.json()["detail"].get("error") != "email_verification_required", res.text


# ── integration: additional widened money/outbound mutations ─────────────────


@_needs_db
def test_change_plan_route_blocks_unverified_client(db):
    """Strict-variant gate on the trial→paid / upgrade mutation."""
    from app.api import auth, subscription_routes

    client = Client(name="c", email="cp-unverified@e.com", api_key="cp-unv", hashed_password="h", is_verified=False)
    db.add(client)
    db.flush()
    plan = Plan(
        name="Growth",
        slug="growth-verify-gate",
        monthly_price_cents=299900,
        annual_price_cents=2999000,
        monthly_price_usd_cents=299900,
        credits_per_month=5000,
        included_operator_seats=2,
        is_active=True,
        razorpay_plan_id_monthly="plan_cp_inr_m",
        razorpay_plan_id_annual="plan_cp_inr_a",
    )
    db.add(plan)
    db.flush()
    db.commit()

    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    api = TestClient(app, raise_server_exceptions=False)

    with patch.object(subscription_routes, "get_session", lambda: _session_cm(db)):
        res = api.post("/subscriptions/change-plan", json={"plan_id": plan.id})

    assert res.status_code == 403, res.text
    assert res.json()["detail"]["error"] == "email_verification_required"


@_needs_db
def test_bot_checkout_route_blocks_unverified_owner(db):
    """Workspace-variant gate on the new-paid-bot Razorpay checkout mutation."""
    from app.api import auth, bot_routes

    owner = Client(
        name="o", email="botco-unverified@e.com", api_key="botco-unv", hashed_password="h", is_verified=False
    )
    db.add(owner)
    db.flush()
    db.commit()

    app = FastAPI()
    app.include_router(bot_routes.router)
    app.dependency_overrides[auth.get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": owner,
        "client_id": owner.id,
        "operator_id": None,
    }
    api = TestClient(app, raise_server_exceptions=False)

    with patch.object(auth, "get_session", lambda: _session_cm(db)):
        res = api.post("/bots/checkout", json={"name": "New Bot", "plan_slug": "starter"})

    assert res.status_code == 403, res.text
    assert res.json()["detail"]["error"] == "email_verification_required"


@_needs_db
def test_resend_invite_route_blocks_unverified_owner(db):
    """Workspace-variant gate on the invite-resend (same outbound-email vector)."""
    from app.api import auth, invite_routes

    owner = Client(
        name="o", email="resend-unverified@e.com", api_key="resend-unv", hashed_password="h", is_verified=False
    )
    db.add(owner)
    db.flush()
    db.commit()

    app = FastAPI()
    app.include_router(invite_routes.router)
    app.dependency_overrides[auth.get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": owner,
        "client_id": owner.id,
        "operator_id": None,
    }
    api = TestClient(app, raise_server_exceptions=False)

    with patch.object(auth, "get_session", lambda: _session_cm(db)):
        res = api.post("/invites/1/resend")

    assert res.status_code == 403, res.text
    assert res.json()["detail"]["error"] == "email_verification_required"
