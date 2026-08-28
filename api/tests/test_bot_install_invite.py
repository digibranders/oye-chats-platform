"""Emailing the install snippet to a developer.

``POST /bots/{bot_id}/install-invite`` replaces a ``mailto:`` link that could
never know whether anything was sent. The route sends the briefing itself and
stamps ``Bot.dev_invite_email`` / ``Bot.dev_invite_sent_at``, so the Deploy page
can still say who it went to after a reload.

Real-Postgres route tests via the shared ``db`` fixture; mirrors
tests/test_activation_events.py. Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.core.rate_limit import limiter
from app.db.models import ActivationEvent, Bot, Client

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="install-invite tests need a reachable Postgres at DB_URL",
)


@contextmanager
def _session_cm(session):
    yield session


def _make_client(db, *, email: str, api_key: str) -> Client:
    client = Client(name="Dev Inviter", email=email, api_key=api_key, hashed_password="h")
    db.add(client)
    db.flush()
    db.commit()
    return client


def _make_bot(db, client: Client, *, key: str = "bot-invite-1") -> Bot:
    bot = Bot(client_id=client.id, bot_key=key, name="Acme Assistant", system_prompt="")
    db.add(bot)
    db.flush()
    db.commit()
    return bot


class _Harness:
    """The route, wired to the test session with the email send captured."""

    def __init__(self, db, client: Client, *, entitled: bool = False):
        from app.api import auth, bot_routes

        self.sent: list[dict] = []
        self.db = db
        self.mod = bot_routes
        self.entitled = entitled

        app = FastAPI()
        app.state.limiter = limiter
        app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
        app.include_router(bot_routes.router)
        app.dependency_overrides[auth.get_current_client_or_operator] = lambda: {
            "type": "client",
            "entity": client,
            "client_id": client.id,
            "operator_id": None,
        }
        self.api = TestClient(app, raise_server_exceptions=False)

    def __enter__(self):
        def _capture(**kwargs):
            self.sent.append(kwargs)

        self._patches = [
            patch.object(self.mod, "get_session", lambda: _session_cm(self.db)),
            patch.object(self.mod, "send_install_invite_email", _capture),
            # Deny-by-default entitlement resolution needs a real subscription
            # otherwise; the snippet's attribution is what we are asserting on,
            # so the branding answer is stated directly.
            patch.object(self.mod, "_bot_has_branding_addon", lambda *a, **k: self.entitled),
        ]
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self._patches:
            p.stop()
        return False

    def post(self, bot_id: int, email: str):
        return self.api.post(f"/bots/{bot_id}/install-invite", json={"email": email})


def test_sends_the_briefing_and_stamps_the_bot(db):
    client = _make_client(db, email="owner@acme.com", api_key="inv-key-1")
    bot = _make_bot(db, client)

    with _Harness(db, client) as h:
        res = h.post(bot.id, "dev@acme.com")

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["email"] == "dev@acme.com"
    assert body["resent"] is False
    assert body["sent_at"]

    assert len(h.sent) == 1
    # A reply must reach the colleague who asked, not our support inbox: the
    # developer is a third party who never signed up with us.
    assert h.sent[0]["reply_to"] == "owner@acme.com"
    assert h.sent[0]["to_email"] == "dev@acme.com"
    assert bot.bot_key in h.sent[0]["snippet"]

    db.refresh(bot)
    assert bot.dev_invite_email == "dev@acme.com"
    assert bot.dev_invite_sent_at is not None


def test_a_repeat_to_the_same_address_reports_itself_as_one(db):
    client = _make_client(db, email="owner2@acme.com", api_key="inv-key-2")
    bot = _make_bot(db, client, key="bot-invite-2")

    with _Harness(db, client) as h:
        assert h.post(bot.id, "dev@acme.com").json()["resent"] is False
        second = h.post(bot.id, "dev@acme.com")

    assert second.status_code == 200, second.text
    assert second.json()["resent"] is True
    # Confirmed, never blocked: the customer asked for it twice.
    assert len(h.sent) == 2


def test_a_different_address_is_a_new_handoff_not_a_repeat(db):
    client = _make_client(db, email="owner3@acme.com", api_key="inv-key-3")
    bot = _make_bot(db, client, key="bot-invite-3")

    with _Harness(db, client) as h:
        h.post(bot.id, "dev@acme.com")
        second = h.post(bot.id, "bob@acme.com")

    assert second.json()["resent"] is False
    db.refresh(bot)
    assert bot.dev_invite_email == "bob@acme.com"


def test_a_bot_in_another_workspace_is_not_reachable(db):
    owner = _make_client(db, email="owner4@acme.com", api_key="inv-key-4")
    stranger = _make_client(db, email="stranger@evil.com", api_key="inv-key-5")
    bot = _make_bot(db, owner, key="bot-invite-4")

    with _Harness(db, stranger) as h:
        res = h.post(bot.id, "dev@evil.com")

    assert res.status_code == 404
    assert h.sent == []
    db.refresh(bot)
    assert bot.dev_invite_sent_at is None


def test_an_invalid_address_sends_nothing(db):
    client = _make_client(db, email="owner5@acme.com", api_key="inv-key-6")
    bot = _make_bot(db, client, key="bot-invite-5")

    with _Harness(db, client) as h:
        res = h.post(bot.id, "not-an-email")

    assert res.status_code == 422
    assert h.sent == []
    db.refresh(bot)
    assert bot.dev_invite_sent_at is None


def test_the_snippet_carries_attribution_unless_the_plan_removes_it(db):
    client = _make_client(db, email="owner6@acme.com", api_key="inv-key-7")
    bot = _make_bot(db, client, key="bot-invite-6")

    with _Harness(db, client, entitled=False) as h:
        h.post(bot.id, "dev@acme.com")
    assert "Powered by OyeChats" in h.sent[0]["snippet"]

    with _Harness(db, client, entitled=True) as h2:
        h2.post(bot.id, "dev@acme.com")
    assert "Powered by OyeChats" not in h2.sent[0]["snippet"]


def test_the_snippet_is_never_taken_from_the_caller(db):
    """A client cannot mail itself a white-label snippet it is not entitled to."""
    client = _make_client(db, email="owner7@acme.com", api_key="inv-key-8")
    bot = _make_bot(db, client, key="bot-invite-7")

    with _Harness(db, client, entitled=False) as h:
        res = h.api.post(
            f"/bots/{bot.id}/install-invite",
            json={"email": "dev@acme.com", "snippet": "<script>anything</script>"},
        )

    assert res.status_code == 200, res.text
    assert "anything" not in h.sent[0]["snippet"]
    assert "Powered by OyeChats" in h.sent[0]["snippet"]


def test_a_send_is_recorded_as_an_activation_milestone(db):
    from sqlalchemy import select

    client = _make_client(db, email="owner8@acme.com", api_key="inv-key-9")
    bot = _make_bot(db, client, key="bot-invite-8")

    with _Harness(db, client) as h:
        h.post(bot.id, "dev@acme.com")

    row = (
        db.execute(
            select(ActivationEvent).where(
                ActivationEvent.bot_id == bot.id,
                ActivationEvent.event_type == "install_invite_sent",
            )
        )
        .scalars()
        .first()
    )
    assert row is not None
    assert row.client_id == client.id
