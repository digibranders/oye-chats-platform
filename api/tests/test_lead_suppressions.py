"""``GET/POST /leads/suppressions`` — the authenticated view of the do-not-email list.

Mirrors ``tests/api/test_unsubscribe_routes.py`` (the public writer of the same
table) from the other side of the fence, with one extra concern that file does
not have: ``EmailSuppression`` carries no ``client_id``, only ``bot_id``, so
every read and write here has to be scoped through the caller's own bot ids or
it hands out other tenants' visitors' email addresses.

Builds a bare app around the leads router rather than importing ``app.main``:
``app.main`` runs ``create_all`` against a module-level engine at import time,
which cannot be collected in a throwaway-DB environment.
"""

import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.auth import get_current_client_or_operator
from app.api.lead_routes import router as leads_router
from app.db.models import Bot, Client, EmailSuppression

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture(autouse=True)
def _allow_leads_dashboard(monkeypatch):
    """The router-level plan gate is exercised in ``test_lead_routes`` /
    ``test_plan_entitlements_service``. Stub it so these tests are about
    tenant scoping, not billing."""
    from app.api import lead_routes

    monkeypatch.setattr(lead_routes, "is_leads_dashboard_enabled", lambda *_a, **_k: True)


def _auth(client_id: int) -> dict:
    return {
        "type": "client",
        "entity": None,
        "client_id": client_id,
        "operator_id": None,
    }


def _build_client(client_id: int) -> TestClient:
    app = FastAPI()
    app.include_router(leads_router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: _auth(client_id)
    return TestClient(app)


def _make_bot(db, suffix: str) -> Bot:
    client = Client(
        name=f"c-{suffix}",
        email=f"{suffix}@suppressions.test",
        api_key=f"key-{suffix}",
        hashed_password="h",
    )
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, bot_key=f"bot-{suffix}", name=f"Bot {suffix}", is_legacy_pooled=False)
    db.add(bot)
    db.flush()
    return bot


def _suppress(db, bot: Bot, email: str, reason: str = "unsubscribe") -> EmailSuppression:
    row = EmailSuppression(bot_id=bot.id, email=email, reason=reason)
    db.add(row)
    db.flush()
    return row


# ── GET /leads/suppressions ──────────────────────────────────────────────────


def test_list_returns_only_this_workspaces_rows(db):
    """The security-critical assertion: a suppression on another tenant's bot
    must never appear, even though the table has no ``client_id`` to filter on."""
    mine = _make_bot(db, "list-mine")
    theirs = _make_bot(db, "list-theirs")
    _suppress(db, mine, "visitor@mine.test")
    _suppress(db, theirs, "visitor@theirs.test")
    db.commit()

    body = _build_client(mine.client_id).get("/leads/suppressions").json()

    assert body["total"] == 1
    assert body["page"] == 1
    assert body["limit"] == 50
    assert [row["email"] for row in body["suppressions"]] == ["visitor@mine.test"]
    row = body["suppressions"][0]
    assert row["bot_id"] == mine.id
    assert row["bot_name"] == mine.name
    assert row["reason"] == "unsubscribe"
    assert row["created_at"] is not None
    assert set(row) == {"id", "bot_id", "bot_name", "email", "reason", "created_at"}


def test_list_rejects_a_bot_id_the_caller_does_not_own(db):
    mine = _make_bot(db, "filter-mine")
    theirs = _make_bot(db, "filter-theirs")
    _suppress(db, theirs, "visitor@theirs.test")
    db.commit()

    resp = _build_client(mine.client_id).get(f"/leads/suppressions?bot_id={theirs.id}")

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Bot not found or access denied."


def test_list_filters_by_owned_bot_id(db):
    bot_a = _make_bot(db, "two-a")
    bot_b = Bot(client_id=bot_a.client_id, bot_key="bot-two-b", name="Bot B", is_legacy_pooled=False)
    db.add(bot_b)
    db.flush()
    _suppress(db, bot_a, "a@example.test")
    _suppress(db, bot_b, "b@example.test")
    db.commit()

    tc = _build_client(bot_a.client_id)
    assert tc.get("/leads/suppressions").json()["total"] == 2

    scoped = tc.get(f"/leads/suppressions?bot_id={bot_b.id}").json()
    assert scoped["total"] == 1
    assert scoped["suppressions"][0]["email"] == "b@example.test"


def test_list_search_and_pagination(db):
    bot = _make_bot(db, "paging")
    for i in range(3):
        _suppress(db, bot, f"person{i}@example.test")
    _suppress(db, bot, "someone@other.test")
    db.commit()

    tc = _build_client(bot.client_id)

    searched = tc.get("/leads/suppressions?search=person").json()
    assert searched["total"] == 3
    assert all("person" in row["email"] for row in searched["suppressions"])

    page_1 = tc.get("/leads/suppressions?limit=2&page=1").json()
    page_2 = tc.get("/leads/suppressions?limit=2&page=2").json()
    assert page_1["total"] == page_2["total"] == 4
    assert len(page_1["suppressions"]) == 2
    assert len(page_2["suppressions"]) == 2
    ids = [row["id"] for row in page_1["suppressions"] + page_2["suppressions"]]
    assert len(set(ids)) == 4


def test_list_search_treats_wildcards_literally(db):
    bot = _make_bot(db, "wildcard")
    _suppress(db, bot, "real@example.test")
    db.commit()

    body = _build_client(bot.client_id).get("/leads/suppressions?search=%25").json()
    assert body["total"] == 0


def test_list_is_empty_for_a_workspace_with_no_bots(db):
    client = Client(name="botless", email="botless@suppressions.test", api_key="key-botless", hashed_password="h")
    db.add(client)
    db.commit()

    body = _build_client(client.id).get("/leads/suppressions").json()
    assert body == {"suppressions": [], "total": 0, "page": 1, "limit": 50}


# ── POST /leads/suppressions ─────────────────────────────────────────────────


def test_post_creates_a_suppression(db):
    bot = _make_bot(db, "post-create")
    db.commit()

    resp = _build_client(bot.client_id).post(
        "/leads/suppressions", json={"bot_id": bot.id, "email": "  Stop@Example.Test "}
    )

    assert resp.status_code == 201, resp.text
    payload = resp.json()
    assert payload["email"] == "stop@example.test"  # normalised, matching Gate 3's lookup
    assert payload["reason"] == "unsubscribe"
    assert payload["bot_id"] == bot.id

    with_db = db.execute(select(EmailSuppression).where(EmailSuppression.bot_id == bot.id)).scalars().all()
    assert len(with_db) == 1
    assert with_db[0].email == "stop@example.test"


def test_post_is_idempotent(db):
    bot = _make_bot(db, "post-idem")
    db.commit()
    tc = _build_client(bot.client_id)
    body = {"bot_id": bot.id, "email": "twice@example.test"}

    first = tc.post("/leads/suppressions", json=body)
    second = tc.post("/leads/suppressions", json=body)

    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["id"] == second.json()["id"]

    rows = db.execute(select(EmailSuppression).where(EmailSuppression.bot_id == bot.id)).scalars().all()
    assert len(rows) == 1


def test_post_for_a_foreign_bot_is_refused(db):
    mine = _make_bot(db, "post-mine")
    theirs = _make_bot(db, "post-theirs")
    db.commit()

    resp = _build_client(mine.client_id).post(
        "/leads/suppressions", json={"bot_id": theirs.id, "email": "victim@example.test"}
    )

    assert resp.status_code == 403
    assert resp.json()["detail"] == "Bot not found or access denied."
    assert db.execute(select(EmailSuppression)).scalars().all() == []


def test_post_is_scoped_per_bot_not_global(db):
    """Same invariant the public unsubscribe route holds: suppressing an
    address on one bot must not silence it for an unrelated bot."""
    bot_a = _make_bot(db, "scope-a")
    bot_b = _make_bot(db, "scope-b")
    db.commit()

    _build_client(bot_a.client_id).post(
        "/leads/suppressions", json={"bot_id": bot_a.id, "email": "shared@example.test"}
    )

    on_b = db.execute(
        select(EmailSuppression).where(
            EmailSuppression.bot_id == bot_b.id, EmailSuppression.email == "shared@example.test"
        )
    ).scalar_one_or_none()
    assert on_b is None


def test_post_rejects_an_unknown_reason(db):
    bot = _make_bot(db, "post-reason")
    db.commit()

    resp = _build_client(bot.client_id).post(
        "/leads/suppressions",
        json={"bot_id": bot.id, "email": "x@example.test", "reason": "because-i-said-so"},
    )
    assert resp.status_code == 422


def test_post_rejects_a_malformed_email(db):
    bot = _make_bot(db, "post-email")
    db.commit()

    resp = _build_client(bot.client_id).post("/leads/suppressions", json={"bot_id": bot.id, "email": "not-an-email"})
    assert resp.status_code == 422


def test_there_is_no_delete_route(db):
    """Deliberate: the model's docstring says a row is never removed by
    application code (consent-only basis under DPDP). Re-enabling mail to
    someone who unsubscribed is a product + legal decision, not a CRUD gap."""
    bot = _make_bot(db, "no-delete")
    row = _suppress(db, bot, "kept@example.test")
    db.commit()

    resp = _build_client(bot.client_id).delete(f"/leads/suppressions/{row.id}")
    assert resp.status_code in (404, 405)
    assert db.get(EmailSuppression, row.id) is not None
