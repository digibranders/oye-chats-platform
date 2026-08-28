"""Super-admin v2 record endpoints: sessions, leads, documents.

These three had no coverage at all, which is how ``GET /superadmin/leads``
shipped a join on a column ``LeadInfo`` does not have (a 500 on every call),
how ``GET /superadmin/sessions/{id}`` shipped an ``int`` path parameter for a
String primary key (a 422 on every real id), and how three literal fields
shipped in the documents payload. Every assertion here is on a value that
could only ever have been produced by reading the right column.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from app.api import superadmin_routes_v2
from app.api.auth import get_superadmin
from app.db.models import Bot, ChatSession, Client, Document, LeadInfo

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

# ``chat_sessions.id`` holds a UUID-shaped token in production. The whole point
# of item 1 is that this value must survive the path parameter.
UUID_ID = "3f2b1c8e-9a4d-4f6b-8c11-77d0e5a1b234"


@contextmanager
def _ctx(session):
    yield session


def _api(db, monkeypatch) -> TestClient:
    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(
        id=None, name="Admin", is_superadmin=True, superadmin_role="owner"
    )
    return TestClient(app)


def _account(db, slug: str) -> tuple[Client, Bot]:
    client = Client(name=f"Acct {slug}", email=f"{slug}@test.example", api_key=f"key-{slug}")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, bot_key=f"bot-{slug}", name=f"Bot {slug}")
    db.add(bot)
    db.flush()
    return client, bot


def _chunk(db, bot: Bot, *, name: str, file_hash: str, content: str, is_active: bool = True) -> Document:
    doc = Document(
        client_id=bot.client_id,
        bot_id=bot.id,
        document_name=name,
        source="upload",
        is_active=is_active,
        file_hash=file_hash,
        content=content,
        source_char_count=len(content),
        embedding=[0.0] * 768,
    )
    db.add(doc)
    db.flush()
    return doc


# ── 1. session detail path parameter ────────────────────────────────────────


def test_session_detail_accepts_a_uuid_shaped_id(db, monkeypatch):
    """The regression that mattered: a String primary key through the path."""
    client, bot = _account(db, "sess-ok")
    db.add(ChatSession(id=UUID_ID, client_id=client.id, bot_id=bot.id, status="closed"))
    db.flush()

    res = _api(db, monkeypatch).get(f"/superadmin/sessions/{UUID_ID}")

    assert res.status_code == 200, res.text
    assert res.json()["session"]["id"] == UUID_ID


def test_session_detail_404s_for_a_missing_id_rather_than_422(db, monkeypatch):
    """A well-formed id that simply does not exist must reach the handler.

    Asserting ``!= 422`` as well as ``== 404`` because a 422 here is exactly
    the old bug wearing a different id.
    """
    res = _api(db, monkeypatch).get("/superadmin/sessions/no-such-session-id")

    # Both halves, as the docstring promises. 404 alone would still pass if the
    # route regressed to some other refusal, and 422 is the specific regression
    # this test exists to catch, so it is named rather than merely excluded.
    assert res.status_code != 422, f"the path parameter rejected a UUID-shaped id again: {res.text}"
    assert res.status_code == 404, res.text


def test_session_detail_rejects_an_over_long_id(db, monkeypatch):
    """``SessionId`` is a bounded ``Identifier``, not a bare ``str``: a path
    segment reaching a primary-key lookup stays length-bounded."""
    res = _api(db, monkeypatch).get(f"/superadmin/sessions/{'a' * 200}")

    assert res.status_code == 422, res.text


# ── 2. leads ────────────────────────────────────────────────────────────────


def test_leads_resolves_the_client_through_the_bot(db, monkeypatch):
    client, bot = _account(db, "lead-1")
    db.add(ChatSession(id="sess-lead-1", client_id=client.id, bot_id=bot.id))
    db.flush()
    db.add(
        LeadInfo(
            session_id="sess-lead-1",
            bot_id=bot.id,
            name="Riya Sharma",
            email="riya@buyer.example",
            phone="+919000000000",
            company="buyer.example",
        )
    )
    db.flush()

    res = _api(db, monkeypatch).get("/superadmin/leads")

    assert res.status_code == 200, res.text
    (row,) = res.json()
    # ``client_id`` is the key the console types; the value comes from the bot.
    assert row["client_id"] == client.id
    assert row["bot_id"] == bot.id
    assert row["session_id"] == "sess-lead-1"
    assert row["name"] == "Riya Sharma"
    assert row["email"] == "riya@buyer.example"
    assert row["company"] == "buyer.example"


# ── 3. session summary: visitor identity + last activity ────────────────────


def test_session_summary_reads_the_visitor_from_lead_info(db, monkeypatch):
    client, bot = _account(db, "sess-lead")
    last_active = datetime(2026, 8, 1, 9, 30, tzinfo=UTC)
    db.add(
        ChatSession(
            id="sess-with-lead",
            client_id=client.id,
            bot_id=bot.id,
            status="closed",
            last_active_at=last_active,
        )
    )
    db.flush()
    db.add(LeadInfo(session_id="sess-with-lead", bot_id=bot.id, name="Arjun", email="arjun@buyer.example"))
    db.flush()

    res = _api(db, monkeypatch).get("/superadmin/sessions")

    assert res.status_code == 200, res.text
    (row,) = res.json()
    assert row["visitor_name"] == "Arjun"
    assert row["visitor_email"] == "arjun@buyer.example"
    # Wire key unchanged, column read is the real ``last_active_at``. Compared
    # as an INSTANT, not a string: psycopg2 returns timestamptz in the
    # connection's local zone, so the rendered offset follows the machine
    # (+00:00 on the UTC droplet, +05:30 on an IST laptop) while the instant is
    # identical. The offset-aware parse also keeps this failing loudly if the
    # API ever dropped the offset (naive vs aware comparison raises).
    assert datetime.fromisoformat(row["last_activity_at"]) == last_active


def test_session_summary_is_null_when_the_visitor_never_identified(db, monkeypatch):
    client, bot = _account(db, "sess-nolead")
    db.add(ChatSession(id="sess-no-lead", client_id=client.id, bot_id=bot.id))
    db.flush()

    res = _api(db, monkeypatch).get("/superadmin/sessions")

    assert res.status_code == 200, res.text
    (row,) = res.json()
    assert row["visitor_name"] is None
    assert row["visitor_email"] is None


def test_lead_info_is_one_to_one_per_session(db):
    """The outer join in the sessions list is only fan-out-free because
    ``lead_info.session_id`` is UNIQUE. Assert the constraint itself rather
    than trusting the model declaration."""
    _client, bot = _account(db, "lead-uniq")
    db.add(ChatSession(id="sess-uniq", client_id=bot.client_id, bot_id=bot.id))
    db.flush()
    db.add(LeadInfo(session_id="sess-uniq", bot_id=bot.id, name="First"))
    db.flush()
    db.add(LeadInfo(session_id="sess-uniq", bot_id=bot.id, name="Second"))

    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()


def test_session_detail_carries_the_visitor_identity_too(db, monkeypatch):
    client, bot = _account(db, "sess-detail")
    db.add(ChatSession(id=UUID_ID, client_id=client.id, bot_id=bot.id))
    db.flush()
    db.add(LeadInfo(session_id=UUID_ID, bot_id=bot.id, name="Meera", email="meera@buyer.example"))
    db.flush()

    res = _api(db, monkeypatch).get(f"/superadmin/sessions/{UUID_ID}")

    assert res.status_code == 200, res.text
    assert res.json()["session"]["visitor_name"] == "Meera"


# ── 4. documents ────────────────────────────────────────────────────────────


def test_documents_group_chunks_back_into_source_rows(db, monkeypatch):
    _client, bot = _account(db, "docs")
    for i in range(3):
        _chunk(db, bot, name="handbook.pdf", file_hash="hash-handbook", content=f"chunk {i} " + "x" * 100)
    _chunk(db, bot, name="pricing.txt", file_hash="hash-pricing", content="y" * 50, is_active=False)

    res = _api(db, monkeypatch).get("/superadmin/documents")

    assert res.status_code == 200, res.text
    rows = {r["id"]: r for r in res.json()}
    assert set(rows) == {"hash-handbook", "hash-pricing"}

    handbook = rows["hash-handbook"]
    assert handbook["title"] == "handbook.pdf"
    assert handbook["chunk_count"] == 3
    # 3 chunks of "chunk N " (8 chars) + 100 padding characters.
    assert handbook["content_chars"] == 3 * 108
    assert handbook["is_active"] is True
    assert handbook["bot_id"] == bot.id
    assert handbook["bot_name"] == bot.name
    assert handbook["client_id"] == bot.client_id
    assert handbook["source"] == "upload"

    pricing = rows["hash-pricing"]
    assert pricing["chunk_count"] == 1
    assert pricing["content_chars"] == 50
    # ``is_active`` is the deactivate-on-plan-lapse state, and it is real.
    assert pricing["is_active"] is False
