"""Brand-tone presets: catalog integrity, LLM helpers, and endpoints.

Pure-logic + mocked-LLM tests run anywhere; the endpoint tests need a reachable
Postgres (``DB_URL``) and skip cleanly otherwise.
"""

import os
from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.api import bot_routes
from app.api.auth import get_current_client_or_operator, require_active_subscription_for_workspace
from app.api.bot_routes import UpdateBotRequest
from app.core.rate_limit import limiter
from app.db.models import Bot, Client
from app.services import llm_service
from app.services.brand_tone import (
    BRAND_TONE_PRESETS,
    CUSTOM_PRESET,
    PRESET_KEYS,
    is_valid_preset_value,
    preset_text,
)

# ── Preset catalog integrity ─────────────────────────────────────────────────


def test_eight_presets_with_unique_keys():
    assert len(BRAND_TONE_PRESETS) == 8
    keys = [p["key"] for p in BRAND_TONE_PRESETS]
    assert len(set(keys)) == len(keys)
    assert set(keys) == set(PRESET_KEYS)


def test_every_preset_text_survives_prompt_truncation():
    """rag_service injects brand_tone[:300]; canonical texts must fit under it."""
    for p in BRAND_TONE_PRESETS:
        assert p["key"] and p["label"] and p["text"]
        assert len(p["text"]) <= 280, f"{p['key']} text is {len(p['text'])} chars"


def test_preset_text_lookup():
    assert preset_text("professional") == next(p["text"] for p in BRAND_TONE_PRESETS if p["key"] == "professional")
    assert preset_text("nope") is None
    assert preset_text(CUSTOM_PRESET) is None
    assert preset_text(None) is None


def test_is_valid_preset_value():
    assert is_valid_preset_value("bold")
    assert is_valid_preset_value(CUSTOM_PRESET)
    assert is_valid_preset_value(None)
    assert not is_valid_preset_value("bogus")


# ── UpdateBotRequest validator ───────────────────────────────────────────────


def test_update_request_accepts_valid_preset_values():
    assert UpdateBotRequest(brand_tone_preset="technical").brand_tone_preset == "technical"
    assert UpdateBotRequest(brand_tone_preset="custom").brand_tone_preset == "custom"
    assert UpdateBotRequest(brand_tone_preset=None).brand_tone_preset is None


def test_update_request_rejects_unknown_preset():
    with pytest.raises(ValueError, match="brand_tone_preset"):
        UpdateBotRequest(brand_tone_preset="ultra-mega-tone")


# ── LLM helpers (mocked litellm) ─────────────────────────────────────────────


def _mock_completion(content: str):
    resp = MagicMock()
    resp.choices = [MagicMock(message=MagicMock(content=content))]
    return resp


def test_classify_brand_tone_returns_known_key(monkeypatch):
    monkeypatch.setattr(llm_service.litellm, "completion", lambda **kw: _mock_completion("  Bold  "))
    assert llm_service.classify_brand_tone("some website content") == "bold"


def test_classify_brand_tone_rejects_off_menu(monkeypatch):
    monkeypatch.setattr(llm_service.litellm, "completion", lambda **kw: _mock_completion("banana"))
    assert llm_service.classify_brand_tone("some website content") is None


def test_classify_brand_tone_empty_input_short_circuits():
    assert llm_service.classify_brand_tone("   ") is None


def test_generate_tone_sample_returns_text(monkeypatch):
    monkeypatch.setattr(llm_service.litellm, "completion", lambda **kw: _mock_completion('"Sure. We help teams ship."'))
    out = llm_service.generate_tone_sample("Friendly and clear.", "What do you do?")
    assert out == "Sure. We help teams ship."  # surrounding quotes stripped


def test_generate_tone_sample_none_on_error(monkeypatch):
    def _boom(**kw):
        raise RuntimeError("llm down")

    monkeypatch.setattr(llm_service.litellm, "completion", _boom)
    assert llm_service.generate_tone_sample("Friendly.", "hi?") is None


def test_generate_tone_sample_empty_input():
    assert llm_service.generate_tone_sample("", "hi?") is None


# ── Endpoints (real Postgres) ────────────────────────────────────────────────

pytestmark_db = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _session_ctx(session):
    yield session


def _seed(db):
    client = Client(name="BT Co", email="bt@example.com", hashed_password="x", api_key="bt-key")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, bot_key="bot-bt-tone")
    db.add(bot)
    db.commit()
    return client.id, bot.id


def _app(db, monkeypatch, client_id):
    monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(db))
    monkeypatch.setattr(bot_routes, "cache_delete", lambda *a, **k: None)
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(bot_routes.router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": Client(id=client_id),
        "client_id": client_id,
        "operator_id": None,
    }
    app.dependency_overrides[require_active_subscription_for_workspace] = lambda: None
    return TestClient(app)


def test_list_presets_endpoint():
    """Static catalog is reachable and not shadowed by /{bot_id}."""
    app = FastAPI()
    app.include_router(bot_routes.router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: {"client_id": 1}
    resp = TestClient(app).get("/bots/brand-tone-presets")
    assert resp.status_code == 200
    assert len(resp.json()["presets"]) == 8


@pytestmark_db
def test_detect_writes_and_unlocks(db, monkeypatch):
    client_id, bot_id = _seed(db)
    # Start with a hand-locked custom tone.
    bot = db.get(Bot, bot_id)
    bot.brand_tone = "old custom tone"
    bot.brand_tone_preset = "custom"
    bot.manual_field_overrides = ["brand_tone"]
    db.commit()

    monkeypatch.setattr("app.db.repository.get_content_sample_for_bot", lambda *a, **k: "lots of site content")
    monkeypatch.setattr("app.services.llm_service.classify_brand_tone", lambda *a, **k: "bold")

    resp = _app(db, monkeypatch, client_id).post(f"/bots/{bot_id}/brand-tone/detect")
    assert resp.status_code == 200
    assert resp.json()["brand_tone_preset"] == "bold"
    db.expire_all()
    bot = db.get(Bot, bot_id)
    assert bot.brand_tone == preset_text("bold")
    assert bot.brand_tone_preset == "bold"
    assert bot.manual_field_overrides == []  # unlocked


@pytestmark_db
def test_detect_requires_crawled_content(db, monkeypatch):
    client_id, bot_id = _seed(db)
    monkeypatch.setattr("app.db.repository.get_content_sample_for_bot", lambda *a, **k: "")
    resp = _app(db, monkeypatch, client_id).post(f"/bots/{bot_id}/brand-tone/detect")
    assert resp.status_code == 400


@pytestmark_db
def test_preview_returns_sample(db, monkeypatch):
    client_id, bot_id = _seed(db)
    monkeypatch.setattr("app.services.llm_service.generate_tone_sample", lambda *a, **k: "Sure, happy to help!")
    resp = _app(db, monkeypatch, client_id).post(
        f"/bots/{bot_id}/brand-tone/preview", json={"brand_tone": "Friendly and warm."}
    )
    assert resp.status_code == 200
    assert resp.json()["sample"] == "Sure, happy to help!"


@pytestmark_db
def test_preview_rejects_empty_tone(db, monkeypatch):
    client_id, bot_id = _seed(db)
    resp = _app(db, monkeypatch, client_id).post(f"/bots/{bot_id}/brand-tone/preview", json={"brand_tone": ""})
    assert resp.status_code == 422


@pytestmark_db
def test_preview_503_when_llm_unavailable(db, monkeypatch):
    client_id, bot_id = _seed(db)
    monkeypatch.setattr("app.services.llm_service.generate_tone_sample", lambda *a, **k: None)
    resp = _app(db, monkeypatch, client_id).post(f"/bots/{bot_id}/brand-tone/preview", json={"brand_tone": "Friendly."})
    assert resp.status_code == 503
