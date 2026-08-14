"""Superadmin-provisioned clients verify their email like anyone else.

``POST /superadmin/clients`` creates a real paying customer, not platform staff
— the ``is_superadmin`` bypass in ``require_verified_email`` does not cover
them. It used to leave ``is_verified`` at its column default of False while
never sending an OTP, so once the front-end verification gate landed, such an
account would have been held on /verify-email with no code in its inbox.
"""

import os
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import superadmin_routes
from app.api.auth import get_superadmin
from app.db.models import Client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _client(db, monkeypatch) -> TestClient:
    monkeypatch.setattr(superadmin_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(id=999999, name="Admin", is_superadmin=True)
    return TestClient(app)


def _payload(email: str) -> dict:
    return {"name": "Provisioned Co", "email": email, "password": "s3cret-pass-phrase", "website": None}


def test_provisioned_client_gets_an_otp(db, monkeypatch):
    sent: list[tuple] = []
    monkeypatch.setattr(
        "app.services.email_service.send_verification_otp_email",
        lambda *args: sent.append(args),
    )
    # Force the production-shaped path: no dev auto-verify.
    monkeypatch.setattr(superadmin_routes, "get_session", lambda: _ctx(db))
    monkeypatch.setenv("DEV_AUTO_VERIFY_EMAIL", "0")

    c = _client(db, monkeypatch)
    res = c.post("/superadmin/clients", json=_payload("provisioned@test.example"))
    assert res.status_code == 200

    row = db.get(Client, res.json()["client_id"])
    assert row is not None
    # An OTP was persisted with an expiry, exactly as /auth/register does.
    assert row.email_otp is not None
    assert len(row.email_otp) == 6
    assert row.email_otp.isdigit()
    assert row.email_otp_expires_at is not None
    # ...and it was actually dispatched to the address being provisioned.
    assert len(sent) == 1
    assert sent[0][0] == "provisioned@test.example"
    assert sent[0][2] == row.email_otp


def test_client_survives_a_failing_email_send(db, monkeypatch):
    """A transient provider error must not roll back the created client."""

    def _boom(*_args):
        raise RuntimeError("brevo is down")

    monkeypatch.setattr("app.services.email_service.send_verification_otp_email", _boom)
    monkeypatch.setenv("DEV_AUTO_VERIFY_EMAIL", "0")

    c = _client(db, monkeypatch)
    res = c.post("/superadmin/clients", json=_payload("mail-fails@test.example"))

    assert res.status_code == 200
    row = db.get(Client, res.json()["client_id"])
    assert row is not None
    # The account exists and still holds a usable code; the recipient can pull a
    # fresh one from "Resend code" on /verify-email.
    assert row.email_otp is not None


def test_duplicate_email_still_rejected(db, monkeypatch):
    monkeypatch.setattr("app.services.email_service.send_verification_otp_email", lambda *args: None)
    c = _client(db, monkeypatch)

    first = c.post("/superadmin/clients", json=_payload("dupe@test.example"))
    assert first.status_code == 200

    second = c.post("/superadmin/clients", json=_payload("dupe@test.example"))
    assert second.status_code == 400
