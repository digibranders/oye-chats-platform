"""Quotation catalog: admin CRUD + widget runtime state machine.

The quotation flow is a stateful machine persisted on
``chat_sessions.quotation_state`` (JSONB) and driven by seven endpoints:

    idle → selecting → answering → quoting → complete
                                          ↘ skipped

These tests exercise the whole machine end-to-end against a real Postgres
(the shared ``db`` fixture), plus the pure-model trigger math and the admin
CRUD gate. Mirrors tests/test_activation_events.py. Skips without DB_URL.

Coverage map (the edge cases called out in review):
  * happy path: select → answer → quantity → quote → accept
  * BANT trigger gating (below threshold inactive; at threshold active)
  * required_categories subset gating + effective_threshold clamp
  * empty selection == skip; explicit skip preserves partial answers
  * plan downgrade mid-flow silently deactivates the widget flow
  * admin deletes a picked service mid-flow (graceful skip)
  * per-type answer validation (required / choice / number)
  * terminal-state guards (409) and unknown service/question (400)
  * admin GET default, PUT persist, PUT plan gate (403), cross-tenant 404
  * build_quotation_summary shape for the operator/lead surfaces
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

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
    """A one-service catalog: a text question + a default quantity of 2 at ₹100."""
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
                "unit_label": "page",
                "price_per_unit": 100.0,
                "default_quantity": 2,
                "questions": [
                    {
                        "id": "q1",
                        "text": "What style?",
                        "type": "text",
                        "options": [],
                        "required": True,
                    }
                ],
            }
        ],
    }
    base.update(overrides)
    return base


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
    stubs to False — see ``test_put_catalog_plan_gate_403`` and
    ``test_plan_downgrade_deactivates_flow``.
    """
    monkeypatch.setattr(quotation_routes, "_client_plan_allows", lambda *_a, **_k: True)
    monkeypatch.setattr(quotation_routes, "_bot_plan_allows", lambda *_a, **_k: True)


# ── Pure-model trigger math (no HTTP) ─────────────────────────────────────────


class TestEffectiveThreshold:
    def test_empty_categories_clamps_to_1_4(self):
        assert QuotationCatalog(required_categories=[], threshold=2).effective_threshold() == 2
        assert QuotationCatalog(required_categories=[], threshold=4).effective_threshold() == 4

    def test_threshold_cannot_exceed_chosen_categories(self):
        # "3 of 2 chosen" is unreachable by construction — clamp to 2.
        cat = QuotationCatalog(required_categories=["budget", "timeline"], threshold=4)
        assert cat.effective_threshold() == 2

    def test_required_categories_deduped_and_validated(self):
        cat = QuotationCatalog(required_categories=["Budget", "budget", "timeline"])
        assert cat.required_categories == ["budget", "timeline"]

    def test_invalid_category_rejected(self):
        with pytest.raises(ValueError):
            QuotationCatalog(required_categories=["revenue"])

    def test_choice_question_needs_an_option(self):
        with pytest.raises(ValueError):
            QuotationCatalog(
                services=[
                    {
                        "id": "s1",
                        "name": "x",
                        "price_per_unit": 1,
                        "questions": [{"id": "q1", "text": "pick", "type": "choice", "options": []}],
                    }
                ]
            )


# ── Per-session write lock ────────────────────────────────────────────────────


class TestSessionLock:
    """Guards the row lock that serializes the read-modify-write on
    ``quotation_state``. Every mutating handler must load the session
    ``FOR UPDATE`` so overlapping requests can't clobber each other's blob."""

    def test_load_session_for_update_emits_row_lock(self):
        from unittest.mock import MagicMock

        from sqlalchemy.dialects import postgresql

        from app.api.quotation_routes import _load_session

        captured = []

        def _capture(stmt):
            captured.append(str(stmt.compile(dialect=postgresql.dialect())).upper())
            result = MagicMock()
            result.scalars.return_value.first.return_value = None
            return result

        db = MagicMock()
        db.execute.side_effect = _capture
        bot = MagicMock(spec=["id"])
        bot.id = 1

        _load_session(db, bot, "s1", for_update=True)
        _load_session(db, bot, "s1")  # default: plain read, no lock

        assert "FOR UPDATE" in captured[0]
        assert "FOR UPDATE" not in captured[1]


# ── Widget runtime: trigger gating ────────────────────────────────────────────


class TestTriggerGating:
    def test_below_threshold_is_inactive(self, db):
        client = _make_client(db, email="t1@example.com", api_key="t1")
        bot = _make_bot(db, client.id, bot_key="bot-t1", catalog=_catalog())
        _make_session(db, session_id="sess-t1", bot_id=bot.id, client_id=client.id, need=1)

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.get("/chat/quotation", params={"session_id": "sess-t1"})
        assert res.status_code == 200
        assert res.json()["active"] is False

    def test_at_threshold_activates_and_flips_to_selecting(self, db):
        client = _make_client(db, email="t2@example.com", api_key="t2")
        bot = _make_bot(db, client.id, bot_key="bot-t2", catalog=_catalog())
        _make_session(db, session_id="sess-t2", bot_id=bot.id, client_id=client.id, need=1, budget=1)

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.get("/chat/quotation", params={"session_id": "sess-t2"})
        body = res.json()
        assert body["active"] is True
        assert body["status"] == "selecting"
        assert [s["id"] for s in body["services"]] == ["s1"]
        # side effect: session state persisted as selecting
        row = db.execute(select(ChatSession).where(ChatSession.id == "sess-t2")).scalars().first()
        assert row.quotation_state["status"] == "selecting"

    def test_required_categories_subset_only_counts_chosen(self, db):
        # Require Budget+Timeline (threshold auto-clamps to 2). Need+Authority
        # marked must NOT satisfy it; Budget+Timeline must.
        client = _make_client(db, email="t3@example.com", api_key="t3")
        cat = _catalog(required_categories=["budget", "timeline"], threshold=2)
        bot = _make_bot(db, client.id, bot_key="bot-t3", catalog=cat)
        _make_session(db, session_id="off", bot_id=bot.id, client_id=client.id, need=1, authority=1)
        _make_session(db, session_id="on", bot_id=bot.id, client_id=client.id, budget=1, timeline=1)

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            off = api.get("/chat/quotation", params={"session_id": "off"}).json()
            on = api.get("/chat/quotation", params={"session_id": "on"}).json()
        assert off["active"] is False
        assert on["active"] is True

    def test_disabled_catalog_is_inactive(self, db):
        client = _make_client(db, email="t4@example.com", api_key="t4")
        bot = _make_bot(db, client.id, bot_key="bot-t4", catalog=_catalog(enabled=False))
        _make_session(db, session_id="sess-t4", bot_id=bot.id, client_id=client.id, need=1, budget=1)

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.get("/chat/quotation", params={"session_id": "sess-t4"})
        assert res.json()["active"] is False

    def test_plan_downgrade_deactivates_flow(self, db, monkeypatch):
        client = _make_client(db, email="t5@example.com", api_key="t5")
        bot = _make_bot(db, client.id, bot_key="bot-t5", catalog=_catalog())
        _make_session(db, session_id="sess-t5", bot_id=bot.id, client_id=client.id, need=1, budget=1)

        monkeypatch.setattr(quotation_routes, "_bot_plan_allows", lambda *_a, **_k: False)
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.get("/chat/quotation", params={"session_id": "sess-t5"})
        assert res.json()["active"] is False


# ── Widget runtime: full state machine ────────────────────────────────────────


class TestStateMachine:
    def _activate(self, db, api, session_id):
        """Drive idle → selecting so the session has an active state row."""
        with _patch_session(db):
            return api.get("/chat/quotation", params={"session_id": session_id}).json()

    def test_full_happy_path(self, db):
        client = _make_client(db, email="h1@example.com", api_key="h1")
        bot = _make_bot(db, client.id, bot_key="bot-h1", catalog=_catalog())
        _make_session(db, session_id="h1s", bot_id=bot.id, client_id=client.id, need=1, budget=1)
        api = _bot_api(_app(), bot)

        assert self._activate(db, api, "h1s")["status"] == "selecting"

        with _patch_session(db):
            answering = api.post(
                "/chat/quotation/select-services",
                json={"session_id": "h1s", "service_ids": ["s1"]},
            ).json()
        assert answering["status"] == "answering"
        assert answering["current"]["question"]["id"] == "q1"

        with _patch_session(db):
            after_answer = api.post(
                "/chat/quotation/answer",
                json={"session_id": "h1s", "service_id": "s1", "question_id": "q1", "answer": "Modern"},
            ).json()
        # question answered → next step is the (silent) quantity step
        assert after_answer["status"] == "answering"
        assert after_answer["current"]["question"] is None

        with _patch_session(db):
            quoting = api.post(
                "/chat/quotation/quantity",
                json={"session_id": "h1s", "service_id": "s1", "quantity": 2},
            ).json()
        assert quoting["status"] == "quoting"
        assert quoting["total"] == 200.0
        assert quoting["quote"][0] == {
            "service_id": "s1",
            "name": "Landing page",
            "unit_label": "page",
            "price_per_unit": 100.0,
            "quantity": 2,
            "subtotal": 200.0,
        }

        with _patch_session(db):
            done = api.post("/chat/quotation/accept", json={"session_id": "h1s"}).json()
        assert done["active"] is False
        assert done["status"] == "complete"
        assert done["total"] == 200.0

    def test_empty_selection_is_a_skip(self, db):
        client = _make_client(db, email="h2@example.com", api_key="h2")
        bot = _make_bot(db, client.id, bot_key="bot-h2", catalog=_catalog())
        _make_session(db, session_id="h2s", bot_id=bot.id, client_id=client.id, need=1, budget=1)
        api = _bot_api(_app(), bot)
        self._activate(db, api, "h2s")

        with _patch_session(db):
            res = api.post(
                "/chat/quotation/select-services",
                json={"session_id": "h2s", "service_ids": []},
            ).json()
        assert res["active"] is False
        assert res["status"] == "skipped"

    def test_explicit_skip_preserves_partial_answers(self, db):
        client = _make_client(db, email="h3@example.com", api_key="h3")
        bot = _make_bot(db, client.id, bot_key="bot-h3", catalog=_catalog())
        _make_session(db, session_id="h3s", bot_id=bot.id, client_id=client.id, need=1, budget=1)
        api = _bot_api(_app(), bot)
        self._activate(db, api, "h3s")

        with _patch_session(db):
            api.post(
                "/chat/quotation/select-services",
                json={"session_id": "h3s", "service_ids": ["s1"]},
            )
            api.post(
                "/chat/quotation/answer",
                json={"session_id": "h3s", "service_id": "s1", "question_id": "q1", "answer": "Modern"},
            )
            skipped = api.post("/chat/quotation/skip", json={"session_id": "h3s"}).json()
        assert skipped["status"] == "skipped"
        row = db.execute(select(ChatSession).where(ChatSession.id == "h3s")).scalars().first()
        assert row.quotation_state["answers"]["s1"]["q1"] == "Modern"

    def test_deleted_service_mid_flow_is_skipped_gracefully(self, db):
        """Admin removes a picked service while the visitor is mid-flow: the
        machine walks past the now-missing service instead of 500-ing."""
        two_services = _catalog()
        two_services["services"].append(
            {
                "id": "s2",
                "name": "SEO audit",
                "description": "",
                "unit_label": "audit",
                "price_per_unit": 50.0,
                "default_quantity": 1,
                "questions": [],
            }
        )
        client = _make_client(db, email="h4@example.com", api_key="h4")
        bot = _make_bot(db, client.id, bot_key="bot-h4", catalog=two_services)
        _make_session(db, session_id="h4s", bot_id=bot.id, client_id=client.id, need=1, budget=1)
        api = _bot_api(_app(), bot)
        self._activate(db, api, "h4s")

        with _patch_session(db):
            api.post(
                "/chat/quotation/select-services",
                json={"session_id": "h4s", "service_ids": ["s1", "s2"]},
            )
            api.post(
                "/chat/quotation/answer",
                json={"session_id": "h4s", "service_id": "s1", "question_id": "q1", "answer": "Modern"},
            )
            api.post(
                "/chat/quotation/quantity",
                json={"session_id": "h4s", "service_id": "s1", "quantity": 1},
            )

        # Admin deletes s2 from the catalog now.
        bot.quotation_catalog = _catalog()  # only s1 remains
        db.commit()

        with _patch_session(db):
            res = api.post(
                "/chat/quotation/quantity",
                json={"session_id": "h4s", "service_id": "s1", "quantity": 1},
            ).json()
        # s2 is gone → the only quotable line is s1; no crash.
        assert res["status"] == "quoting"
        assert [line["service_id"] for line in res["quote"]] == ["s1"]


# ── Widget runtime: validation + guards ───────────────────────────────────────


class TestValidationAndGuards:
    def _reach_answering(self, db, api, session_id, catalog_questions):
        cat = _catalog()
        cat["services"][0]["questions"] = catalog_questions
        return cat

    def test_required_answer_rejected_when_empty(self, db):
        client = _make_client(db, email="v1@example.com", api_key="v1")
        bot = _make_bot(db, client.id, bot_key="bot-v1", catalog=_catalog())
        _make_session(
            db,
            session_id="v1s",
            bot_id=bot.id,
            client_id=client.id,
            need=1,
            budget=1,
            quotation_state={
                "status": "answering",
                "selected_service_ids": ["s1"],
                "current_service_index": 0,
                "answers": {},
                "quantities": {},
            },
        )
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.post(
                "/chat/quotation/answer",
                json={"session_id": "v1s", "service_id": "s1", "question_id": "q1", "answer": "   "},
            )
        assert res.status_code == 422
        assert res.json()["detail"] == "answer_required"

    def test_choice_answer_must_be_in_options(self, db):
        cat = _catalog()
        cat["services"][0]["questions"] = [
            {"id": "q1", "text": "Pick", "type": "choice", "options": ["A", "B"], "required": True}
        ]
        client = _make_client(db, email="v2@example.com", api_key="v2")
        bot = _make_bot(db, client.id, bot_key="bot-v2", catalog=cat)
        _make_session(
            db,
            session_id="v2s",
            bot_id=bot.id,
            client_id=client.id,
            need=1,
            budget=1,
            quotation_state={
                "status": "answering",
                "selected_service_ids": ["s1"],
                "current_service_index": 0,
                "answers": {},
                "quantities": {},
            },
        )
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            bad = api.post(
                "/chat/quotation/answer",
                json={"session_id": "v2s", "service_id": "s1", "question_id": "q1", "answer": "C"},
            )
            good = api.post(
                "/chat/quotation/answer",
                json={"session_id": "v2s", "service_id": "s1", "question_id": "q1", "answer": "A, B"},
            )
        assert bad.status_code == 422
        assert bad.json()["detail"] == "answer_not_in_options"
        assert good.status_code == 200

    def test_number_answer_must_parse(self, db):
        cat = _catalog()
        cat["services"][0]["questions"] = [
            {"id": "q1", "text": "How many?", "type": "number", "options": [], "required": True}
        ]
        client = _make_client(db, email="v3@example.com", api_key="v3")
        bot = _make_bot(db, client.id, bot_key="bot-v3", catalog=cat)
        _make_session(
            db,
            session_id="v3s",
            bot_id=bot.id,
            client_id=client.id,
            need=1,
            budget=1,
            quotation_state={
                "status": "answering",
                "selected_service_ids": ["s1"],
                "current_service_index": 0,
                "answers": {},
                "quantities": {},
            },
        )
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.post(
                "/chat/quotation/answer",
                json={"session_id": "v3s", "service_id": "s1", "question_id": "q1", "answer": "not-a-number"},
            )
        assert res.status_code == 422
        assert res.json()["detail"] == "answer_not_a_number"

    def test_unknown_service_and_question_are_400(self, db):
        client = _make_client(db, email="v4@example.com", api_key="v4")
        bot = _make_bot(db, client.id, bot_key="bot-v4", catalog=_catalog())
        _make_session(
            db,
            session_id="v4s",
            bot_id=bot.id,
            client_id=client.id,
            need=1,
            budget=1,
            quotation_state={
                "status": "answering",
                "selected_service_ids": ["s1"],
                "current_service_index": 0,
                "answers": {},
                "quantities": {},
            },
        )
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            unknown_service = api.post(
                "/chat/quotation/answer",
                json={"session_id": "v4s", "service_id": "nope", "question_id": "q1", "answer": "x"},
            )
            unknown_question = api.post(
                "/chat/quotation/answer",
                json={"session_id": "v4s", "service_id": "s1", "question_id": "nope", "answer": "x"},
            )
        assert unknown_service.status_code == 400
        assert unknown_service.json()["detail"] == "unknown_service"
        assert unknown_question.status_code == 400
        assert unknown_question.json()["detail"] == "unknown_question"

    def test_terminal_state_rejects_further_answers(self, db):
        client = _make_client(db, email="v5@example.com", api_key="v5")
        bot = _make_bot(db, client.id, bot_key="bot-v5", catalog=_catalog())
        _make_session(
            db,
            session_id="v5s",
            bot_id=bot.id,
            client_id=client.id,
            need=1,
            budget=1,
            quotation_state={"status": "complete", "selected_service_ids": ["s1"], "answers": {}, "quantities": {}},
        )
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.post(
                "/chat/quotation/answer",
                json={"session_id": "v5s", "service_id": "s1", "question_id": "q1", "answer": "x"},
            )
        assert res.status_code == 409
        assert res.json()["detail"] == "quotation_already_closed"

    def test_unknown_session_is_404(self, db):
        client = _make_client(db, email="v6@example.com", api_key="v6")
        bot = _make_bot(db, client.id, bot_key="bot-v6", catalog=_catalog())
        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.post(
                "/chat/quotation/select-services",
                json={"session_id": "ghost", "service_ids": ["s1"]},
            )
        assert res.status_code == 404
        assert res.json()["detail"] == "session_not_found"


# ── Admin CRUD ────────────────────────────────────────────────────────────────


class TestAdminCrud:
    def test_get_returns_normalized_default_when_unset(self, db):
        client = _make_client(db, email="a1@example.com", api_key="a1")
        bot = _make_bot(db, client.id, bot_key="bot-a1", catalog=None)
        api = _client_api(_app(), client)
        with _patch_session(db):
            res = api.get(f"/bots/{bot.id}/quotation-catalog")
        assert res.status_code == 200
        body = res.json()
        assert body["enabled"] is False
        assert body["services"] == []

    def test_put_persists_catalog(self, db):
        client = _make_client(db, email="a2@example.com", api_key="a2")
        bot = _make_bot(db, client.id, bot_key="bot-a2", catalog=None)
        api = _client_api(_app(), client)
        with _patch_session(db):
            res = api.put(f"/bots/{bot.id}/quotation-catalog", json=_catalog())
        assert res.status_code == 200
        row = db.execute(select(Bot).where(Bot.id == bot.id)).scalars().first()
        assert row.quotation_catalog["enabled"] is True
        assert row.quotation_catalog["services"][0]["id"] == "s1"

    def test_put_plan_gate_403(self, db, monkeypatch):
        client = _make_client(db, email="a3@example.com", api_key="a3")
        bot = _make_bot(db, client.id, bot_key="bot-a3", catalog=None)
        monkeypatch.setattr(quotation_routes, "_client_plan_allows", lambda *_a, **_k: False)
        api = _client_api(_app(), client)
        with _patch_session(db):
            res = api.put(f"/bots/{bot.id}/quotation-catalog", json=_catalog())
        assert res.status_code == 403
        assert res.json()["detail"] == "plan_upgrade_required"

    def test_cross_tenant_bot_is_404(self, db):
        owner = _make_client(db, email="a4@example.com", api_key="a4")
        other = _make_client(db, email="a4b@example.com", api_key="a4b")
        bot = _make_bot(db, owner.id, bot_key="bot-a4", catalog=_catalog())
        api = _client_api(_app(), other)
        with _patch_session(db):
            res = api.get(f"/bots/{bot.id}/quotation-catalog")
        assert res.status_code == 404


# ── Operator/lead summary ─────────────────────────────────────────────────────


class TestQuotationSummary:
    def test_summary_none_when_no_state(self, db):
        client = _make_client(db, email="s1@example.com", api_key="sum1")
        bot = _make_bot(db, client.id, bot_key="bot-sum1", catalog=_catalog())
        session = _make_session(db, session_id="sum1s", bot_id=bot.id, client_id=client.id)
        assert build_quotation_summary(bot, session) is None

    def test_summary_reports_line_items_and_answers(self, db):
        client = _make_client(db, email="s2@example.com", api_key="sum2")
        bot = _make_bot(db, client.id, bot_key="bot-sum2", catalog=_catalog())
        session = _make_session(
            db,
            session_id="sum2s",
            bot_id=bot.id,
            client_id=client.id,
            quotation_state={
                "status": "complete",
                "selected_service_ids": ["s1"],
                "answers": {"s1": {"q1": "Modern"}},
                "quantities": {"s1": 3},
            },
        )
        summary = build_quotation_summary(bot, session)
        assert summary["currency"] == "INR"
        assert summary["total"] == 300.0
        line = summary["line_items"][0]
        assert line["service_id"] == "s1"
        assert line["quantity"] == 3
        assert line["subtotal"] == 300.0
        assert line["answers"][0] == {
            "question_id": "q1",
            "question_text": "What style?",
            "answer": "Modern",
        }


# ── Completion emails (visitor confirmation + client notification) ─────────────


class TestQuotationEmails:
    """Accepting a quote fires two best-effort emails: a no-pricing confirmation
    to the visitor and an itemized notification to the client's recipients."""

    _QUOTING_STATE = {
        "status": "quoting",
        "selected_service_ids": ["s1"],
        "answers": {"s1": {"q1": "Modern"}},
        "quantities": {"s1": 2},
    }

    @pytest.fixture()
    def _capture_emails(self, monkeypatch):
        calls = {"visitor": [], "client": []}

        def _visitor(*args, **kwargs):
            calls["visitor"].append((args, kwargs))

        def _client(*args, **kwargs):
            calls["client"].append((args, kwargs))

        monkeypatch.setattr(quotation_routes.email_service, "send_quotation_visitor_email", _visitor)
        monkeypatch.setattr(quotation_routes.email_service, "send_quotation_client_email", _client)
        return calls

    def test_accept_sends_both_emails(self, db, _capture_emails):
        client = _make_client(db, email="e1@example.com", api_key="e1")
        bot = _make_bot(
            db,
            client.id,
            bot_key="bot-e1",
            catalog=_catalog(),
            notification_email="owner@acme.com",
            company_name="Acme Co",
        )
        _make_session(
            db,
            session_id="e1s",
            bot_id=bot.id,
            client_id=client.id,
            quotation_state=dict(self._QUOTING_STATE),
        )
        _make_lead(db, session_id="e1s", bot_id=bot.id, email="jason@buyer.com", name="Jason")

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.post("/chat/quotation/accept", json={"session_id": "e1s"})
        assert res.status_code == 200
        assert res.json()["status"] == "complete"

        # Visitor email: sent to the lead, carries service names but NO pricing.
        assert len(_capture_emails["visitor"]) == 1
        v_args, _ = _capture_emails["visitor"][0]
        assert v_args[0] == "jason@buyer.com"
        assert v_args[1] == "Acme Co"
        assert v_args[2] == "Jason"
        assert v_args[3] == ["Landing page"]

        # Client email: sent to the configured recipient with itemized totals.
        assert len(_capture_emails["client"]) == 1
        c_args, c_kwargs = _capture_emails["client"][0]
        assert c_args[0] == "owner@acme.com"
        assert c_args[3] == "INR"  # currency
        assert c_args[4][0]["subtotal"] == 200.0  # line_items
        assert c_args[5] == 200.0  # total
        assert c_kwargs["reply_to"] == "jason@buyer.com"

    def test_no_lead_email_skips_visitor_but_still_notifies_client(self, db, _capture_emails):
        client = _make_client(db, email="e2@example.com", api_key="e2")
        bot = _make_bot(db, client.id, bot_key="bot-e2", catalog=_catalog(), notification_email="owner@acme.com")
        _make_session(
            db, session_id="e2s", bot_id=bot.id, client_id=client.id, quotation_state=dict(self._QUOTING_STATE)
        )
        _make_lead(db, session_id="e2s", bot_id=bot.id, email=None, name="Anon")

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.post("/chat/quotation/accept", json={"session_id": "e2s"})
        assert res.status_code == 200
        assert _capture_emails["visitor"] == []
        assert len(_capture_emails["client"]) == 1

    def test_no_recipients_skips_client_email(self, db, _capture_emails):
        client = _make_client(db, email="e3@example.com", api_key="e3")
        bot = _make_bot(db, client.id, bot_key="bot-e3", catalog=_catalog())  # no notification_email
        _make_session(
            db, session_id="e3s", bot_id=bot.id, client_id=client.id, quotation_state=dict(self._QUOTING_STATE)
        )
        _make_lead(db, session_id="e3s", bot_id=bot.id, email="jason@buyer.com")

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.post("/chat/quotation/accept", json={"session_id": "e3s"})
        assert res.status_code == 200
        assert len(_capture_emails["visitor"]) == 1
        assert _capture_emails["client"] == []

    def test_email_failure_never_breaks_accept(self, db, monkeypatch):
        client = _make_client(db, email="e4@example.com", api_key="e4")
        bot = _make_bot(db, client.id, bot_key="bot-e4", catalog=_catalog(), notification_email="owner@acme.com")
        _make_session(
            db, session_id="e4s", bot_id=bot.id, client_id=client.id, quotation_state=dict(self._QUOTING_STATE)
        )
        _make_lead(db, session_id="e4s", bot_id=bot.id, email="jason@buyer.com")

        def _boom(*_a, **_k):
            raise RuntimeError("brevo down")

        monkeypatch.setattr(quotation_routes.email_service, "send_quotation_visitor_email", _boom)
        monkeypatch.setattr(quotation_routes.email_service, "send_quotation_client_email", _boom)

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.post("/chat/quotation/accept", json={"session_id": "e4s"})
        # Quote is saved; the email blowing up must not fail the request.
        assert res.status_code == 200
        assert res.json()["status"] == "complete"

    def test_terminal_reaccept_does_not_resend(self, db, _capture_emails):
        client = _make_client(db, email="e5@example.com", api_key="e5")
        bot = _make_bot(db, client.id, bot_key="bot-e5", catalog=_catalog(), notification_email="owner@acme.com")
        _make_session(
            db,
            session_id="e5s",
            bot_id=bot.id,
            client_id=client.id,
            quotation_state={**self._QUOTING_STATE, "status": "complete"},
        )
        _make_lead(db, session_id="e5s", bot_id=bot.id, email="jason@buyer.com")

        api = _bot_api(_app(), bot)
        with _patch_session(db):
            res = api.post("/chat/quotation/accept", json={"session_id": "e5s"})
        # Already complete → idempotent return, no duplicate emails.
        assert res.status_code == 200
        assert _capture_emails["visitor"] == []
        assert _capture_emails["client"] == []


class TestQuotationEmailBuilders:
    """Exercise the real HTML builders (only the Brevo dispatch is stubbed) so a
    DSL misuse in the money formatting or the itemized table is caught."""

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

    def test_visitor_email_has_no_pricing(self, _sent):
        from app.services import email_service

        email_service.send_quotation_visitor_email("jason@buyer.com", "Acme Co", "Jason", ["Landing page", "SEO audit"])
        assert len(_sent) == 1
        to, subject, body, _ = _sent[0]
        assert to == "jason@buyer.com"
        assert "Acme Co" in subject
        assert "Landing page" in body and "SEO audit" in body
        # No pricing must leak to the visitor.
        assert "₹" not in body and "200" not in body

    def test_client_email_renders_itemized_total(self, _sent):
        from app.services import email_service

        line_items = [
            {"name": "Landing page", "quantity": 2, "subtotal": 200.0},
            {"name": "SEO audit", "quantity": 1, "subtotal": 49.5},
        ]
        email_service.send_quotation_client_email(
            "owner@acme.com",
            "Quote Bot",
            {"name": "Jason", "email": "jason@buyer.com"},
            "INR",
            line_items,
            249.5,
            reply_to="jason@buyer.com",
        )
        assert len(_sent) == 1
        to, subject, body, kwargs = _sent[0]
        assert to == "owner@acme.com"
        assert "Quote Bot" in subject
        assert "₹200" in body  # whole number, no decimals
        assert "₹49.5" in body  # fractional keeps places
        assert "₹249.5" in body  # total
        assert kwargs.get("reply_to") == "jason@buyer.com"
