"""Tests for onboarding seed-question generation + verification.

Covers the service pipeline (generate -> verify -> cap), the LLM parsing, and
the endpoint's cache behaviour. LLM + retrieval are mocked; the point is the
verification/caching logic, not the models.
"""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

import app.services.seed_questions_service as svc
from app.api.auth import get_current_client_or_operator, require_verified_email_for_workspace


def _bot(**kw):
    base = dict(id=1, client_id=1, company_name="Acme", company_description="Acme does X", seed_questions=None)
    base.update(kw)
    return SimpleNamespace(**base)


# ── service: build_seed_questions ────────────────────────────────────────────


def test_no_indexed_content_returns_empty():
    with patch.object(svc, "count_documents_for_bot", return_value=0):
        assert svc.build_seed_questions(object(), _bot()) == []


def test_only_verified_survive_and_capped_at_three():
    candidates = ["Q1?", "Q2?", "Q3?", "Q4?", "Q5?"]
    answerable = {"Q1?", "Q3?", "Q4?", "Q5?"}  # Q2 is not answerable
    with (
        patch.object(svc, "count_documents_for_bot", return_value=10),
        patch.object(svc, "generate_seed_questions", return_value=candidates),
        patch.object(svc, "_is_answerable", side_effect=lambda s, **kw: kw["question"] in answerable),
    ):
        out = svc.build_seed_questions(object(), _bot())
    # Q2 dropped (unverified); capped at 3 -> Q1, Q3, Q4.
    assert out == ["Q1?", "Q3?", "Q4?"]


def test_generation_empty_returns_empty():
    with (
        patch.object(svc, "count_documents_for_bot", return_value=10),
        patch.object(svc, "generate_seed_questions", return_value=[]),
    ):
        assert svc.build_seed_questions(object(), _bot()) == []


def test_none_answerable_returns_empty():
    with (
        patch.object(svc, "count_documents_for_bot", return_value=10),
        patch.object(svc, "generate_seed_questions", return_value=["Q1?", "Q2?"]),
        patch.object(svc, "_is_answerable", return_value=False),
    ):
        assert svc.build_seed_questions(object(), _bot()) == []


# ── LLM parsing: generate_seed_questions ─────────────────────────────────────


def test_generate_parsing_strips_noise_and_dedupes():
    from app.services import llm_service

    raw = (
        "1. What are your pricing plans?\n"
        "- How do I contact support?\n"
        '"What are your pricing plans?"\n'  # dup (case/quote variant)
        "Just a statement with no question mark\n"
        "Do you offer a free trial?\n"
    )
    fake = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=raw))])
    with patch.object(llm_service.litellm, "completion", return_value=fake):
        out = llm_service.generate_seed_questions("Acme", "Acme does X", count=5)
    assert out == [
        "What are your pricing plans?",
        "How do I contact support?",
        "Do you offer a free trial?",
    ]


def test_generate_no_context_returns_empty():
    from app.services import llm_service

    assert llm_service.generate_seed_questions(None, None) == []


# ── endpoint: caching ────────────────────────────────────────────────────────


def _build_app(bot):
    import app.api.bot_routes as bot_routes

    @contextmanager
    def _fake_session():
        yield SimpleNamespace(commit=lambda: None)

    app = FastAPI()
    # The router already carries prefix="/bots". Don't double it.
    app.include_router(bot_routes.router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": SimpleNamespace(id=1, is_bot_manager=True),
        "client_id": 1,
        "operator_id": None,
    }
    app.dependency_overrides[require_verified_email_for_workspace] = lambda: None
    patches = [
        patch.object(bot_routes, "get_session", _fake_session),
        patch.object(bot_routes, "_get_workspace_bot", lambda session, bot_id, client_id: bot),
        patch.object(bot_routes, "_require_bot_management_access", lambda auth: None),
    ]
    for p in patches:
        p.start()
    return app, patches


def test_endpoint_returns_cached_without_recompute():
    bot = _bot(seed_questions=["Cached?"])
    app, patches = _build_app(bot)
    try:
        # The route lazily imports build_seed_questions from the service module,
        # so patching it there catches an unwanted recompute.
        with patch.object(svc, "build_seed_questions", side_effect=AssertionError("should not recompute")):
            resp = TestClient(app).post("/bots/1/seed-questions")
        assert resp.status_code == 200
        assert resp.json() == {"questions": ["Cached?"]}
    finally:
        for p in patches:
            p.stop()


def test_endpoint_computes_and_caches_when_absent():
    bot = _bot(seed_questions=None)
    app, patches = _build_app(bot)
    try:
        with patch.object(svc, "build_seed_questions", return_value=["Fresh?"]):
            resp = TestClient(app).post("/bots/1/seed-questions")
        assert resp.status_code == 200
        assert resp.json() == {"questions": ["Fresh?"]}
        # Result persisted onto the bot for next time.
        assert bot.seed_questions == ["Fresh?"]
    finally:
        for p in patches:
            p.stop()
