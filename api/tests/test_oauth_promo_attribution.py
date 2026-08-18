"""Promo/referral attribution must survive the Google OAuth round trip.

The campaign link lands on /register?code=…, but "Continue with Google" is a
full-page redirect through Google, and the callback used to create the account
knowing nothing about the code: a promo-link signup via Google silently lost
its promotion (found live in prod: client had an EMPTY signup_promo_code
minutes after registering through an active campaign link). The codes now ride
the SIGNED OAuth state token and the callback stamps them for accounts it
creates.
"""

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Client, Promotion
from app.services.oauth_service import GoogleProfile, issue_state_token, verify_state_token

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


# ── State token carries the codes ────────────────────────────────────────────


def test_state_token_round_trips_promo_and_referral():
    token = issue_state_token(next_path="/billing", mode="register", promo_code="FREEDOM79", referral_code="AFF1")
    payload = verify_state_token(token)
    assert payload["promo"] == "FREEDOM79"
    assert payload["ref"] == "AFF1"
    assert payload["next"] == "/billing"


def test_state_token_omits_absent_codes_and_bounds_size():
    payload = verify_state_token(issue_state_token(next_path="/", mode="register"))
    assert "promo" not in payload and "ref" not in payload

    long = verify_state_token(issue_state_token(promo_code="X" * 500))
    assert len(long["promo"]) == 64


# ── Callback attribution ─────────────────────────────────────────────────────


@contextmanager
def _ctx(session):
    yield session


def _profile(email="oauth-promo@test.example"):
    return GoogleProfile(subject="google-sub-promo-1", email=email, email_verified=True, name="G", picture=None)


def _callback_app(db, monkeypatch, *, client, is_new):
    from datetime import UTC, datetime, timedelta

    from app.api import oauth_routes

    monkeypatch.setattr(oauth_routes, "GOOGLE_OAUTH_ENABLED", True)
    monkeypatch.setattr(oauth_routes, "exchange_code_for_profile", lambda code: _profile())
    monkeypatch.setattr(oauth_routes, "_resolve_client_for_profile", lambda profile, country=None: (client, is_new))

    import app.db.session as db_session_module

    monkeypatch.setattr(db_session_module, "get_session", lambda: _ctx(db))

    db.add(
        Promotion(
            code="FREEDOM79",
            name="Launch",
            starts_at=datetime.now(UTC) - timedelta(hours=1),
            ends_at=datetime.now(UTC) + timedelta(hours=1),
            free_cycles=1,
        )
    )
    db.flush()

    app = FastAPI()
    app.include_router(oauth_routes.router)
    return TestClient(app, follow_redirects=False)


def _do_callback(api, state):
    from app.api.oauth_routes import STATE_COOKIE_NAME

    api.cookies.set(STATE_COOKIE_NAME, state)
    return api.get(f"/auth/google/callback?code=gcode&state={state}")


def test_new_google_account_gets_the_promo_stamped(db, monkeypatch):
    client = Client(name="G", email="oauth-promo@test.example", api_key="key-oauth-promo")
    db.add(client)
    db.flush()

    api = _callback_app(db, monkeypatch, client=client, is_new=True)
    state = issue_state_token(next_path="/", mode="register", promo_code="freedom79")  # case-insensitive
    res = _do_callback(api, state)

    assert res.status_code in (302, 307), res.text
    db.refresh(client)
    assert client.signup_promo_code == "FREEDOM79"  # canonical stored form


def test_existing_google_account_is_never_reattributed(db, monkeypatch):
    # First-touch only: signing IN through a campaign link must not stamp an
    # old account with a signup offer.
    client = Client(name="G2", email="oauth-promo@test.example", api_key="key-oauth-promo2")
    db.add(client)
    db.flush()

    api = _callback_app(db, monkeypatch, client=client, is_new=False)
    state = issue_state_token(next_path="/", mode="login", promo_code="FREEDOM79")
    res = _do_callback(api, state)

    assert res.status_code in (302, 307), res.text
    db.refresh(client)
    assert client.signup_promo_code is None


def test_attribution_failure_never_breaks_the_signin(db, monkeypatch):
    client = Client(name="G3", email="oauth-promo@test.example", api_key="key-oauth-promo3")
    db.add(client)
    db.flush()

    api = _callback_app(db, monkeypatch, client=client, is_new=True)

    import app.db.session as db_session_module

    def _boom():
        raise RuntimeError("db down")

    monkeypatch.setattr(db_session_module, "get_session", _boom)
    state = issue_state_token(next_path="/", mode="register", promo_code="FREEDOM79")
    res = _do_callback(api, state)
    # The sign-in still completes; only the attribution is lost (and logged).
    assert res.status_code in (302, 307), res.text
