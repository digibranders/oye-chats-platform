"""End-to-end (real Postgres) coverage for the crawl auto-fill lock.

Exercises the whole wiring the unit tests in ``test_bot_manual_field_overrides``
can't reach: the real ``PATCH /bots/{id}`` endpoint persisting lock state to a
live DB, and the real crawl write-back helper honoring that state on re-crawl.

The full customer sequence is driven against a throwaway Postgres DB (``db``
fixture): crawl auto-fill → manual edit locks → re-crawl preserves → clear
unlocks → re-crawl re-fills.

Skips cleanly when no ``DB_URL`` is reachable.
"""

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import bot_routes
from app.api.auth import (
    get_current_client_or_operator,
    require_active_subscription_for_workspace,
)
from app.db.models import Bot, Client
from app.services.crawl_orchestrator import _apply_crawl_metadata_to_bot

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _session_ctx(session):
    yield session


def _seed_bot(db) -> tuple[int, int, str]:
    """Create a client + a fresh (never-crawled) bot; return (client_id, bot_id, bot_key)."""
    client = Client(name="E2E Co", email="e2e@example.com", hashed_password="x", api_key="e2e-key")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, bot_key="bot-e2e-companyinfo")
    db.add(bot)
    db.commit()
    return client.id, bot.id, bot.bot_key


def _patch_client(db, monkeypatch, client_id: int):
    """A TestClient whose PATCH /bots/{id} runs against the throwaway session."""
    monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(db))
    monkeypatch.setattr(bot_routes, "cache_delete", lambda *a, **k: None)
    app = FastAPI()
    app.include_router(bot_routes.router)  # router already carries prefix="/bots"
    app.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": Client(id=client_id),
        "client_id": client_id,
        "operator_id": None,
    }
    app.dependency_overrides[require_active_subscription_for_workspace] = lambda: None
    return TestClient(app)


def _crawl(db, bot_id: int, *, name: str, description: str, tone: str):
    """Simulate a crawl write-back over the real Bot row via the extracted helper."""
    bot = db.get(Bot, bot_id)
    written = _apply_crawl_metadata_to_bot(
        bot,
        recommended_colors=None,
        brand_tone=tone,
        company_context={"name": name, "description": description},
        services_url_suggestion=None,
    )
    db.commit()
    return written


def test_full_company_info_lifecycle(db, monkeypatch):
    client_id, bot_id, _ = _seed_bot(db)
    tc = _patch_client(db, monkeypatch, client_id)

    # 1) First crawl fills all three (field unlocked) ------------------------
    _crawl(db, bot_id, name="Acme Inc", description="Acme builds widgets.", tone="Friendly and clear.")
    bot = db.get(Bot, bot_id)
    assert bot.company_name == "Acme Inc"
    assert bot.company_description == "Acme builds widgets."
    assert bot.brand_tone == "Friendly and clear."
    assert bot.manual_field_overrides == []  # auto, nothing locked

    # 2) User manually edits company_name via the real PATCH endpoint -> lock -
    resp = tc.patch(
        f"/bots/{bot_id}",
        json={
            "company_name": "Acme Corporation",
            "company_description": "Acme builds widgets.",
            "brand_tone": "Friendly and clear.",
        },
    )
    assert resp.status_code == 200
    db.expire_all()
    bot = db.get(Bot, bot_id)
    assert bot.company_name == "Acme Corporation"
    assert bot.manual_field_overrides == ["company_name"]  # only the changed field locks

    # 3) Re-crawl: locked company_name preserved, others refreshed -----------
    _crawl(db, bot_id, name="Acme Inc", description="Acme builds gadgets now.", tone="Bold and punchy.")
    db.expire_all()
    bot = db.get(Bot, bot_id)
    assert bot.company_name == "Acme Corporation"  # LOCKED — untouched
    assert bot.company_description == "Acme builds gadgets now."  # unlocked — refreshed
    assert bot.brand_tone == "Bold and punchy."  # unlocked — refreshed

    # 4) User clears company_name and saves -> unlock ------------------------
    resp = tc.patch(f"/bots/{bot_id}", json={"company_name": None})
    assert resp.status_code == 200
    db.expire_all()
    bot = db.get(Bot, bot_id)
    assert (bot.company_name or "") == ""
    assert bot.manual_field_overrides == []  # unlocked again

    # 5) Re-crawl: previously-cleared company_name gets re-filled ------------
    _crawl(db, bot_id, name="Acme Inc", description="Acme builds gadgets now.", tone="Bold and punchy.")
    db.expire_all()
    bot = db.get(Bot, bot_id)
    assert bot.company_name == "Acme Inc"  # auto-filled again, accurately


def test_unrelated_save_does_not_lock_auto_value(db, monkeypatch):
    """Saving an unrelated field resubmits the auto company_name verbatim; it
    must stay unlocked so future crawls keep refreshing it."""
    client_id, bot_id, _ = _seed_bot(db)
    tc = _patch_client(db, monkeypatch, client_id)
    _crawl(db, bot_id, name="Acme Inc", description="desc", tone="tone")

    resp = tc.patch(
        f"/bots/{bot_id}",
        json={"primary_color": "#000000", "company_name": "Acme Inc"},  # unchanged value
    )
    assert resp.status_code == 200
    db.expire_all()
    bot = db.get(Bot, bot_id)
    assert bot.manual_field_overrides == []  # NOT locked
    assert bot.primary_color == "#000000"
