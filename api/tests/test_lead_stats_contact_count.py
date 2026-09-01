"""`total` counts conversations. The setup checklist read it as captured leads.

`GET /leads/stats` returns `total = count(ChatSession)`, and that is CORRECT for
the page it feeds: `/leads` lists every conversation, with contact details as
enrichment, so the list header and the sidebar badge want a conversation count.

The onboarding checklist then did `done: capturedLeads > 0` off that same
number, under a step labelled "Capture your first lead". So the step struck
itself through the moment anyone said hello — no name, no email, nothing
captured. The third false tick of the same kind: the product doing something and
congratulating the customer for it.

Fixing `total` would have broken the leads page. The endpoint gains a separate
`with_contact` instead, so each caller asks for the number it actually means.

Contact is `email OR phone`, not `name`. A visitor who types "I'm Sam" has told
you nothing you can follow up on, and the step exists to mark the moment the
chatbot produced something reachable.
"""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import lead_routes
from app.api.auth import get_current_client_or_operator
from app.db.models import Bot, ChatSession, Client, LeadInfo

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _setup(db, monkeypatch, *, sessions: list[dict]):
    client = Client(name="T", email="stats-contact@test.example", api_key="key-stats-contact")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, name="Support", bot_key="bot-stats-contact")
    db.add(bot)
    db.flush()
    for index, spec in enumerate(sessions):
        sid = f"s-{index}"
        db.add(ChatSession(id=sid, bot_id=bot.id, client_id=client.id, status="closed"))
        db.flush()
        if spec:
            db.add(LeadInfo(session_id=sid, bot_id=bot.id, **spec))
    db.flush()
    db.commit()

    monkeypatch.setattr(lead_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(lead_routes.router)
    # The route authenticates with `get_current_client_or_operator`, which
    # yields an auth DICT rather than a Client.
    app.dependency_overrides[get_current_client_or_operator] = lambda: {
        "client_id": client.id,
        "kind": "client",
        "entity": client,
    }
    return TestClient(app)


def test_a_conversation_with_no_contact_is_not_a_captured_lead(db, monkeypatch):
    # The exact case that ticked the step: somebody chatted and left nothing.
    tc = _setup(db, monkeypatch, sessions=[{}])
    body = tc.get("/leads/stats").json()
    assert body["total"] == 1, "the conversation still counts for the list header"
    assert body["with_contact"] == 0


def test_an_email_counts(db, monkeypatch):
    tc = _setup(db, monkeypatch, sessions=[{"email": "sam@acme.com"}])
    res = tc.get("/leads/stats")
    assert res.status_code == 200, res.text
    assert res.json()["with_contact"] == 1, res.json()


def test_a_phone_counts(db, monkeypatch):
    tc = _setup(db, monkeypatch, sessions=[{"phone": "+91 90000 00000"}])
    assert tc.get("/leads/stats").json()["with_contact"] == 1


def test_a_name_alone_does_not(db, monkeypatch):
    # "I'm Sam" is not something you can follow up on.
    tc = _setup(db, monkeypatch, sessions=[{"name": "Sam"}])
    assert tc.get("/leads/stats").json()["with_contact"] == 0


def test_an_empty_string_is_not_contact(db, monkeypatch):
    # The capture form can persist "" for a field the visitor skipped.
    tc = _setup(db, monkeypatch, sessions=[{"email": "", "phone": "   "}])
    assert tc.get("/leads/stats").json()["with_contact"] == 0


def test_it_counts_conversations_not_contact_rows(db, monkeypatch):
    tc = _setup(
        db,
        monkeypatch,
        sessions=[{}, {"email": "a@acme.com"}, {"phone": "+91 1"}, {"name": "Sam"}],
    )
    body = tc.get("/leads/stats").json()
    assert body["total"] == 4
    assert body["with_contact"] == 2
