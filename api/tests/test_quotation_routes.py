"""Quotation catalog: admin CRUD + widget runtime state machine.

Pricing lives at the **requirement** level. A service is a named grouping of
priced requirements (label · price · quantity); the visitor picks one service,
checks which requirements they want, and the quote sums the chosen requirements'
``price × quantity``.

The flow is a stateful machine persisted on ``chat_sessions.quotation_state``
(JSONB) and driven by the widget endpoints:

    idle → selecting → choosing → quoting → complete
                                          ↘ skipped

These tests exercise the whole machine end-to-end against a real Postgres
(the shared ``db`` fixture), plus the pure-model trigger math and the admin
CRUD gate. Skips without DB_URL.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import auth, quotation_routes
from app.api.quotation_routes import (
    QuotationCatalog,
    build_quotation_summary,
)
from app.db.models import Bot, ChatSession, Client, LeadInfo

pytestmark = pytest.mark.skipif(
    not os.getenv("DB_URL"),
    reason="quotation route tests need a reachable Postgres at DB_URL",
)


# ── Wiring helpers ────────────────────────────────────────────────────────────


@contextmanager
def _session_cm(session):
    yield session


@contextmanager
def _patch_session(db):
    """Point the router's module-level get_session() at the test session."""
    with patch.object(quotation_routes, "get_session", lambda: _session_cm(db)):
        yield True


def _make_client(db, *, email: str, api_key: str) -> Client:
    client = Client(name="Quote User", email=email, api_key=api_key, hashed_password="h")
    db.add(client)
    db.flush()
    db.commit()
    return client


def _make_bot(
    db,
    client_id: int,
    *,
    bot_key: str,
    catalog: dict | None = None,
    notification_email: str | None = None,
    company_name: str | None = None,
) -> Bot:
    bot = Bot(
        client_id=client_id,
        bot_key=bot_key,
        name="Quote Bot",
        quotation_catalog=catalog,
        notification_email=notification_email,
        company_name=company_name,
    )
    db.add(bot)
    db.flush()
    db.commit()
    return bot


def _make_lead(db, *, session_id: str, bot_id: int, email: str | None, name: str | None = None) -> LeadInfo:
    lead = LeadInfo(session_id=session_id, bot_id=bot_id, email=email, name=name)
    db.add(lead)
    db.flush()
    db.commit()
    return lead


def _make_session(
    db,
    *,
    session_id: str,
    bot_id: int,
    client_id: int,
    need=0,
    budget=0,
    authority=0,
    timeline=0,
    quotation_state: dict | None = None,
) -> ChatSession:
    row = ChatSession(
        id=session_id,
        bot_id=bot_id,
        client_id=client_id,
        bant_need_score=need,
        bant_budget_score=budget,
        bant_authority_score=authority,
        bant_timeline_score=timeline,
        quotation_state=quotation_state,
    )
    db.add(row)
    db.flush()
    db.commit()
    return row


def _catalog(**overrides) -> dict:
    """One service ("Landing page") with two priced requirements:
    Hero ₹8,000 ×1 and Extra content ₹2,000 ×3 (→ service total ₹14,000)."""
    base = {
        "enabled": True,
        "currency": "INR",
        "required_categories": [],
        "threshold": 2,
        "services": [
            {
                "id": "s1",
                "name": "Landing page",
                "description": "A single marketing page",
                "requirements": [
                    {"id": "r1", "label": "Hero section", "price": 8000, "quantity": 1},
                    {"id": "r2", "label": "Extra content page", "price": 2000, "quantity": 3},
                ],
            }
        ],
    }
    base.update(overrides)
    return base


def _two_service_catalog() -> dict:
    return {
        "enabled": True,
        "currency": "INR",
        "required_categories": [],
        "threshold": 2,
        "services": [
            {
                "id": "s1",
                "name": "Landing page",
                "description": "Marketing page",
                "requirements": [
                    {"id": "r1", "label": "Hero section", "price": 8000, "quantity": 1},
                    {"id": "r2", "label": "Extra content page", "price": 2000, "quantity": 3},
                ],
            },
            {
                "id": "s2",
                "name": "SEO",
                "description": "",
                "requirements": [
                    {"id": "r3", "label": "Technical audit", "price": 5000, "quantity": 1},
                ],
            },
        ],
    }


def _app():
    app = FastAPI()
    app.include_router(quotation_routes.router)
    return app


def _bot_api(app, bot) -> TestClient:
    app.dependency_overrides[auth.get_current_bot] = lambda: bot
    return TestClient(app, raise_server_exceptions=False)


def _client_api(app, client) -> TestClient:
    app.dependency_overrides[auth.get_current_client_strict] = lambda: client
    return TestClient(app, raise_server_exceptions=False)


@pytest.fixture(autouse=True)
def _allow_plan(monkeypatch):
    """Default every test to a Professional+ plan so the flow is enabled.

    Plan gating itself is asserted explicitly in the tests that flip these
    stubs to False."""
    monkeypatch.setattr(quotation_routes, "_client_plan_allows", lambda *_a, **_k: True)
    monkeypatch.setattr(quotation_routes, "_bot_plan_allows", lambda *_a, **_k: True)


# ── Pure-model trigger math + validation (no HTTP) ────────────────────────────


class TestEffectiveThreshold:
    def test_empty_categories_clamps_to_1_4(self):
        assert QuotationCatalog(required_categories=[], threshold=2).effective_threshold() == 2
        assert QuotationCatalog(required_categories=[], threshold=4).effective_threshold() == 4

    def test_threshold_cannot_exceed_chosen_categories(self):
        cat = QuotationCatalog(required_categories=["budget", "timeline"], threshold=4)
        assert cat.effective_threshold() == 2

    def test_required_categories_deduped_and_validated(self):
        cat = QuotationCatalog(required_categories=["Budget", "budget", "timeline"])
        assert cat.required_categories == ["budget", "timeline"]

    def test_invalid_category_rejected(self):
        with pytest.raises(ValueError):
            QuotationCatalog(required_categories=["revenue"])


class TestCatalogValidation:
    def test_duplicate_requirement_id_rejected(self):
        with pytest.raises(ValueError):
            QuotationCatalog(
                services=[
                    {
                        "id": "s1",
                        "name": "x",
                        "requirements": [
                            {"id": "r1", "label": "a", "price": 1},
                            {"id": "r1", "label": "b", "price": 2},
                        ],
                    }
                ]
            )

    def test_requirement_defaults_quantity_to_one(self):
        cat = QuotationCatalog.model_validate(
            {"services": [{"id": "s1", "name": "x", "requirements": [{"id": "r1", "label": "a", "price": 5}]}]}
        )
        assert cat.services[0].requirements[0].quantity == 1

    def test_negative_price_rejected(self):
        with pytest.raises(ValueError):
            QuotationCatalog(
                services=[{"id": "s1", "name": "x", "requirements": [{"id": "r1", "label": "a", "price": -1}]}]
            )

    def test_choice_requirement_needs_options(self):
        with pytest.raises(ValueError):
            QuotationCatalog(
                services=[{"id": "s1", "name": "x", "requirements": [{"id": "r1", "label": "Stack", "type": "choice"}]}]
            )

    def test_choice_options_priced_and_validated(self):
        cat = QuotationCatalog(
            services=[
                {
                    "id": "s1",
                    "name": "Dev",
                    "requirements": [
                        {
                            "id": "r1",
                            "label": "Stack",
                            "type": "choice",
                            "options": [{"id": "o1", "label": "Next.js", "price": 50000}],
                        }
                    ],
                }
            ]
        )
        opt = cat.services[0].requirements[0].options[0]
        assert opt.price == 50000 and opt.quantity == 1

    def test_legacy_question_fields_are_ignored(self):
        # A pre-migration service (unit_label/price_per_unit/questions) degrades
        # to a service with no requirements rather than exploding.
        cat = QuotationCatalog.model_validate(
            {
                "enabled": True,
                "services": [
                    {
                        "id": "s1",
                        "name": "Legacy",
                        "unit_label": "page",
                        "price_per_unit": 100,
                        "questions": [{"id": "q1", "text": "?", "type": "text"}],
                    }
                ],
            }
        )
        assert cat.services[0].requirements == []


# ── Per-session write lock ────────────────────────────────────────────────────


class TestSessionLock:
    def test_load_session_for_update_emits_row_lock(self):
        captured = {}

        class _Result:
            def scalars(self):
                class _S:
                    def first(self_inner):
                        return None

                return _S()

        class _DB:
            def execute(self, stmt):
                captured["sql"] = str(stmt)
                return _Result()

        bot = Bot(id=1, client_id=1, bot_key="bot-x")
        quotation_routes._load_session(_DB(), bot, "sess", for_update=True)
        assert "FOR UPDATE" in captured["sql"]


# ── Widget runtime state machine ──────────────────────────────────────────────


class TestQuotationFlow:
    def test_full_flow_select_choose_quote_accept(self, db, monkeypatch):
        # Silence the email side effects; the flow itself is under test here.
        monkeypatch.setattr(quotation_routes, "_schedule_quotation_emails", lambda *a, **k: None)

        client = _make_client(db, email="f1@example.com", api_key="f1")
        bot = _make_bot(db, client.id, bot_key="bot-f1", catalog=_catalog())
        _make_session(db, session_id="f1s", bot_id=bot.id, client_id=client.id, need=1, budget=1)

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            # idle → selecting
            r = api.get("/chat/quotation", params={"session_id": "f1s"})
            assert r.status_code == 200
            body = r.json()
            assert body["active"] is True and body["status"] == "selecting"
            assert [s["id"] for s in body["services"]] == ["s1"]

            # selecting → choosing (single service)
            r = api.post("/chat/quotation/select-services", json={"session_id": "f1s", "service_ids": ["s1"]})
            assert r.status_code == 200
            body = r.json()
            assert body["status"] == "choosing"
            assert body["current"]["service_id"] == "s1"
            assert [req["id"] for req in body["current"]["requirements"]] == ["r1", "r2"]
            # Requirements never leak prices to the widget.
            assert all("price" not in req for req in body["current"]["requirements"])

            # choosing → quoting (pick both requirements)
            r = api.post(
                "/chat/quotation/requirements",
                json={
                    "session_id": "f1s",
                    "service_id": "s1",
                    "selections": [{"requirement_id": "r1"}, {"requirement_id": "r2"}],
                },
            )
            assert r.status_code == 200
            body = r.json()
            assert body["status"] == "quoting"
            quote = {line["requirement_id"]: line for line in body["quote"]}
            assert quote["r1"]["subtotal"] == 8000.0
            assert quote["r2"]["subtotal"] == 6000.0  # 2000 × 3
            assert body["total"] == 14000.0

            # accept → complete
            r = api.post("/chat/quotation/accept", json={"session_id": "f1s"})
            assert r.status_code == 200
            assert r.json()["status"] == "complete"

    def test_choose_subset_of_requirements(self, db, monkeypatch):
        monkeypatch.setattr(quotation_routes, "_schedule_quotation_emails", lambda *a, **k: None)
        client = _make_client(db, email="f2@example.com", api_key="f2")
        bot = _make_bot(db, client.id, bot_key="bot-f2", catalog=_catalog())
        _make_session(db, session_id="f2s", bot_id=bot.id, client_id=client.id, need=1, budget=1)

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            api.get("/chat/quotation", params={"session_id": "f2s"})
            api.post("/chat/quotation/select-services", json={"session_id": "f2s", "service_ids": ["s1"]})
            r = api.post(
                "/chat/quotation/requirements",
                json={"session_id": "f2s", "service_id": "s1", "selections": [{"requirement_id": "r1"}]},
            )
            body = r.json()
            assert body["total"] == 8000.0
            assert [line["requirement_id"] for line in body["quote"]] == ["r1"]

    def test_choice_requirement_flow(self, db, monkeypatch):
        monkeypatch.setattr(quotation_routes, "_schedule_quotation_emails", lambda *a, **k: None)
        catalog = {
            "enabled": True,
            "currency": "INR",
            "required_categories": [],
            "threshold": 2,
            "services": [
                {
                    "id": "dev",
                    "name": "Development",
                    "description": "",
                    "requirements": [
                        {
                            "id": "stack",
                            "label": "Tech stack",
                            "type": "choice",
                            "options": [
                                {"id": "next", "label": "Next.js", "price": 50000, "quantity": 1},
                                {"id": "react", "label": "React", "price": 40000, "quantity": 1},
                            ],
                        },
                        {"id": "ci", "label": "CI/CD setup", "type": "item", "price": 10000, "quantity": 1},
                        {
                            "id": "support",
                            "label": "Support",
                            "type": "choice",
                            "options": [{"id": "std", "label": "Standard", "price": 3000, "quantity": 6}],
                        },
                    ],
                }
            ],
        }
        client = _make_client(db, email="ch1@example.com", api_key="ch1")
        bot = _make_bot(db, client.id, bot_key="bot-ch1", catalog=catalog)
        _make_session(db, session_id="ch1s", bot_id=bot.id, client_id=client.id, need=1, budget=1)
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            api.get("/chat/quotation", params={"session_id": "ch1s"})
            r = api.post("/chat/quotation/select-services", json={"session_id": "ch1s", "service_ids": ["dev"]})
            cur = r.json()["current"]
            stack = next(x for x in cur["requirements"] if x["id"] == "stack")
            assert stack["type"] == "choice"
            assert [o["id"] for o in stack["options"]] == ["next", "react"]
            assert all("price" not in o for o in stack["options"])  # options never leak prices

            # Pick Next.js + tick CI/CD; skip Support entirely.
            r = api.post(
                "/chat/quotation/requirements",
                json={
                    "session_id": "ch1s",
                    "service_id": "dev",
                    "selections": [
                        {"requirement_id": "stack", "option_id": "next"},
                        {"requirement_id": "ci"},
                    ],
                },
            )
            body = r.json()
            assert body["status"] == "quoting"
            lines = {line["requirement_id"]: line for line in body["quote"]}
            assert lines["stack"]["label"] == "Tech stack: Next.js"
            assert lines["stack"]["subtotal"] == 50000.0
            assert lines["ci"]["subtotal"] == 10000.0
            assert "support" not in lines  # optional choice, skipped
            assert body["total"] == 60000.0

    def test_choice_quantity_multiplies(self, db, monkeypatch):
        monkeypatch.setattr(quotation_routes, "_schedule_quotation_emails", lambda *a, **k: None)
        catalog = {
            "enabled": True,
            "currency": "INR",
            "required_categories": [],
            "threshold": 2,
            "services": [
                {
                    "id": "svc",
                    "name": "Retainer",
                    "requirements": [
                        {
                            "id": "support",
                            "label": "Support",
                            "type": "choice",
                            "options": [{"id": "std", "label": "Standard", "price": 3000, "quantity": 6}],
                        }
                    ],
                }
            ],
        }
        client = _make_client(db, email="ch2@example.com", api_key="ch2")
        bot = _make_bot(db, client.id, bot_key="bot-ch2", catalog=catalog)
        _make_session(db, session_id="ch2s", bot_id=bot.id, client_id=client.id, need=1, budget=1)
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            api.get("/chat/quotation", params={"session_id": "ch2s"})
            api.post("/chat/quotation/select-services", json={"session_id": "ch2s", "service_ids": ["svc"]})
            r = api.post(
                "/chat/quotation/requirements",
                json={
                    "session_id": "ch2s",
                    "service_id": "svc",
                    "selections": [{"requirement_id": "support", "option_id": "std"}],
                },
            )
            body = r.json()
            assert body["total"] == 18000.0  # 3000 × 6

    def test_requirement_question_surfaces_in_choosing_view(self, db, monkeypatch):
        monkeypatch.setattr(quotation_routes, "_schedule_quotation_emails", lambda *a, **k: None)
        catalog = {
            "enabled": True,
            "currency": "INR",
            "required_categories": [],
            "threshold": 2,
            "services": [
                {
                    "id": "s1",
                    "name": "Development",
                    "requirements": [
                        {
                            "id": "r1",
                            "label": "Tech stack",
                            "question": "Which tech stack do you prefer?",
                            "type": "choice",
                            "options": [{"id": "o1", "label": "Next.js", "price": 3000}],
                        },
                        {
                            "id": "r2",
                            "label": "Laptop",
                            "question": "Do you need a laptop?",
                            "type": "item",
                            "price": 5000,
                        },
                    ],
                }
            ],
        }
        client = _make_client(db, email="q1@example.com", api_key="q1")
        bot = _make_bot(db, client.id, bot_key="bot-q1", catalog=catalog)
        _make_session(db, session_id="q1s", bot_id=bot.id, client_id=client.id, need=1, budget=1)
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            api.get("/chat/quotation", params={"session_id": "q1s"})
            r = api.post("/chat/quotation/select-services", json={"session_id": "q1s", "service_ids": ["s1"]})
            reqs = {x["id"]: x for x in r.json()["current"]["requirements"]}
            assert reqs["r1"]["question"] == "Which tech stack do you prefer?"
            assert reqs["r2"]["question"] == "Do you need a laptop?"

    def test_quantity_modes_none_fixed_ask(self, db, monkeypatch):
        monkeypatch.setattr(quotation_routes, "_schedule_quotation_emails", lambda *a, **k: None)
        catalog = {
            "enabled": True,
            "currency": "INR",
            "required_categories": [],
            "threshold": 2,
            "services": [
                {
                    "id": "s1",
                    "name": "Dev",
                    "requirements": [
                        # none → always ×1, no unit
                        {"id": "rn", "label": "Kickoff", "type": "item", "price": 2000, "quantity_mode": "none"},
                        # fixed → admin quantity 6, unit months
                        {
                            "id": "rf",
                            "label": "Support",
                            "type": "item",
                            "price": 1000,
                            "quantity_mode": "fixed",
                            "quantity": 6,
                            "unit_label": "month",
                        },
                        # ask → visitor picks; unit laptops
                        {
                            "id": "ra",
                            "label": "Laptop",
                            "type": "item",
                            "price": 5000,
                            "quantity_mode": "ask",
                            "unit_label": "laptop",
                        },
                    ],
                }
            ],
        }
        client = _make_client(db, email="qm@example.com", api_key="qm")
        bot = _make_bot(db, client.id, bot_key="bot-qm", catalog=catalog)
        _make_session(db, session_id="qms", bot_id=bot.id, client_id=client.id, need=1, budget=1)
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            r = api.get("/chat/quotation", params={"session_id": "qms"})
            api.post("/chat/quotation/select-services", json={"session_id": "qms", "service_ids": ["s1"]})
            reqs = {
                x["id"]: x
                for x in api.get("/chat/quotation", params={"session_id": "qms"}).json()["current"]["requirements"]
            }
            assert reqs["ra"]["quantity_mode"] == "ask" and reqs["ra"]["unit_label"] == "laptop"

            # Tick none + fixed, and ask for 3 laptops.
            r = api.post(
                "/chat/quotation/requirements",
                json={
                    "session_id": "qms",
                    "service_id": "s1",
                    "selections": [
                        {"requirement_id": "rn"},
                        {"requirement_id": "rf"},
                        {"requirement_id": "ra", "quantity": 3},
                    ],
                },
            )
            body = r.json()
            lines = {line["requirement_id"]: line for line in body["quote"]}
            assert (
                lines["rn"]["quantity"] == 1 and lines["rn"]["unit_label"] == "" and lines["rn"]["subtotal"] == 2000.0
            )
            assert (
                lines["rf"]["quantity"] == 6
                and lines["rf"]["unit_label"] == "month"
                and lines["rf"]["subtotal"] == 6000.0
            )
            assert (
                lines["ra"]["quantity"] == 3
                and lines["ra"]["unit_label"] == "laptop"
                and lines["ra"]["subtotal"] == 15000.0
            )
            assert body["total"] == 23000.0  # 2000 + 6000 + 15000

    def test_ask_requirement_zero_quantity_is_excluded(self, db, monkeypatch):
        monkeypatch.setattr(quotation_routes, "_schedule_quotation_emails", lambda *a, **k: None)
        catalog = {
            "enabled": True,
            "currency": "INR",
            "required_categories": [],
            "threshold": 2,
            "services": [
                {
                    "id": "s1",
                    "name": "Dev",
                    "requirements": [
                        {"id": "ra", "label": "Laptop", "type": "item", "price": 5000, "quantity_mode": "ask"},
                        {"id": "ri", "label": "Setup", "type": "item", "price": 1000, "quantity_mode": "none"},
                    ],
                }
            ],
        }
        client = _make_client(db, email="qz@example.com", api_key="qz")
        bot = _make_bot(db, client.id, bot_key="bot-qz", catalog=catalog)
        _make_session(db, session_id="qzs", bot_id=bot.id, client_id=client.id, need=1, budget=1)
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            api.get("/chat/quotation", params={"session_id": "qzs"})
            api.post("/chat/quotation/select-services", json={"session_id": "qzs", "service_ids": ["s1"]})
            r = api.post(
                "/chat/quotation/requirements",
                json={
                    "session_id": "qzs",
                    "service_id": "s1",
                    "selections": [{"requirement_id": "ra", "quantity": 0}, {"requirement_id": "ri"}],
                },
            )
            body = r.json()
            assert [line["requirement_id"] for line in body["quote"]] == ["ri"]  # laptop (qty 0) excluded
            assert body["total"] == 1000.0

    def test_empty_service_selection_is_skip(self, db):
        client = _make_client(db, email="f3@example.com", api_key="f3")
        bot = _make_bot(db, client.id, bot_key="bot-f3", catalog=_catalog())
        _make_session(db, session_id="f3s", bot_id=bot.id, client_id=client.id, need=1, budget=1)

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            api.get("/chat/quotation", params={"session_id": "f3s"})
            r = api.post("/chat/quotation/select-services", json={"session_id": "f3s", "service_ids": []})
            assert r.status_code == 200
            assert r.json()["status"] == "skipped"

    def test_empty_requirements_is_skip(self, db):
        client = _make_client(db, email="f4@example.com", api_key="f4")
        bot = _make_bot(db, client.id, bot_key="bot-f4", catalog=_catalog())
        _make_session(db, session_id="f4s", bot_id=bot.id, client_id=client.id, need=1, budget=1)

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            api.get("/chat/quotation", params={"session_id": "f4s"})
            api.post("/chat/quotation/select-services", json={"session_id": "f4s", "service_ids": ["s1"]})
            r = api.post(
                "/chat/quotation/requirements",
                json={"session_id": "f4s", "service_id": "s1", "selections": []},
            )
            assert r.status_code == 200
            assert r.json()["status"] == "skipped"

    def test_second_service_pick_wins_when_multiple_sent(self, db, monkeypatch):
        monkeypatch.setattr(quotation_routes, "_schedule_quotation_emails", lambda *a, **k: None)
        client = _make_client(db, email="f5@example.com", api_key="f5")
        bot = _make_bot(db, client.id, bot_key="bot-f5", catalog=_two_service_catalog())
        _make_session(db, session_id="f5s", bot_id=bot.id, client_id=client.id, need=1, budget=1)

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            api.get("/chat/quotation", params={"session_id": "f5s"})
            # Widget is single-select; if several ids arrive we keep the first valid.
            r = api.post("/chat/quotation/select-services", json={"session_id": "f5s", "service_ids": ["s2", "s1"]})
            body = r.json()
            assert body["current"]["service_id"] == "s2"

    def test_unknown_service_400(self, db):
        client = _make_client(db, email="f6@example.com", api_key="f6")
        bot = _make_bot(db, client.id, bot_key="bot-f6", catalog=_catalog())
        _make_session(db, session_id="f6s", bot_id=bot.id, client_id=client.id, need=1, budget=1)
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            api.get("/chat/quotation", params={"session_id": "f6s"})
            api.post("/chat/quotation/select-services", json={"session_id": "f6s", "service_ids": ["s1"]})
            r = api.post(
                "/chat/quotation/requirements",
                json={"session_id": "f6s", "service_id": "nope", "selections": [{"requirement_id": "r1"}]},
            )
            assert r.status_code == 400

    def test_requirements_before_choosing_409(self, db):
        client = _make_client(db, email="f7@example.com", api_key="f7")
        bot = _make_bot(db, client.id, bot_key="bot-f7", catalog=_catalog())
        # Session sits in 'selecting', not 'choosing'.
        _make_session(
            db,
            session_id="f7s",
            bot_id=bot.id,
            client_id=client.id,
            need=1,
            budget=1,
            quotation_state={"status": "selecting", "selected_service_ids": [], "selected_requirements": {}},
        )
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            r = api.post(
                "/chat/quotation/requirements",
                json={"session_id": "f7s", "service_id": "s1", "selections": [{"requirement_id": "r1"}]},
            )
            assert r.status_code == 409


class TestBantGating:
    def test_below_threshold_inactive(self, db):
        client = _make_client(db, email="b1@example.com", api_key="b1")
        bot = _make_bot(db, client.id, bot_key="bot-b1", catalog=_catalog())  # threshold 2
        _make_session(db, session_id="b1s", bot_id=bot.id, client_id=client.id, need=1)  # only 1 marked
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            r = api.get("/chat/quotation", params={"session_id": "b1s"})
            assert r.json()["active"] is False

    def test_required_category_subset(self, db):
        client = _make_client(db, email="b2@example.com", api_key="b2")
        bot = _make_bot(db, client.id, bot_key="bot-b2", catalog=_catalog(required_categories=["budget"], threshold=1))
        # need marked but budget not → still inactive because only budget counts.
        _make_session(db, session_id="b2s", bot_id=bot.id, client_id=client.id, need=1)
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            assert api.get("/chat/quotation", params={"session_id": "b2s"}).json()["active"] is False
        # budget marked → active.
        _make_session(db, session_id="b2s2", bot_id=bot.id, client_id=client.id, budget=1)
        with _patch_session(db):
            assert api.get("/chat/quotation", params={"session_id": "b2s2"}).json()["active"] is True


class TestPlanGating:
    def test_bot_plan_downgrade_deactivates_flow(self, db, monkeypatch):
        client = _make_client(db, email="p1@example.com", api_key="p1")
        bot = _make_bot(db, client.id, bot_key="bot-p1", catalog=_catalog())
        _make_session(db, session_id="p1s", bot_id=bot.id, client_id=client.id, need=1, budget=1)
        monkeypatch.setattr(quotation_routes, "_bot_plan_allows", lambda *_a, **_k: False)
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            assert api.get("/chat/quotation", params={"session_id": "p1s"}).json()["active"] is False

    def test_put_catalog_plan_gate_403(self, db, monkeypatch):
        client = _make_client(db, email="p2@example.com", api_key="p2")
        bot = _make_bot(db, client.id, bot_key="bot-p2")
        monkeypatch.setattr(quotation_routes, "_client_plan_allows", lambda *_a, **_k: False)
        api = _client_api(_app(), client)
        with _patch_session(db):
            r = api.put(f"/bots/{bot.id}/quotation-catalog", json=_catalog())
            assert r.status_code == 403
            assert r.json()["detail"] == "plan_upgrade_required"


class TestAdminCatalogCrud:
    def test_get_default_empty(self, db):
        client = _make_client(db, email="a1@example.com", api_key="a1")
        bot = _make_bot(db, client.id, bot_key="bot-a1")
        api = _client_api(_app(), client)
        with _patch_session(db):
            r = api.get(f"/bots/{bot.id}/quotation-catalog")
            assert r.status_code == 200
            assert r.json()["enabled"] is False and r.json()["services"] == []

    def test_put_then_get_roundtrips(self, db):
        client = _make_client(db, email="a2@example.com", api_key="a2")
        bot = _make_bot(db, client.id, bot_key="bot-a2")
        api = _client_api(_app(), client)
        with _patch_session(db):
            r = api.put(f"/bots/{bot.id}/quotation-catalog", json=_catalog())
            assert r.status_code == 200
            r = api.get(f"/bots/{bot.id}/quotation-catalog")
            body = r.json()
            assert body["services"][0]["requirements"][0]["price"] == 8000.0
            assert body["services"][0]["requirements"][1]["quantity"] == 3

    def test_cross_tenant_404(self, db):
        owner = _make_client(db, email="a3@example.com", api_key="a3")
        other = _make_client(db, email="a3b@example.com", api_key="a3b")
        bot = _make_bot(db, owner.id, bot_key="bot-a3")
        api = _client_api(_app(), other)
        with _patch_session(db):
            assert api.get(f"/bots/{bot.id}/quotation-catalog").status_code == 404


class TestBuildSummary:
    def test_summary_shape(self, db):
        client = _make_client(db, email="s1@example.com", api_key="s1")
        bot = _make_bot(db, client.id, bot_key="bot-s1", catalog=_catalog())
        session = _make_session(
            db,
            session_id="s1s",
            bot_id=bot.id,
            client_id=client.id,
            quotation_state={
                "status": "complete",
                "selected_service_ids": ["s1"],
                "selected_requirements": {"s1": {"r1": None, "r2": None}},
            },
        )
        summary = build_quotation_summary(bot, session)
        assert summary["currency"] == "INR"
        assert summary["total"] == 14000.0
        assert len(summary["line_items"]) == 2
        item = summary["line_items"][0]
        assert item == {
            "service_id": "s1",
            "service_name": "Landing page",
            "requirement_id": "r1",
            "label": "Hero section",
            "quantity": 1,
            "unit_label": "unit",
            "price": 8000.0,
            "subtotal": 8000.0,
        }

    def test_summary_none_without_state(self, db):
        client = _make_client(db, email="s2@example.com", api_key="s2")
        bot = _make_bot(db, client.id, bot_key="bot-s2", catalog=_catalog())
        session = _make_session(db, session_id="s2s", bot_id=bot.id, client_id=client.id)
        assert build_quotation_summary(bot, session) is None


# ── Completion emails ─────────────────────────────────────────────────────────

_QUOTING_STATE = {
    "status": "quoting",
    "selected_service_ids": ["s1"],
    "selected_requirements": {"s1": {"r1": None, "r2": None}},
}


class TestQuotationEmails:
    """Accepting fires three best-effort emails: owner notification (immediate),
    visitor acknowledgement (immediate, no pricing) and the priced document
    (deferred; inline when the worker is off). PDF render is stubbed."""

    @pytest.fixture()
    def _capture_emails(self, monkeypatch):
        calls = {"visitor": [], "document": [], "client": []}
        monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", False)
        monkeypatch.setattr(
            quotation_routes.email_service,
            "send_quotation_visitor_email",
            lambda *a, **k: calls["visitor"].append((a, k)),
        )
        monkeypatch.setattr(
            quotation_routes.email_service,
            "send_quotation_document_email",
            lambda *a, **k: calls["document"].append((a, k)),
        )
        monkeypatch.setattr(
            quotation_routes.email_service,
            "send_quotation_client_email",
            lambda *a, **k: calls["client"].append((a, k)),
        )
        return calls

    def test_accept_sends_all_three(self, db, _capture_emails):
        client = _make_client(db, email="e1@example.com", api_key="e1")
        bot = _make_bot(
            db,
            client.id,
            bot_key="bot-e1",
            catalog=_catalog(),
            notification_email="owner@acme.com",
            company_name="Acme Co",
        )
        _make_session(db, session_id="e1s", bot_id=bot.id, client_id=client.id, quotation_state=dict(_QUOTING_STATE))
        _make_lead(db, session_id="e1s", bot_id=bot.id, email="jason@buyer.com", name="Jason")

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.post("/chat/quotation/accept", json={"session_id": "e1s"})
        assert res.status_code == 200 and res.json()["status"] == "complete"

        # Visitor acknowledgement: service names, no pricing.
        assert len(_capture_emails["visitor"]) == 1
        v_args, _ = _capture_emails["visitor"][0]
        assert v_args[0] == "jason@buyer.com"
        assert v_args[3] == ["Landing page"]  # unique service names

        # Document email: currency + line items + total.
        assert len(_capture_emails["document"]) == 1
        d_args, _ = _capture_emails["document"][0]
        assert d_args[0] == "jason@buyer.com"
        assert d_args[3] == "INR"
        assert d_args[5] == 14000.0

        # Owner email: full itemised quote.
        assert len(_capture_emails["client"]) == 1
        c_args, c_kwargs = _capture_emails["client"][0]
        assert c_args[0] == "owner@acme.com"
        assert c_args[5] == 14000.0
        assert c_kwargs["reply_to"] == "jason@buyer.com"

    def test_no_lead_email_skips_visitor_facing(self, db, _capture_emails):
        client = _make_client(db, email="e2@example.com", api_key="e2")
        bot = _make_bot(db, client.id, bot_key="bot-e2", catalog=_catalog(), notification_email="owner@acme.com")
        _make_session(db, session_id="e2s", bot_id=bot.id, client_id=client.id, quotation_state=dict(_QUOTING_STATE))
        _make_lead(db, session_id="e2s", bot_id=bot.id, email=None, name="Anon")
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            api.post("/chat/quotation/accept", json={"session_id": "e2s"})
        assert _capture_emails["visitor"] == []
        assert _capture_emails["document"] == []
        assert len(_capture_emails["client"]) == 1

    def test_email_failure_never_breaks_accept(self, db, monkeypatch):
        client = _make_client(db, email="e3@example.com", api_key="e3")
        bot = _make_bot(db, client.id, bot_key="bot-e3", catalog=_catalog(), notification_email="owner@acme.com")
        _make_session(db, session_id="e3s", bot_id=bot.id, client_id=client.id, quotation_state=dict(_QUOTING_STATE))
        _make_lead(db, session_id="e3s", bot_id=bot.id, email="jason@buyer.com")

        def _boom(*_a, **_k):
            raise RuntimeError("brevo down")

        monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", False)
        monkeypatch.setattr(quotation_routes.email_service, "send_quotation_visitor_email", _boom)
        monkeypatch.setattr(quotation_routes.email_service, "send_quotation_document_email", _boom)
        monkeypatch.setattr(quotation_routes.email_service, "send_quotation_client_email", _boom)
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.post("/chat/quotation/accept", json={"session_id": "e3s"})
        assert res.status_code == 200 and res.json()["status"] == "complete"


class TestQuotationEmailScheduling:
    def test_owner_and_ack_now_document_deferred(self, db, monkeypatch):
        from datetime import timedelta

        import app.worker.enqueue as enqueue_mod

        client = _make_client(db, email="sch1@example.com", api_key="sch1")
        bot = _make_bot(db, client.id, bot_key="bot-sch1", catalog=_catalog(), notification_email="owner@acme.com")
        _make_session(db, session_id="sch1s", bot_id=bot.id, client_id=client.id, quotation_state=dict(_QUOTING_STATE))
        _make_lead(db, session_id="sch1s", bot_id=bot.id, email="jason@buyer.com", name="Jason")

        calls, visitor_sent, document_sent, client_sent = [], [], [], []
        monkeypatch.setattr(enqueue_mod, "WORKER_ENABLED", True)
        monkeypatch.setattr(enqueue_mod, "enqueue_sync", lambda name, *a, **kw: calls.append((name, a, kw)))
        monkeypatch.setattr(
            quotation_routes.email_service, "send_quotation_visitor_email", lambda *a, **k: visitor_sent.append(a)
        )
        monkeypatch.setattr(
            quotation_routes.email_service, "send_quotation_document_email", lambda *a, **k: document_sent.append(a)
        )
        monkeypatch.setattr(
            quotation_routes.email_service, "send_quotation_client_email", lambda *a, **k: client_sent.append(a)
        )
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            api.post("/chat/quotation/accept", json={"session_id": "sch1s"})

        assert len(client_sent) == 1 and len(visitor_sent) == 1
        assert document_sent == []
        assert len(calls) == 1
        name, args, kwargs = calls[0]
        assert name == "task_send_quotation_visitor_email"
        assert args == ("sch1s", bot.id)
        assert kwargs["_defer_by"] == timedelta(seconds=quotation_routes.QUOTATION_EMAIL_DELAY_SECONDS)

    def test_document_dispatch_helper_sends_only_document(self, db, monkeypatch):
        calls = {"visitor": [], "document": [], "client": []}
        client = _make_client(db, email="sch2@example.com", api_key="sch2")
        bot = _make_bot(
            db,
            client.id,
            bot_key="bot-sch2",
            catalog=_catalog(),
            notification_email="owner@acme.com",
            company_name="Acme Co",
        )
        _make_session(db, session_id="sch2s", bot_id=bot.id, client_id=client.id, quotation_state=dict(_QUOTING_STATE))
        _make_lead(db, session_id="sch2s", bot_id=bot.id, email="jason@buyer.com", name="Jason")

        monkeypatch.setattr(
            quotation_routes.email_service, "send_quotation_visitor_email", lambda *a, **k: calls["visitor"].append(a)
        )
        monkeypatch.setattr(
            quotation_routes.email_service, "send_quotation_document_email", lambda *a, **k: calls["document"].append(a)
        )
        monkeypatch.setattr(
            quotation_routes.email_service, "send_quotation_client_email", lambda *a, **k: calls["client"].append(a)
        )
        with _patch_session(db):
            quotation_routes.dispatch_quotation_document_email_for_session("sch2s", bot.id)
        assert len(calls["document"]) == 1
        assert calls["visitor"] == [] and calls["client"] == []


class TestQuotationEmailBuilders:
    """Exercise the real HTML builders (only the Brevo dispatch is stubbed)."""

    @pytest.fixture()
    def _sent(self, monkeypatch):
        from app.services import email_service

        captured = []
        monkeypatch.setattr(
            email_service,
            "send_email_async",
            lambda to, subject, body, **kw: captured.append((to, subject, body, kw)),
        )
        return captured

    _LINE_ITEMS = [
        {
            "service_id": "s1",
            "service_name": "Landing page",
            "requirement_id": "r1",
            "label": "Hero section",
            "quantity": 1,
            "price": 8000.0,
            "subtotal": 8000.0,
        },
        {
            "service_id": "s1",
            "service_name": "Landing page",
            "requirement_id": "r2",
            "label": "Extra page",
            "quantity": 3,
            "price": 2000.0,
            "subtotal": 6000.0,
        },
    ]

    def test_visitor_ack_has_no_pricing(self, _sent):
        from app.services import email_service

        email_service.send_quotation_visitor_email("jason@buyer.com", "Acme Co", "Jason", ["Landing page"])
        assert len(_sent) == 1
        to, subject, body, _ = _sent[0]
        assert to == "jason@buyer.com"
        assert "Landing page" in body
        assert "₹" not in body and "8,000" not in body

    def test_document_email_prices_inline_no_attachment(self, _sent):
        from app.services import email_service

        email_service.send_quotation_document_email(
            "jason@buyer.com", "Acme Co", "Jason", "INR", self._LINE_ITEMS, 14000.0
        )
        _, subject, body, kwargs = _sent[0]
        assert "Your quotation" in subject
        assert "Landing page" in body  # service group header
        assert "Hero section" in body and "Extra page" in body
        assert "₹8,000" in body and "₹6,000" in body and "₹14,000" in body
        # The quotation ships inline in the body — never as a PDF attachment.
        assert kwargs.get("attachments") is None

    def test_document_email_qty_is_plain_number_without_unit_label(self, _sent):
        from app.services import email_service

        line_items = [
            {
                "service_id": "s1",
                "service_name": "Development",
                "requirement_id": "r1",
                "label": "Laptop",
                "unit_label": "unit",
                "quantity": 2,
                "price": 5000.0,
                "subtotal": 10000.0,
            },
        ]
        email_service.send_quotation_document_email("jason@buyer.com", "Acme Co", "Jason", "INR", line_items, 10000.0)
        _, _, body, _kw = _sent[0]
        # The QTY column shows the bare number — the unit label is not rendered.
        assert "2 unit" not in body and "2 units" not in body
        assert "Laptop" in body and "₹5,000" in body and "₹10,000" in body

    def test_client_email_renders_grouped_total(self, _sent):
        from app.services import email_service

        email_service.send_quotation_client_email(
            "owner@acme.com",
            "Quote Bot",
            {"name": "Jason", "email": "jason@buyer.com"},
            "INR",
            self._LINE_ITEMS,
            14000.0,
            reply_to="jason@buyer.com",
        )
        to, subject, body, kwargs = _sent[0]
        assert to == "owner@acme.com"
        assert "Hero section" in body and "Extra page" in body
        assert "₹14,000" in body
        assert kwargs.get("reply_to") == "jason@buyer.com"
