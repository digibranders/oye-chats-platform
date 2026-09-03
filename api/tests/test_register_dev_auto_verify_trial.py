"""Audit A9: a ``DEV_AUTO_VERIFY_EMAIL`` signup must get its trial.

Registration grants the default plan inline for an account that arrives already
verified, because such accounts never call ``/verify-email``. The auto-verify
flag was applied to ``is_verified`` *after* that check ran, so every local
auto-verified signup ended up verified with no subscription and no credits —
a dev-only account that could not chat at all.

Real-Postgres tests via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest

from app.db.models import Client, Plan, Subscription
from app.services import credit_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _session_ctx(session):
    yield session


def _seed_plans(db):
    for slug, default, trial_days, credits in (("free", False, 0, 100), ("trial", True, 14, 500)):
        db.add(
            Plan(
                slug=slug,
                name=slug.title(),
                credits_per_month=credits,
                monthly_price_cents=0,
                annual_price_cents=0,
                trial_days=trial_days,
                is_default=default,
                is_active=True,
                is_public=not default,
                sort_order=1,
                limits={"bots": 1, "credits": credits, "operators": 1},
                features={"topup_allowed": False},
            )
        )
    db.flush()
    db.commit()


def _request():
    """A real Request: ``@limiter.limit`` rejects anything else."""
    from starlette.requests import Request

    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/auth/register",
            "headers": [],
            "query_string": b"",
            "client": ("127.0.0.1", 1234),
        }
    )


def _register(db, email: str, *, auto_verify: bool):
    from app.api import auth_routes

    with (
        patch.object(auth_routes, "get_session", lambda: _session_ctx(db)),
        patch("app.config.DEV_AUTO_VERIFY_EMAIL", auto_verify),
        patch("app.services.email_service.send_verification_otp_email"),
        patch("app.services.email_service.send_trial_welcome_email"),
    ):
        return auth_routes.register(
            request=_request(),
            body=auth_routes.RegisterRequest(name="Dev User", email=email, password="Str0ng-Passw0rd!"),
        )


def test_auto_verified_signup_gets_its_trial(db):
    _seed_plans(db)

    _register(db, "autoverify@example.com", auto_verify=True)

    client = db.query(Client).filter_by(email="autoverify@example.com").one()
    assert client.is_verified is True
    assert db.query(Subscription).filter_by(client_id=client.id).one().status == "trialing"
    assert credit_service.get_balance(db, client.id) == 500


def test_normal_signup_still_defers_the_trial_to_verification(db):
    _seed_plans(db)

    _register(db, "normal@example.com", auto_verify=False)

    client = db.query(Client).filter_by(email="normal@example.com").one()
    assert client.is_verified is False
    # The grant belongs to /verify-email; nothing is funded before the code
    # comes back.
    assert db.query(Subscription).filter_by(client_id=client.id).count() == 0
    assert credit_service.get_balance(db, client.id) == 0
