"""Phase 5C - language analytics against a real database.

The point of these tests is reconciliation. A breakdown that quietly drops rows
is worse than no breakdown at all: it looks authoritative and disagrees with
the conversation count the customer already trusts. Most of what follows checks
that nothing is silently omitted.
"""

import os
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import analytics_routes
from app.api.analytics_routes import router
from app.db.models import Bot, ChatSession, Client, CreditLedger, Operator

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

MULTILINGUAL_ON = {
    "enabled": True,
    "default_locale": "en-IN",
    "supported_locales": ["en-IN", "hi-IN"],
    "operator_translation_enabled": True,
}


@pytest.fixture(autouse=True)
def _no_limit(monkeypatch):
    from app.core.rate_limit import limiter

    monkeypatch.setattr(limiter, "enabled", False)


@pytest.fixture(autouse=True)
def _no_redis_counters(monkeypatch):
    """Translation activity reads live Redis, which a dev machine usually has.

    Left alone, counters written by a previous test run (or by the developer
    driving the app in a browser) leak in and make assertions about "zero
    translation activity" pass or fail on yesterday's data. Tests that care
    about the counters override this with their own stub.
    """
    monkeypatch.setattr(analytics_routes, "get_metric_counts", lambda *a, **k: {})


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(router)
    return app


def _seed(db, *, language_config=None, api_key="key-acme", email="acme@example.com", bot_key="bot-acme"):
    client = Client(name="Acme", email=email, api_key=api_key, hashed_password="x")
    db.add(client)
    db.flush()
    bot = Bot(
        client_id=client.id,
        name="Acme Bot",
        bot_key=bot_key,
        language_config=MULTILINGUAL_ON if language_config is None else language_config,
    )
    db.add(bot)
    db.flush()
    db.commit()
    return client, bot


def _session(
    db,
    client,
    bot,
    sid,
    *,
    language_code=None,
    resolved=None,
    status="bot",
    operator_id=None,
    created_at=None,
):
    row = ChatSession(
        id=sid,
        client_id=client.id,
        bot_id=bot.id,
        language_code=language_code,
        visitor_resolved=resolved,
        status=status,
        assigned_operator_id=operator_id,
    )
    if created_at is not None:
        row.created_at = created_at
    db.add(row)
    db.flush()
    return row


def _get(bot_id, key="key-acme", **params):
    return TestClient(_app()).get(
        "/analytics/language-breakdown",
        params={"bot_id": bot_id, **params},
        headers={"X-API-Key": key},
    )


# ── Grouping and reconciliation ──────────────────────────────────────────────


class TestLanguageBreakdown:
    def test_groups_conversations_by_language(self, db):
        client, bot = _seed(db)
        for i in range(3):
            _session(db, client, bot, f"hi-{i}", language_code="hi")
        _session(db, client, bot, "en-0", language_code="en")
        db.commit()

        res = _get(bot.id)
        assert res.status_code == 200, res.text
        rows = res.json()["conversations"]
        assert [(r["language_code"], r["total"]) for r in rows] == [("hi", 3), ("en", 1)]

    def test_labels_are_resolved_server_side(self, db):
        client, bot = _seed(db)
        _session(db, client, bot, "s1", language_code="hi")
        db.commit()

        row = _get(bot.id).json()["conversations"][0]
        # A language code originates in a conversation. The client is never
        # asked to map it to a name.
        assert row["label"] == "Hindi"

    def test_null_language_is_reported_not_dropped(self, db):
        """The regression that would make this whole screen untrustworthy.

        Every session recorded before multilingual was enabled has a NULL
        language. Dropping them makes the breakdown disagree with the
        conversation count on the dashboard.
        """
        client, bot = _seed(db)
        _session(db, client, bot, "hi-1", language_code="hi")
        _session(db, client, bot, "old-1")
        _session(db, client, bot, "old-2")
        db.commit()

        body = _get(bot.id).json()
        null_row = next(r for r in body["conversations"] if r["language_code"] is None)
        assert null_row["total"] == 2
        assert null_row["label"] == "Not detected"
        assert body["totals"]["total"] == 3

    def test_totals_reconcile_with_the_rows(self, db):
        client, bot = _seed(db)
        _session(db, client, bot, "a", language_code="hi", resolved=True)
        _session(db, client, bot, "b", language_code="hi", resolved=False)
        _session(db, client, bot, "c", language_code="en", resolved=True)
        _session(db, client, bot, "d")
        db.commit()

        body = _get(bot.id).json()
        rows = body["conversations"]
        assert body["totals"]["total"] == sum(r["total"] for r in rows)
        assert body["totals"]["resolved"] == sum(r["resolved"] for r in rows)
        assert body["totals"]["live_chat"] == sum(r["live_chat"] for r in rows)
        # `languages` counts real languages; the NULL residual is not one.
        assert body["totals"]["languages"] == 2

    def test_unknown_language_code_degrades_to_its_tag(self, db):
        """A locale removed from the catalogue must not erase its history."""
        client, bot = _seed(db)
        _session(db, client, bot, "s1", language_code="xx")
        db.commit()

        row = _get(bot.id).json()["conversations"][0]
        assert row["language_code"] == "xx"
        assert row["label"] == "XX"

    def test_resolution_counts_only_explicit_yes(self, db):
        # `visitor_resolved` is a post-chat answer most visitors never give, so
        # resolved is a subset of total, never `total - unresolved`.
        client, bot = _seed(db)
        _session(db, client, bot, "a", language_code="hi", resolved=True)
        _session(db, client, bot, "b", language_code="hi", resolved=False)
        _session(db, client, bot, "c", language_code="hi", resolved=None)
        db.commit()

        row = _get(bot.id).json()["conversations"][0]
        assert (row["total"], row["resolved"]) == (3, 1)

    def test_live_chat_counts_finished_handoffs(self, db):
        """A closed live chat is still a live chat.

        Keying on the CURRENT status alone would report zero for every
        conversation that has ended, which is most of them.
        """
        client, bot = _seed(db)
        operator = Operator(
            client_id=client.id,
            bot_id=bot.id,
            name="Asha",
            email="asha@example.com",
            operator_api_key="op-key-acme",
            role="owner",
        )
        db.add(operator)
        db.flush()
        _session(db, client, bot, "waiting", language_code="hi", status="waiting")
        _session(db, client, bot, "live", language_code="hi", status="live", operator_id=operator.id)
        _session(db, client, bot, "done", language_code="hi", status="closed", operator_id=operator.id)
        _session(db, client, bot, "botonly", language_code="hi", status="closed")
        db.commit()

        row = _get(bot.id).json()["conversations"][0]
        assert (row["total"], row["live_chat"]) == (4, 3)

    def test_period_narrows_the_window(self, db):
        client, bot = _seed(db)
        _session(db, client, bot, "recent", language_code="hi")
        _session(
            db,
            client,
            bot,
            "old",
            language_code="hi",
            created_at=datetime.now(UTC) - timedelta(days=45),
        )
        db.commit()

        assert _get(bot.id, period="7d").json()["totals"]["total"] == 1
        assert _get(bot.id, period="90d").json()["totals"]["total"] == 2
        assert _get(bot.id, period="all").json()["totals"]["total"] == 2

    def test_rejects_an_unknown_period(self, db):
        _, bot = _seed(db)
        assert _get(bot.id, period="everything").status_code == 422


# ── Empty and disabled states ────────────────────────────────────────────────


class TestEmptyStates:
    def test_a_bot_with_no_conversations_returns_empty_not_an_error(self, db):
        _, bot = _seed(db)
        res = _get(bot.id)
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["conversations"] == []
        assert body["totals"]["total"] == 0
        assert body["cost"]["credits"] == 0

    def test_reports_whether_multilingual_is_on(self, db):
        """The client hides the card on this, so it is resolved server-side."""
        _, off = _seed(
            db, language_config={"enabled": False}, api_key="key-off", email="off@example.com", bot_key="bot-off"
        )
        body = _get(off.id, key="key-off").json()
        assert body["multilingual_enabled"] is False
        assert body["operator_translation_enabled"] is False

    def test_translation_flag_requires_multilingual(self, db):
        _, bot = _seed(
            db,
            language_config={"enabled": False, "operator_translation_enabled": True},
            api_key="key-x",
            email="x@example.com",
            bot_key="bot-x",
        )
        assert _get(bot.id, key="key-x").json()["operator_translation_enabled"] is False

    def test_a_bot_with_no_language_config_is_reported_off(self, db):
        _, bot = _seed(db, language_config={}, api_key="key-n", email="n@example.com", bot_key="bot-n")
        assert _get(bot.id, key="key-n").json()["multilingual_enabled"] is False


# ── Tenant isolation ─────────────────────────────────────────────────────────


class TestTenantIsolation:
    def test_another_workspaces_bot_is_a_404(self, db):
        _seed(db)
        _seed(db, api_key="key-evil", email="evil@example.com", bot_key="bot-evil")
        mine = db.query(Bot).filter(Bot.bot_key == "bot-acme").one()

        assert _get(mine.id, key="key-evil").status_code == 404

    def test_never_counts_another_workspaces_sessions(self, db):
        client, bot = _seed(db)
        other_client, other_bot = _seed(db, api_key="key-other", email="other@example.com", bot_key="bot-other")
        _session(db, client, bot, "mine", language_code="hi")
        _session(db, other_client, other_bot, "theirs", language_code="hi")
        _session(db, other_client, other_bot, "theirs-2", language_code="hi")
        db.commit()

        assert _get(bot.id).json()["totals"]["total"] == 1
        assert _get(other_bot.id, key="key-other").json()["totals"]["total"] == 2

    def test_cost_never_includes_another_workspaces_ledger(self, db):
        client, bot = _seed(db)
        other_client, other_bot = _seed(db, api_key="key-other", email="other@example.com", bot_key="bot-other")
        db.add(CreditLedger(client_id=client.id, delta=-5, reason="translation", attributed_bot_id=bot.id))
        db.add(
            CreditLedger(
                client_id=other_client.id,
                delta=-99,
                reason="translation",
                attributed_bot_id=other_bot.id,
            )
        )
        db.commit()

        assert _get(bot.id).json()["cost"]["credits"] == 5

    def test_requires_authentication(self, db):
        _, bot = _seed(db)
        res = TestClient(_app()).get("/analytics/language-breakdown", params={"bot_id": bot.id})
        assert res.status_code in (401, 403)


# ── Translation: rolling activity vs durable cost ────────────────────────────


class TestTranslationMetrics:
    def test_activity_aggregates_the_rolling_counters(self, db, monkeypatch):
        client, bot = _seed(db)
        db.commit()

        # Two hourly buckets, to prove they are summed rather than sampled.
        def fake_counts(name, bot_id=None, hours=24):
            return {"2026082410": 10, "2026082411": 5} if name == "translation_requests" else {"2026082410": 2}

        monkeypatch.setattr(analytics_routes, "get_metric_counts", fake_counts)

        activity = _get(bot.id).json()["translation"]
        assert activity["requests"] == 15
        assert activity["ok"] == 2
        assert activity["failed"] == 2
        assert activity["timeout"] == 2

    def test_activity_states_its_window(self, db, monkeypatch):
        """It is a rolling window, and the response has to say so.

        The counters expire at ~26h, so this can never be read as history.
        """
        _, bot = _seed(db)
        db.commit()
        assert _get(bot.id).json()["translation"]["window_hours"] == 24

    def test_activity_never_reports_tokens(self, db):
        # `translation_tokens_*` are incremented with no bot_id, so they exist
        # only at global scope. Reporting the platform-wide figure on a
        # per-bot screen would be worse than reporting nothing.
        _, bot = _seed(db)
        db.commit()
        activity = _get(bot.id).json()["translation"]
        assert "tokens_prompt" not in activity
        assert "tokens_completion" not in activity

    def test_redis_being_down_yields_zeros_not_an_error(self, db, monkeypatch):
        _, bot = _seed(db)
        db.commit()
        monkeypatch.setattr(analytics_routes, "get_metric_counts", lambda *a, **k: {})

        res = _get(bot.id)
        assert res.status_code == 200
        assert res.json()["translation"]["requests"] == 0

    def test_cost_is_durable_and_comes_from_the_ledger(self, db):
        client, bot = _seed(db)
        for delta in (-1, -1, -3):
            db.add(CreditLedger(client_id=client.id, delta=delta, reason="translation", attributed_bot_id=bot.id))
        db.commit()

        assert _get(bot.id).json()["cost"]["credits"] == 5

    def test_cost_ignores_other_reasons(self, db):
        client, bot = _seed(db)
        db.add(CreditLedger(client_id=client.id, delta=-7, reason="ai_chat", attributed_bot_id=bot.id))
        db.add(CreditLedger(client_id=client.id, delta=-2, reason="translation", attributed_bot_id=bot.id))
        db.commit()

        assert _get(bot.id).json()["cost"]["credits"] == 2

    def test_cost_ignores_grants(self, db):
        # Deductions are negative deltas. A positive grant row must never be
        # summed into "what translation cost me".
        client, bot = _seed(db)
        db.add(CreditLedger(client_id=client.id, delta=100, reason="translation", attributed_bot_id=bot.id))
        db.add(CreditLedger(client_id=client.id, delta=-4, reason="translation", attributed_bot_id=bot.id))
        db.commit()

        assert _get(bot.id).json()["cost"]["credits"] == 4

    def test_cost_is_scoped_to_the_period(self, db):
        client, bot = _seed(db)
        recent = CreditLedger(client_id=client.id, delta=-2, reason="translation", attributed_bot_id=bot.id)
        db.add(recent)
        old = CreditLedger(client_id=client.id, delta=-40, reason="translation", attributed_bot_id=bot.id)
        old.created_at = datetime.now(UTC) - timedelta(days=60)
        db.add(old)
        db.commit()

        assert _get(bot.id, period="30d").json()["cost"]["credits"] == 2
        assert _get(bot.id, period="all").json()["cost"]["credits"] == 42

    def test_cost_uses_attributed_bot_not_the_balance_scope(self, db):
        """`bot_id` on the ledger is the BALANCE scope and is NULL for pooled
        workspaces. Grouping cost by it would report zero for most customers."""
        client, bot = _seed(db)
        db.add(
            CreditLedger(
                client_id=client.id,
                delta=-6,
                reason="translation",
                bot_id=None,
                attributed_bot_id=bot.id,
            )
        )
        db.commit()

        assert _get(bot.id).json()["cost"]["credits"] == 6
