"""The trial is granted when the email is verified, not when the form is submitted.

Registration used to do three things at once: create the client, open a trialing
subscription with its credits, and send "your 14-day free trial is live". All of
it fired before the six-digit code had been entered, so anyone who typed an
address they did not control got a funded workspace, and the real owner of that
address got a welcome email for an account they had never opened.

The verification step is the point at which we know the address belongs to the
person using it, so it is the point at which the workspace becomes real.

Two things this must not break:

* **A verified signup still gets its trial.** ``DEV_AUTO_VERIFY_EMAIL`` marks a
  local account verified during registration, and OAuth accounts arrive verified
  from the provider. Neither ever calls ``/verify-email``, so deferring the grant
  unconditionally would leave those accounts with no subscription at all.
* **Verifying twice grants once.** The credits are real money, so the grant is
  guarded on the subscription already existing rather than on the OTP being
  single-use.

Real-Postgres tests via the shared ``db`` fixture. Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
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


def _pending_client(db, email="pending@example.com", *, otp="123456"):
    """A client exactly as registration leaves one: unverified, holding an OTP."""
    c = Client(
        name="Pending",
        email=email,
        api_key=f"k-{email}",
        hashed_password="h",
        is_verified=False,
        email_otp=otp,
        email_otp_expires_at=datetime.now(UTC) + timedelta(minutes=15),
    )
    db.add(c)
    db.flush()
    db.commit()
    return c


def _request():
    """A real Request: `@limiter.limit` rejects anything else."""
    from starlette.requests import Request

    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/auth/verify-email",
            "headers": [],
            "client": ("127.0.0.1", 1234),
        }
    )


def _verify(db, email, otp):
    from app.api import auth_routes

    with patch.object(auth_routes, "get_session", lambda: _session_ctx(db)):
        return auth_routes.verify_email(
            request=_request(),
            body=auth_routes.VerifyEmailRequest(email=email, otp=otp),
        )


def test_an_unverified_account_holds_no_subscription_and_no_credits(db):
    _seed_plans(db)
    c = _pending_client(db)

    # Registration created the row and nothing else. Before this change it had
    # already opened a funded trial for an address nobody had proved they own.
    assert db.query(Subscription).filter_by(client_id=c.id).count() == 0
    assert credit_service.get_balance(db, c.id) == 0


def test_verifying_opens_the_trial_and_grants_its_credits(db):
    _seed_plans(db)
    c = _pending_client(db)

    with patch("app.services.email_service.send_trial_welcome_email") as mail:
        _verify(db, c.email, "123456")

    db.refresh(c)
    assert c.is_verified is True

    sub = db.query(Subscription).filter_by(client_id=c.id).one()
    assert sub.status == "trialing"
    assert (sub.trial_end - sub.trial_start).days == 14
    assert credit_service.get_balance(db, c.id) == 500
    assert mail.called, "the welcome email belongs with the grant, not with the form"


def test_the_welcome_email_waits_for_verification(db):
    _seed_plans(db)
    c = _pending_client(db, email="quiet@example.com")

    # Nothing was sent while the address was unproved. The real owner of a
    # mistyped address must not be told a trial of theirs is live.
    with patch("app.services.email_service.send_trial_welcome_email") as mail:
        assert db.query(Subscription).filter_by(client_id=c.id).count() == 0
        assert not mail.called


def test_verifying_a_second_time_does_not_grant_twice(db):
    _seed_plans(db)
    c = _pending_client(db, email="twice@example.com")

    with patch("app.services.email_service.send_trial_welcome_email"):
        _verify(db, c.email, "123456")
    balance_after_first = credit_service.get_balance(db, c.id)

    # Re-arm the OTP and verify again. The guard is the existing subscription,
    # not the single-use code, because the credits are real money.
    c.email_otp = "654321"
    c.email_otp_expires_at = datetime.now(UTC) + timedelta(minutes=15)
    db.commit()
    with patch("app.services.email_service.send_trial_welcome_email") as mail:
        _verify(db, c.email, "654321")

    assert db.query(Subscription).filter_by(client_id=c.id).count() == 1
    assert credit_service.get_balance(db, c.id) == balance_after_first
    assert not mail.called, "a second verification must not re-announce the trial"


def test_an_already_verified_signup_is_granted_without_the_otp_path(db):
    """`DEV_AUTO_VERIFY_EMAIL` and OAuth never call `/verify-email`.

    Deferring the grant unconditionally would leave both with no subscription,
    so registration still grants inline when the account arrives verified.
    """
    from app.api import auth_routes

    _seed_plans(db)
    c = Client(
        name="Verified",
        email="oauth@example.com",
        api_key="k-oauth",
        hashed_password="h",
        is_verified=True,
    )
    db.add(c)
    db.flush()
    db.commit()

    with patch("app.services.email_service.send_trial_welcome_email"):
        auth_routes.grant_default_plan_and_welcome(db, c)
    db.commit()

    assert db.query(Subscription).filter_by(client_id=c.id).one().status == "trialing"
    assert credit_service.get_balance(db, c.id) == 500
