"""A bot with no notification recipients still tells its workspace owner.

Production, 2026-09-11: Eventus (bot 5) has ``notification_email`` and
``notification_emails`` both NULL. A quotation accept sent both visitor emails
and nothing to the team, and offline messages logged "Offline
team-notification not dispatched". ``get_notification_recipients`` ended its
chain in ``[]``, so quotes, offline messages, handoff requests and qualified
leads were all dropped, and nothing told the team.

The chain now ends in the account email of the workspace that owns the bot. A
saved list still wins, and an ``email_on_*`` opt-out still suppresses: the
callers check those flags before they ask for recipients at all.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import contextmanager
from itertools import count
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import event
from sqlalchemy.orm.exc import DetachedInstanceError

from app.api import offline_message_routes
from app.core.rate_limit import limiter
from app.db.models import Bot, ChatSession, Client
from app.services import email_service
from app.services.email_service import get_notification_recipients, uses_owner_notification_fallback
from tests.test_bot_pause_and_widget_heartbeat import _db_app, _mk_bot, _mk_client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

OWNER = "owner@eventus.test"
MASKED_OWNER = "o***@eventus.test"
EVENT_TYPES = ("qualified_lead", "handoff_request", "offline_message", "quote")
_seq = count(1)


def _client(db, email: str = OWNER) -> Client:
    n = next(_seq)
    client = Client(name=f"Owner {n}", email=email, api_key=f"owner-fallback-{n}", hashed_password="h")
    db.add(client)
    db.commit()
    return client


def _bot(db, client: Client, **kwargs) -> Bot:
    n = next(_seq)
    bot = Bot(client_id=client.id, bot_key=f"bot-owner-fallback-{n}", name="Eventus Bot", **kwargs)
    db.add(bot)
    db.commit()
    return bot


def _stand_in(client_id: int | None) -> SimpleNamespace:
    """A bot that is not an ORM row, like one rebuilt from the bot cache."""
    return SimpleNamespace(id=5, client_id=client_id, notification_emails=None, notification_email=None)


# ── The resolver ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("event_type", EVENT_TYPES)
def test_a_bot_with_no_recipients_notifies_the_workspace_owner(db, event_type):
    bot = _bot(db, _client(db))

    assert get_notification_recipients(bot, event_type) == [OWNER]


@pytest.mark.parametrize(
    ("routing", "legacy"),
    [
        ({}, None),
        ({"default": [], "qualified_lead": [], "handoff_request": [], "offline_message": []}, ""),
        ({"default": ["  "]}, " , "),
    ],
    ids=["empty-object", "every-bucket-saved-empty", "blank-addresses"],
)
def test_empty_routing_is_unset_not_an_opt_out(db, routing, legacy):
    """The console saves every bucket as ``[]`` until someone fills one in."""
    bot = _bot(db, _client(db), notification_emails=routing, notification_email=legacy)

    assert get_notification_recipients(bot, "offline_message") == [OWNER]


@pytest.mark.parametrize(
    ("routing", "legacy", "expected"),
    [
        ({"offline_message": ["desk@eventus.test"]}, None, ["desk@eventus.test"]),
        ({"default": ["team@eventus.test"]}, None, ["team@eventus.test"]),
        (None, "a@eventus.test, b@eventus.test", ["a@eventus.test", "b@eventus.test"]),
    ],
    ids=["per-event-list", "default-list", "legacy-field"],
)
def test_a_saved_list_wins_over_the_owner(db, caplog, routing, legacy, expected):
    bot = _bot(db, _client(db), notification_emails=routing, notification_email=legacy)

    with caplog.at_level(logging.INFO, logger=email_service.logger.name):
        assert get_notification_recipients(bot, "offline_message") == expected

    assert "workspace owner" not in caplog.text


def test_only_the_events_without_a_list_fall_back(db):
    bot = _bot(db, _client(db), notification_emails={"offline_message": ["desk@eventus.test"]})

    assert get_notification_recipients(bot, "offline_message") == ["desk@eventus.test"]
    assert get_notification_recipients(bot, "qualified_lead") == [OWNER]
    assert get_notification_recipients(bot, "quote") == [OWNER]


def test_the_fallback_is_logged_at_info_with_the_address_masked(db, caplog):
    bot = _bot(db, _client(db))

    with caplog.at_level(logging.INFO, logger=email_service.logger.name):
        get_notification_recipients(bot, "quote")

    records = [r for r in caplog.records if "workspace owner" in r.getMessage()]
    assert len(records) == 1
    assert records[0].levelno == logging.INFO
    assert MASKED_OWNER in records[0].getMessage()
    assert "event=quote" in records[0].getMessage()
    assert OWNER not in caplog.text


def test_a_loaded_client_is_read_without_a_query(db):
    bot = _bot(db, _client(db))
    db.refresh(bot)
    assert bot.client.email == OWNER
    statements: list[str] = []

    def _record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", _record)
    try:
        recipients = get_notification_recipients(bot, "handoff_request")
    finally:
        event.remove(engine, "before_cursor_execute", _record)

    assert recipients == [OWNER]
    assert statements == []


def test_a_bot_bound_to_a_session_is_resolved_on_that_session(db, monkeypatch):
    """No second pooled connection while the caller already holds one."""
    bot = _bot(db, _client(db))

    def _no_second_session():
        raise AssertionError("an attached bot must be resolved on its own session")

    monkeypatch.setattr(email_service, "get_session", _no_second_session)

    assert get_notification_recipients(bot, "offline_message") == [OWNER]


def test_a_detached_bot_is_resolved_in_a_session_of_its_own(db):
    """``get_current_bot`` expunges the row it returns and the quotation routes
    hand that row on, where ``bot.client`` raises instead of loading."""
    bot = _bot(db, _client(db))
    db.refresh(bot)
    db.expunge(bot)
    with pytest.raises(DetachedInstanceError):
        _ = bot.client

    assert get_notification_recipients(bot, "quote") == [OWNER]


def test_a_cache_stand_in_is_resolved_by_its_account_id(db):
    client = _client(db)

    assert get_notification_recipients(_stand_in(client.id), "offline_message") == [OWNER]


@pytest.mark.parametrize("client_id", [None, 987_654_321], ids=["no-account-id", "account-row-gone"])
def test_a_bot_without_a_resolvable_account_has_no_recipients(db, client_id):
    assert get_notification_recipients(_stand_in(client_id), "offline_message") == []


def test_a_failed_owner_lookup_is_logged_and_never_raises(db, monkeypatch, caplog):
    def _broken_session():
        raise RuntimeError("connection pool exhausted")

    monkeypatch.setattr(email_service, "get_session", _broken_session)

    with caplog.at_level(logging.WARNING, logger=email_service.logger.name):
        assert get_notification_recipients(_stand_in(1), "offline_message") == []

    assert "owner lookup failed" in caplog.text


# ── The console signal ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("routing", "legacy", "expected"),
    [
        (None, None, True),
        ({"default": [], "offline_message": []}, "", True),
        # Quotes have no bucket of their own, so they still go to the owner.
        (
            {"qualified_lead": ["a@x.test"], "handoff_request": ["a@x.test"], "offline_message": ["a@x.test"]},
            None,
            True,
        ),
        ({"default": ["team@x.test"]}, None, False),
        (None, "team@x.test", False),
    ],
    ids=["nothing-saved", "saved-empty", "per-event-only", "default-list", "legacy-field"],
)
def test_the_signal_says_whether_any_mail_goes_to_the_owner(routing, legacy, expected):
    bot = SimpleNamespace(notification_emails=routing, notification_email=legacy)

    assert uses_owner_notification_fallback(bot) is expected


@pytest.fixture()
def _no_entitlements_cache(monkeypatch):
    from app.services import plan_entitlements_service

    monkeypatch.setattr(plan_entitlements_service, "get_redis", lambda: None)


class TestBothSerializersCarryTheSignal:
    """``BotResponse`` is built in ``_bot_to_response`` and again in ``list_bots``."""

    def _setup(self, db, monkeypatch, **bot_kwargs):
        client = _mk_client(db, "signal-owner@eventus.test")
        bot = _mk_bot(db, client, "bot-owner-signal", **bot_kwargs)
        db.flush()
        return bot, _db_app(db, monkeypatch, client.id)

    @pytest.mark.parametrize(
        ("bot_kwargs", "expected"),
        [({}, True), ({"notification_emails": {"default": ["team@eventus.test"]}}, False)],
        ids=["owner-fallback", "saved-default-list"],
    )
    def test_get_one_bot(self, db, monkeypatch, _no_entitlements_cache, bot_kwargs, expected):
        bot, tc = self._setup(db, monkeypatch, **bot_kwargs)

        response = tc.get(f"/bots/{bot.id}")

        assert response.status_code == 200
        assert response.json()["notifications_use_owner_fallback"] is expected

    @pytest.mark.parametrize(
        ("bot_kwargs", "expected"),
        [({}, True), ({"notification_email": "team@eventus.test"}, False)],
        ids=["owner-fallback", "saved-legacy-field"],
    )
    def test_list_bots(self, db, monkeypatch, _no_entitlements_cache, bot_kwargs, expected):
        _bot_row, tc = self._setup(db, monkeypatch, **bot_kwargs)

        response = tc.get("/bots")

        assert response.status_code == 200
        assert [row["notifications_use_owner_fallback"] for row in response.json()] == [expected]


# ── Callers: offline message ─────────────────────────────────────────────────


def _offline_client(db, monkeypatch) -> tuple[TestClient, list[str]]:
    @contextmanager
    def _session():
        yield db

    team: list[str] = []
    monkeypatch.setattr(offline_message_routes, "get_session", _session)
    monkeypatch.setattr(
        offline_message_routes.plan_entitlements_service, "is_live_chat_enabled_for_bot", lambda *a, **k: True
    )
    monkeypatch.setattr(
        offline_message_routes, "send_offline_message_email", lambda **kw: team.append(kw["notification_email"])
    )
    monkeypatch.setattr(
        offline_message_routes, "send_unavailable_callback_email", lambda **kw: team.append(kw["notification_email"])
    )
    monkeypatch.setattr(offline_message_routes, "send_visitor_confirmation_email", lambda **kw: None)

    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(offline_message_routes.router)
    return TestClient(app), team


@pytest.mark.parametrize(("email_on_offline", "expected"), [(True, [OWNER]), (False, [])], ids=["on", "opted-out"])
def test_an_offline_message_reaches_the_owner_unless_opted_out(db, monkeypatch, email_on_offline, expected):
    bot = _bot(db, _client(db), email_on_offline=email_on_offline)
    tc, team = _offline_client(db, monkeypatch)

    response = tc.post(
        "/offline-messages",
        json={
            "bot_key": bot.bot_key,
            "name": "Asha",
            "email": "asha@visitor.test",
            "message": "Please call me back about the enterprise plan.",
        },
    )

    assert response.status_code == 200, response.text
    assert team == expected


# ── Callers: handoff request (a waiting visitor's message) ───────────────────


@pytest.mark.parametrize(("email_on_handoff", "expected"), [(True, [OWNER]), (False, [])], ids=["on", "opted-out"])
def test_a_waiting_visitor_message_reaches_the_owner_unless_opted_out(db, monkeypatch, email_on_handoff, expected):
    from app.worker.tasks import task_send_visitor_message_email

    client = _client(db)
    bot = _bot(db, client, email_on_handoff=email_on_handoff)
    db.add(ChatSession(id=f"handoff-owner-{bot.id}", bot_id=bot.id, client_id=client.id, status="waiting"))
    db.commit()
    sent: list[str] = []
    monkeypatch.setattr(email_service, "send_handoff_request_email", lambda recipient, *a, **k: sent.append(recipient))

    asyncio.run(task_send_visitor_message_email({}, f"handoff-owner-{bot.id}", bot.id, "Is anyone there?"))

    assert sent == expected


# ── Callers: qualified lead ──────────────────────────────────────────────────

_BANT_CONFIG = {
    "framework": "bant",
    "budget": {"weight": 25, "options": [{"label": "big", "score": 10}]},
    "authority": {"weight": 25, "options": [{"label": "owner", "score": 10}]},
    "need": {"weight": 25, "options": [{"label": "urgent", "score": 10}]},
    "timeline": {"weight": 25, "options": [{"label": "now", "score": 10}]},
}


def _signal(dimension: str) -> dict:
    return {
        "dimension": dimension,
        "score": 10,
        "signal_text": f"visitor described {dimension}",
        "extracted_value": dimension.upper(),
        "confidence": 0.9,
    }


@pytest.mark.parametrize(("email_on_qualified", "expected"), [(True, [OWNER]), (False, [])], ids=["on", "opted-out"])
def test_a_qualified_lead_reaches_the_owner_unless_opted_out(db, monkeypatch, email_on_qualified, expected):
    from app.services import rag_service as rs
    from app.services import webhook_service

    client = _client(db)
    bot = _bot(db, client, email_on_qualified=email_on_qualified)
    session_id = f"lead-owner-{bot.id}"
    db.add(ChatSession(id=session_id, client_id=client.id, bot_id=bot.id, status="bot"))
    db.commit()

    @contextmanager
    def _session():
        yield db

    sent: list[str] = []
    monkeypatch.setattr(rs, "get_session", _session)
    monkeypatch.setattr(
        rs,
        "extract_qualification_signals",
        lambda *a, **k: [_signal(d) for d in ("budget", "authority", "need", "timeline")],
    )
    monkeypatch.setattr(rs, "send_qualified_lead_email", lambda recipient, *a, **k: sent.append(recipient))
    monkeypatch.setattr(webhook_service, "fire_webhook", lambda *a, **k: None)

    rs._background_bant_extraction(
        session_id,
        client.id,
        bot.id,
        "",
        "we need this now, I sign the cheques, budget is big",
        "Great, let's talk.",
        {},
        bot.id,
        _BANT_CONFIG,
        None,
    )

    assert db.get(ChatSession, session_id).bant_tier == "sql"
    assert sent == expected
