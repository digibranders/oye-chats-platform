"""Four writable bot capabilities, and the traps in each.

1. ``is_active`` — the pause switch. It is the *billing* key rather than a
   visibility flag (``plan_entitlements_service`` counts only active bots), so
   the false→true direction has to be charged the same admission price a create
   pays or pausing becomes a quota bypass.
2/3. The live-chat disconnect timeouts and the follow-up pause. Cheap fields,
   but ``bot_routes`` has two independent ``BotResponse`` construction sites and
   forgetting the second is this module's standing drift hazard, so every field
   is asserted through BOTH ``GET /bots/{id}`` and ``GET /bots``.
4. The widget-liveness heartbeat, whose whole design constraint is write
   amplification: ``GET /bots/settings/public`` runs on every page view of every
   customer site.

DB-backed tests use the shared real-Postgres fixtures and skip without
``DB_URL``; the rest drive the routes over mocked sessions in the style of
``test_bot_routes.py``.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api.auth import (
    get_current_bot,
    get_current_client_or_operator,
    require_active_subscription_for_workspace,
    require_verified_email_for_workspace,
)
from app.api.bot_routes import public_router, router


@contextmanager
def _session_ctx(session):
    yield session


def _build_app(auth_override=None, bot_override=None):
    app = FastAPI()
    app.include_router(public_router)
    app.include_router(router)
    if auth_override:
        app.dependency_overrides[get_current_client_or_operator] = lambda: auth_override
    if bot_override:
        app.dependency_overrides[get_current_bot] = lambda: bot_override
    app.dependency_overrides[require_active_subscription_for_workspace] = lambda: None
    app.dependency_overrides[require_verified_email_for_workspace] = lambda: None
    return app


def _client_auth(client_id=1, impersonator_id=None):
    entity = SimpleNamespace(id=client_id)
    if impersonator_id is not None:
        entity._impersonator_id = impersonator_id
    return {"type": "client", "entity": entity, "client_id": client_id, "operator_id": None}


class _ScalarResult:
    def __init__(self, value):
        self._value = value

    def first(self):
        return self._value

    def all(self):
        return self._value if isinstance(self._value, list) else [self._value] if self._value else []


class _ExecuteResult:
    def __init__(self, value):
        self._value = value

    def scalars(self):
        return _ScalarResult(self._value)


# ── 1. Pause / resume (real Postgres) ────────────────────────────────────────

pg = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@pytest.fixture()
def _no_entitlements_cache(monkeypatch):
    """Read live DB state, not a 60s-cached entitlements snapshot."""
    from app.services import plan_entitlements_service as ent

    monkeypatch.setattr(ent, "get_redis", lambda: None)


def _mk_client(db, email):
    from app.db.models import Client

    row = Client(name="c", email=email, api_key=email, hashed_password="h")
    db.add(row)
    db.flush()
    return row


def _mk_bot(db, client, key, **kw):
    from app.db.models import Bot

    bot = Bot(client_id=client.id, bot_key=key, name="Agent", **kw)
    db.add(bot)
    db.flush()
    return bot


def _mk_plan(db, slug, *, bots_limit):
    from app.db.models import Plan

    plan = Plan(
        name=slug.title(),
        slug=slug,
        monthly_price_cents=44900,
        credits_per_month=1000,
        included_operator_seats=1,
        is_active=True,
        features={},
        limits={"bots": bots_limit},
    )
    db.add(plan)
    db.flush()
    return plan


def _db_app(db, monkeypatch, client_id, *, impersonator_id=None):
    from app.api import bot_routes

    monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(db))
    return TestClient(_build_app(auth_override=_client_auth(client_id, impersonator_id)))


@pg
def test_pausing_frees_the_billing_slot_but_resuming_cannot_reclaim_it(db, monkeypatch, _no_entitlements_cache):
    """The bypass, end to end, and where it now stops.

    Free workspace, one funded bot. Creating a second is refused. Pausing the
    first drops ``usage["bots"]`` to zero, so the create gate — which counts
    only ACTIVE bots — now lets a second one through. That part is unchanged and
    intended: the create gate lives in ``plan_entitlements_service`` and asks
    "how many bots are serving right now", which is a true zero.

    The exploit was the *third* step: resume the first bot and end up with two
    serving chatbots on one funding. That step is now a 402, so the invariant
    the money depends on — never more active bots than the account funds — holds
    on every path.
    """
    client = _mk_client(db, "pause-chain@e.com")
    first = _mk_bot(db, client, "bot-first", website="https://first.example")
    db.flush()
    tc = _db_app(db, monkeypatch, client.id)

    # Baseline: a second bot on Free is refused.
    denied = tc.post("/bots", json={"name": "Second", "website": "https://second.example"})
    assert denied.status_code == 402
    assert denied.json()["detail"]["error"] == "upgrade_required"

    # Pause the first bot.
    assert tc.patch(f"/bots/{first.id}", json={"is_active": False}).status_code == 200
    db.refresh(first)
    assert first.is_active is False

    # The create gate counts active bots, so the slot really is free now.
    created = tc.post("/bots", json={"name": "Second", "website": "https://second.example"})
    assert created.status_code == 201

    # ...and this is the step that used to hand out a second funded chatbot.
    resumed = tc.patch(f"/bots/{first.id}", json={"is_active": True})
    assert resumed.status_code == 402
    detail = resumed.json()["detail"]
    assert detail["error"] == "upgrade_required"
    assert detail["metric"] == "bots"
    assert detail["must_subscribe"] is True
    assert detail["active_bot_count"] == 1

    db.refresh(first)
    assert first.is_active is False, "a refused reactivation must not write the flag"

    from sqlalchemy import func, select

    from app.db.models import Bot

    active = db.execute(
        select(func.count(Bot.id)).where(Bot.client_id == client.id, Bot.is_active.is_(True))
    ).scalar_one()
    assert active == 1, "one funding, one serving chatbot, on every path"


@pg
def test_resume_is_allowed_when_no_other_bot_is_active(db, monkeypatch, _no_entitlements_cache):
    """The ordinary case must not be collateral damage: an account whose only
    bot is paused can always turn it back on."""
    client = _mk_client(db, "solo-pause@e.com")
    bot = _mk_bot(db, client, "bot-solo", is_active=False)
    db.flush()
    tc = _db_app(db, monkeypatch, client.id)

    assert tc.patch(f"/bots/{bot.id}", json={"is_active": True}).status_code == 200
    db.refresh(bot)
    assert bot.is_active is True


@pg
def test_resume_bypasses_the_gate_for_a_bot_with_its_own_live_subscription(db, monkeypatch, _no_entitlements_cache):
    """A chatbot funded by its own subscription is already paid for.

    ``can_client_add_new_bot`` would refuse (a sibling bot is active), and the
    plan's ``limits.bots`` of 1 does not widen. Only the per-bot subscription
    clause lets this through — which is the whole point of per-bot billing.
    """
    from app.db.models import Subscription

    client = _mk_client(db, "own-sub@e.com")
    plan = _mk_plan(db, "standard-pause", bots_limit=1)
    sibling = _mk_bot(db, client, "bot-sibling")
    paused = _mk_bot(db, client, "bot-paid", is_active=False)
    sub = Subscription(client_id=client.id, plan_id=plan.id, bot_id=paused.id, status="active")
    db.add(sub)
    db.flush()
    paused.subscription_id = sub.id
    db.flush()
    assert sibling.is_active is True

    tc = _db_app(db, monkeypatch, client.id)
    assert tc.patch(f"/bots/{paused.id}", json={"is_active": True}).status_code == 200
    db.refresh(paused)
    assert paused.is_active is True


@pg
def test_a_pooled_bot_cannot_short_circuit_on_the_account_subscription(db, monkeypatch, _no_entitlements_cache):
    """The short-circuit must key on the subscription's ``bot_id``, not on the FK
    merely being populated.

    Legacy / pooled bots carry a COPY of the client-level subscription id (the
    Phase 2 backfill), while that subscription has ``bot_id IS NULL`` because
    it funds the workspace, not this chatbot. ``delete_bot`` and
    ``credit_service.resolve_bot_ledger_bot_id`` both re-validate the stamp for
    exactly this reason.

    Trusting it here would short-circuit the gate for EVERY bot on a pooled
    account, restoring the whole bypass: pause A, create B, resume A.
    """
    from app.db.models import Subscription

    client = _mk_client(db, "pooled-stamp@e.com")
    plan = _mk_plan(db, "standard-pooled", bots_limit=1)
    account_sub = Subscription(client_id=client.id, plan_id=plan.id, bot_id=None, status="active")
    db.add(account_sub)
    db.flush()

    serving = _mk_bot(db, client, "bot-pooled-live")
    paused = _mk_bot(db, client, "bot-pooled-paused", is_active=False)
    # The backfill shape: the client-level id stamped onto every bot.
    serving.subscription_id = account_sub.id
    paused.subscription_id = account_sub.id
    db.flush()
    assert account_sub.bot_id is None

    tc = _db_app(db, monkeypatch, client.id)
    refused = tc.patch(f"/bots/{paused.id}", json={"is_active": True})
    assert refused.status_code == 402, "a pooled bot must go through the full gate, not around it"
    assert refused.json()["detail"]["error"] == "upgrade_required"
    db.refresh(paused)
    assert paused.is_active is False


@pg
def test_a_pooled_bot_on_an_unlimited_plan_still_resumes(db, monkeypatch, _no_entitlements_cache):
    """The other half of that decision. Sending pooled bots through the full
    gate is not a penalty: ``_plan_bots_limit_allows`` reads ``limits.bots``, so
    the pooled account whose plan genuinely funds unlimited agents is allowed,
    and only the one whose single slot is already serving is refused."""
    from app.db.models import Subscription

    client = _mk_client(db, "pooled-unlimited@e.com")
    plan = _mk_plan(db, "enterprise-pooled", bots_limit=-1)
    account_sub = Subscription(client_id=client.id, plan_id=plan.id, bot_id=None, status="active")
    db.add(account_sub)
    db.flush()

    serving = _mk_bot(db, client, "bot-pooled-ent-live")
    paused = _mk_bot(db, client, "bot-pooled-ent-paused", is_active=False)
    serving.subscription_id = account_sub.id
    paused.subscription_id = account_sub.id
    db.flush()

    tc = _db_app(db, monkeypatch, client.id)
    assert tc.patch(f"/bots/{paused.id}", json={"is_active": True}).status_code == 200
    db.refresh(paused)
    assert paused.is_active is True


@pg
def test_the_reactivation_gate_takes_a_workspace_lock_before_counting(db, monkeypatch, _no_entitlements_cache):
    """``can_client_add_new_bot`` is a plain ``SELECT count(*)``. Two concurrent
    ``PATCH {"is_active": true}`` on two different paused bots would both read
    ``active_bot_count = 0`` and both commit, handing out two serving chatbots
    on one funding — the same over-allocation the gate exists to prevent, just
    reached by timing instead of by sequence.

    Racing two real transactions inside the shared single-session fixture is not
    possible here, so this asserts the property that makes the race impossible:
    the gate acquires a row-level lock on the workspace BEFORE it counts. The
    sibling seat gate (``invite_service._require_seat_available``) does the same
    thing with the same helper.
    """
    from app.api import bot_routes
    from app.services import plan_entitlements_service as ent

    client = _mk_client(db, "gate-lock@e.com")
    bot = _mk_bot(db, client, "bot-gate-lock", is_active=False)
    db.flush()

    order: list[str] = []
    real_lock = bot_routes._lock_workspace_for_bot_admission
    real_count = ent.can_client_add_new_bot

    def _tracked_lock(session, client_id):
        order.append(f"lock:{client_id}")
        return real_lock(session, client_id)

    def _tracked_count(client_id, session):
        order.append(f"count:{client_id}")
        return real_count(client_id, session)

    monkeypatch.setattr(bot_routes, "_lock_workspace_for_bot_admission", _tracked_lock)
    monkeypatch.setattr(ent, "can_client_add_new_bot", _tracked_count)

    tc = _db_app(db, monkeypatch, client.id)
    assert tc.patch(f"/bots/{bot.id}", json={"is_active": True}).status_code == 200

    assert order == [f"lock:{client.id}", f"count:{client.id}"], (
        "the workspace lock must be acquired before the active-bot count is read"
    )


@pg
def test_the_workspace_lock_falls_back_to_the_client_row(db):
    """``_lock_active_subscription_for_workspace`` returns ``None`` for a
    workspace with no live subscription — which is the Free account, exactly
    where the one-bot limit bites and therefore exactly where the race matters.
    Falling back to the ``Client`` row (the one row every workspace is
    guaranteed to have) is what keeps those serialized.

    ``SELECT ... FOR UPDATE`` takes a ``RowShareLock`` on the table, so the
    lock is observable in ``pg_locks``. Scoped to this backend's own pid,
    because ``pg_locks`` is cluster-wide and a parallel test session holding
    the same lock would otherwise make this pass for the wrong reason.
    """
    from sqlalchemy import text

    from app.api import bot_routes

    client = _mk_client(db, "lock-fallback@e.com")
    db.flush()

    def _row_share_locks_on_clients() -> int:
        return db.execute(
            text(
                "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation "
                "WHERE c.relname = 'clients' AND l.mode = 'RowShareLock' AND l.pid = pg_backend_pid()"
            )
        ).scalar_one()

    before = _row_share_locks_on_clients()
    bot_routes._lock_workspace_for_bot_admission(db, client.id)
    assert _row_share_locks_on_clients() > before, "a workspace with no subscription must still be locked"


@pg
def test_resume_is_refused_when_the_bots_own_subscription_is_dead(db, monkeypatch, _no_entitlements_cache):
    """A canceled subscription funds nothing. The bypass must key on the
    subscription's STATUS, not merely on the FK being populated."""
    from app.db.models import Subscription

    client = _mk_client(db, "dead-sub@e.com")
    plan = _mk_plan(db, "standard-dead", bots_limit=1)
    _mk_bot(db, client, "bot-live-sibling")
    paused = _mk_bot(db, client, "bot-dead-sub", is_active=False)
    sub = Subscription(client_id=client.id, plan_id=plan.id, bot_id=paused.id, status="canceled")
    db.add(sub)
    db.flush()
    paused.subscription_id = sub.id
    db.flush()

    tc = _db_app(db, monkeypatch, client.id)
    assert tc.patch(f"/bots/{paused.id}", json={"is_active": True}).status_code == 402


@pg
def test_unlimited_plan_can_resume_freely(db, monkeypatch, _no_entitlements_cache):
    """The reason ``_plan_bots_limit_allows`` has to be in the composition.

    ``can_client_add_new_bot`` answers ``must_subscribe`` on an unlimited-agents
    plan too — it is deliberately blind to ``limits.bots``. Gating reactivation
    on that service alone would tell an Enterprise customer to buy a
    subscription for an agent their plan already includes.
    """
    from app.db.models import Subscription

    client = _mk_client(db, "unlimited-pause@e.com")
    plan = _mk_plan(db, "enterprise-pause", bots_limit=-1)
    sub = Subscription(client_id=client.id, plan_id=plan.id, bot_id=None, status="active")
    db.add(sub)
    db.flush()
    _mk_bot(db, client, "bot-ent-1")
    _mk_bot(db, client, "bot-ent-2")
    paused = _mk_bot(db, client, "bot-ent-3", is_active=False)
    db.flush()

    tc = _db_app(db, monkeypatch, client.id)
    assert tc.patch(f"/bots/{paused.id}", json={"is_active": True}).status_code == 200
    db.refresh(paused)
    assert paused.is_active is True


@pg
def test_pausing_invalidates_the_entitlements_cache(db, monkeypatch):
    """The usage meter is cached for 60s. Without an explicit invalidation a
    paused bot keeps being counted, and the create gate reads the same stale
    number it was just told to stop trusting."""
    from app.services import plan_entitlements_service as ent

    client = _mk_client(db, "cache-drop@e.com")
    bot = _mk_bot(db, client, "bot-cache-drop")
    db.flush()

    invalidated: list[int] = []
    monkeypatch.setattr(ent, "invalidate", invalidated.append)
    tc = _db_app(db, monkeypatch, client.id)

    assert tc.patch(f"/bots/{bot.id}", json={"is_active": False}).status_code == 200
    assert invalidated == [client.id]

    # A no-op write (already false) must not churn the cache.
    invalidated.clear()
    assert tc.patch(f"/bots/{bot.id}", json={"is_active": False}).status_code == 200
    assert invalidated == []


# ── 1b. Pause / resume (mocked session) ──────────────────────────────────────


def _patchable_bot(**overrides):
    bot = SimpleNamespace(
        id=5,
        client_id=1,
        bot_key="bot-xyz",
        name="Bot",
        is_active=True,
        subscription_id=None,
        feature_flags={},
        widget_messages={},
        widget_config={},
        bant_config=None,
        manual_field_overrides=[],
    )
    for key, value in overrides.items():
        setattr(bot, key, value)
    return bot


class TestImpersonationGuard:
    def test_impersonated_patch_with_is_active_is_refused(self, monkeypatch):
        """A support session must not be able to switch a customer's widget off
        (their site loses support) or back on (a billing admission decision)."""
        from app.api import bot_routes

        bot = _patchable_bot()
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        with patch("app.api.bot_routes.cache_delete"):
            tc = TestClient(_build_app(auth_override=_client_auth(impersonator_id=99)))
            response = tc.patch("/bots/5", json={"is_active": False})

        assert response.status_code == 403
        assert response.json()["detail"]["error"] == "impersonation_read_only"
        assert "is_active" in response.json()["detail"]["message"]
        assert bot.is_active is True

    def test_impersonated_patch_of_ordinary_config_still_works(self, monkeypatch):
        """The guard is a field denylist, not a route lock."""
        from app.api import bot_routes

        bot = _patchable_bot()
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        with patch("app.api.bot_routes.cache_delete"):
            tc = TestClient(_build_app(auth_override=_client_auth(impersonator_id=99)))
            response = tc.patch("/bots/5", json={"name": "Renamed"})

        assert response.status_code == 200
        assert bot.name == "Renamed"


class TestPauseCacheInvalidation:
    def test_pausing_drops_the_bot_config_cache(self, monkeypatch):
        """The widget serves from a 10-minute bot-config cache. A pause that
        doesn't drop it is a pause the visitor doesn't see."""
        from app.api import bot_routes

        bot = _patchable_bot()
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))
        monkeypatch.setattr(bot_routes, "get_redis", lambda: None)

        with patch("app.api.bot_routes.cache_delete") as mock_delete:
            tc = TestClient(_build_app(auth_override=_client_auth()))
            response = tc.patch("/bots/5", json={"is_active": False})

        assert response.status_code == 200
        assert bot.is_active is False
        mock_delete.assert_called_once_with("oyechats:bot:bot-xyz")


# ── 2 & 3. Timeouts + follow-up pause ────────────────────────────────────────


class TestTimeoutSchema:
    @pytest.mark.parametrize("value", [5, 60, 120, 3600])
    def test_in_range_accepted(self, value):
        from app.api.bot_routes import UpdateBotRequest

        assert UpdateBotRequest(visitor_disconnect_timeout=value).dict(exclude_unset=True) == {
            "visitor_disconnect_timeout": value
        }

    @pytest.mark.parametrize("value", [4, 0, -1, 3601])
    def test_out_of_range_rejected(self, value):
        from app.api.bot_routes import UpdateBotRequest

        with pytest.raises(ValidationError):
            UpdateBotRequest(visitor_disconnect_timeout=value)

    def test_bounds_match_operator_timeout_seconds(self):
        """The live-chat timers share one range on purpose. If somebody widens
        one, this says the other was meant to move too."""
        from app.api.bot_routes import UpdateBotRequest

        def _bounds(name):
            meta = UpdateBotRequest.model_fields[name].metadata
            return (
                next(m.ge for m in meta if hasattr(m, "ge")),
                next(m.le for m in meta if hasattr(m, "le")),
            )

        assert _bounds("visitor_disconnect_timeout") == _bounds("operator_timeout_seconds")


class TestInertControlsAreNotShipped:
    """``operator_disconnect_timeout`` is a real column with a real default that
    ``live_chat_service._operator_disconnect_timeout`` never reads -- it sleeps
    ``DEFAULT_OPERATOR_DISCONNECT_TIMEOUT`` unconditionally. Exposing it would
    put a control that does nothing next to ``visitor_disconnect_timeout``,
    which does. Until the service reads the column, neither schema carries it.

    Delete this class in the same change that wires the service up.
    """

    def test_the_service_still_ignores_the_column(self):
        """The premise. If this fails the field can (and should) come back."""
        import inspect

        from app.services.live_chat_service import ConnectionManager

        source = inspect.getsource(ConnectionManager._operator_disconnect_timeout)
        assert "operator_disconnect_timeout" not in source.replace("_operator_disconnect_timeout", "")
        assert "DEFAULT_OPERATOR_DISCONNECT_TIMEOUT" in source

    def test_the_request_schema_does_not_accept_it(self):
        from app.api.bot_routes import UpdateBotRequest

        assert "operator_disconnect_timeout" not in UpdateBotRequest.model_fields
        # Pydantic ignores unknown keys here, so the point is that the value is
        # dropped rather than persisted: nothing reaches ``update_data``.
        assert UpdateBotRequest(operator_disconnect_timeout=45).dict(exclude_unset=True) == {}

    def test_the_response_schema_does_not_publish_it(self):
        from app.api.bot_routes import BotResponse

        assert "operator_disconnect_timeout" not in BotResponse.model_fields


class TestTimeoutPatch:
    def test_patch_writes_the_new_fields(self, monkeypatch):
        from app.api import bot_routes

        bot = _patchable_bot(
            visitor_disconnect_timeout=120,
            operator_disconnect_timeout=60,
            followup_sending_paused=False,
        )
        session = MagicMock()
        session.execute.return_value = _ExecuteResult(bot)
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        with patch("app.api.bot_routes.cache_delete"):
            tc = TestClient(_build_app(auth_override=_client_auth()))
            response = tc.patch(
                "/bots/5",
                json={
                    "visitor_disconnect_timeout": 300,
                    "operator_disconnect_timeout": 45,
                    "followup_sending_paused": True,
                },
            )

        assert response.status_code == 200
        assert bot.visitor_disconnect_timeout == 300
        assert bot.followup_sending_paused is True
        # The unwired field is dropped by the schema, not written through.
        assert bot.operator_disconnect_timeout == 60

    @pytest.mark.parametrize("value", [4, 3601])
    def test_patch_422s_out_of_range(self, monkeypatch, value):
        from app.api import bot_routes

        session = MagicMock()
        session.execute.return_value = _ExecuteResult(_patchable_bot())
        monkeypatch.setattr(bot_routes, "get_session", lambda: _session_ctx(session))

        with patch("app.api.bot_routes.cache_delete"):
            tc = TestClient(_build_app(auth_override=_client_auth()))
            response = tc.patch("/bots/5", json={"visitor_disconnect_timeout": value})

        assert response.status_code == 422


@pg
class TestBothSerializersEchoTheNewFields:
    """``bot_routes`` builds ``BotResponse`` in two places — ``_bot_to_response``
    and a hand-written copy inside ``list_bots`` — and only the first is obvious.
    Every new field is therefore checked through both endpoints."""

    def _setup(self, db, monkeypatch):
        client = _mk_client(db, "serializers@e.com")
        bot = _mk_bot(
            db,
            client,
            "bot-serialize",
            visitor_disconnect_timeout=300,
            operator_disconnect_timeout=45,
            followup_sending_paused=True,
            widget_installed_at=datetime(2026, 6, 1, tzinfo=UTC),
            widget_last_seen_at=datetime(2026, 8, 1, 9, 30, tzinfo=UTC),
            widget_last_origin="shop.acme.com",
        )
        db.flush()
        return client, bot, _db_app(db, monkeypatch, client.id)

    def _assert_payload(self, payload):
        assert payload["visitor_disconnect_timeout"] == 300
        assert payload["followup_sending_paused"] is True
        # Not published while ``live_chat_service`` ignores the column.
        assert "operator_disconnect_timeout" not in payload
        assert payload["widget_last_origin"] == "shop.acme.com"
        assert payload["widget_last_seen_at"].startswith("2026-08-01T09:30")

    def test_get_one_bot_echoes_them(self, db, monkeypatch, _no_entitlements_cache):
        _client, bot, tc = self._setup(db, monkeypatch)
        response = tc.get(f"/bots/{bot.id}")
        assert response.status_code == 200
        self._assert_payload(response.json())

    def test_list_bots_echoes_them(self, db, monkeypatch, _no_entitlements_cache):
        _client, _bot, tc = self._setup(db, monkeypatch)
        response = tc.get("/bots")
        assert response.status_code == 200
        rows = response.json()
        assert len(rows) == 1
        self._assert_payload(rows[0])


# ── 4. Widget install heartbeat ──────────────────────────────────────────────


class _FakeRedis:
    """Just enough Redis for ``SET key value [NX] [EX ttl]`` and ``GET key``.

    The real client is built with ``decode_responses=True``, so ``get``
    returns ``str`` rather than ``bytes`` — which is what makes the
    hostname comparison in ``_widget_heartbeat_due`` work.
    """

    def __init__(self):
        self.store: dict[str, str] = {}
        self.expiries: dict[str, int] = {}

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.store:
            return None
        self.store[key] = value
        if ex is not None:
            self.expiries[key] = ex
        return True

    def get(self, key):
        return self.store.get(key)


def _widget_bot(**overrides):
    """A cached-config-shaped bot for the public settings endpoint."""
    bot = MagicMock()
    bot.id = 5
    bot.client_id = 1
    bot.bot_key = "bot-heartbeat"
    bot.widget_installed_at = datetime(2026, 6, 1, tzinfo=UTC)
    bot.primary_color = "#4F46E5"
    bot.background_color = "#FFF"
    bot.header_color = "#4F46E5"
    bot.user_bubble_color = None
    bot.welcome_title = "Hello"
    bot.welcome_subtitle = "Ask anything"
    bot.bot_logo = None
    bot.launcher_logo = None
    bot.launcher_name = None
    bot.feature_flags = {}
    bot.widget_messages = {}
    bot.widget_config = {}
    bot.bant_enabled = False
    bot.bant_config = None
    bot.lead_form_enabled = False
    bot.lead_form_fields = None
    bot.live_chat_enabled = False
    bot.branding_text = None
    bot.branding_url = None
    bot.recommended_colors = None
    bot.offline_message = None
    bot.waiting_message = None
    bot.handoff_delay_seconds = None
    bot.meeting_booking_enabled = False
    bot.calendly_url = None
    for key, value in overrides.items():
        setattr(bot, key, value)
    return bot


def _widget_request(origin="https://acme.com"):
    request = MagicMock()
    request.base_url = "http://test/"
    request.headers = {"origin": origin} if origin else {}
    return request


class _WidgetHarness:
    """Counts the row writes one bootstrap performs."""

    def __init__(self, monkeypatch, redis):
        from app.api import bot_routes as br

        self.session = MagicMock()
        self.br = br
        monkeypatch.setattr(br, "get_session", lambda: _session_ctx(self.session))
        monkeypatch.setattr(br, "get_redis", lambda: redis)
        monkeypatch.setattr(br, "cache_delete", lambda key: True)

    @property
    def writes(self) -> int:
        return self.session.execute.call_count

    def bootstrap(self, bot, request):
        with (
            patch.object(self.br, "_build_public_cta_options", return_value={}),
            patch.object(self.br, "bot_subscription_status", return_value="active"),
            patch("app.db.session.get_session", lambda: _session_ctx(MagicMock())),
            patch("app.services.plan_entitlements_service.get_bot_entitlements", side_effect=RuntimeError),
        ):
            return self.br.get_bot_settings_public(request, bot)


class TestWidgetHeartbeat:
    def test_two_bootstraps_from_one_origin_write_once(self, monkeypatch):
        """The write-amplification test. ``/bots/settings/public`` runs on every
        page view of every customer site; the Redis NX key is what stops that
        becoming one row write per page view."""
        redis = _FakeRedis()
        harness = _WidgetHarness(monkeypatch, redis)
        bot = _widget_bot()

        harness.bootstrap(bot, _widget_request())
        assert harness.writes == 1
        harness.bootstrap(bot, _widget_request())
        assert harness.writes == 1, "second page view within the hour must not touch the row"

        # Per-BOT key. The hostname is the VALUE, never part of the key name.
        assert list(redis.store) == ["oyechats:widget:seen:5"]
        assert redis.store["oyechats:widget:seen:5"] == "acme.com"
        assert redis.expiries["oyechats:widget:seen:5"] == 3600

    def test_a_new_origin_is_recorded_without_waiting_out_the_hour(self, monkeypatch):
        """A genuine domain change still shows up on the next page load rather
        than an hour later, which is the entire value of ``widget_last_origin``
        to a support ticket. It is paid for out of a single per-bot per-hour
        allowance rather than out of a per-origin throttle key."""
        redis = _FakeRedis()
        harness = _WidgetHarness(monkeypatch, redis)
        bot = _widget_bot()

        harness.bootstrap(bot, _widget_request("https://acme.com"))
        harness.bootstrap(bot, _widget_request("https://shop.acme.com"))
        assert harness.writes == 2
        assert redis.store["oyechats:widget:seen:5"] == "shop.acme.com"
        assert set(redis.store) == {
            "oyechats:widget:seen:5",
            "oyechats:widget:seen:origin:5",
        }

        # ...and the new origin is now the quiet one.
        harness.bootstrap(bot, _widget_request("https://shop.acme.com"))
        assert harness.writes == 2

    def test_forged_origins_cannot_buy_unbounded_writes(self, monkeypatch):
        """The abuse case, and the reason the key is not ``(bot_id, hostname)``.

        ``GET /bots/settings/public`` has no rate limit of its own and the bot
        key it authenticates with is public by design (it ships in the embed
        snippet). A per-origin throttle key therefore hands anyone who reads a
        customer's page source a loop that costs one row UPDATE on a wide JSONB
        row, plus one hour-long Redis key, per request.

        With per-bot gating the same loop is capped at two writes and two keys
        per bot per hour, whatever it sends.
        """
        redis = _FakeRedis()
        harness = _WidgetHarness(monkeypatch, redis)
        bot = _widget_bot()

        for i in range(200):
            harness.bootstrap(bot, _widget_request(f"https://attacker-{i}.example"))

        assert harness.writes == 2, "200 forged origins must not buy 200 row writes"
        assert set(redis.store) == {
            "oyechats:widget:seen:5",
            "oyechats:widget:seen:origin:5",
        }

    def test_redis_down_fails_closed_and_writes_nothing(self, monkeypatch):
        """A Redis outage must not silently promote the heartbeat to an
        unthrottled per-page-view UPDATE. Losing an hour of telemetry is the
        cheap failure; a write storm on the hottest endpoint is not."""
        harness = _WidgetHarness(monkeypatch, None)
        bot = _widget_bot()

        for _ in range(3):
            harness.bootstrap(bot, _widget_request())
        assert harness.writes == 0

    @pytest.mark.parametrize("origin", ["http://localhost:5174", "http://127.0.0.1:3000", None])
    def test_internal_origins_never_touch_the_row(self, monkeypatch, origin):
        """Dashboard preview, demo page and local dev are not customer installs."""
        redis = _FakeRedis()
        harness = _WidgetHarness(monkeypatch, redis)

        harness.bootstrap(_widget_bot(), _widget_request(origin))
        assert harness.writes == 0
        assert redis.store == {}

    def test_a_heartbeat_never_invalidates_the_bot_config_cache(self, monkeypatch):
        """Dropping the config cache on a touch would evict it up to 24x a day
        per bot and hand the database the read load the cache exists to absorb.
        Only the once-per-lifetime first-seen stamp may invalidate."""
        from app.api import bot_routes as br

        redis = _FakeRedis()
        harness = _WidgetHarness(monkeypatch, redis)
        deletes: list[str] = []
        monkeypatch.setattr(br, "cache_delete", lambda key: deletes.append(key) or True)

        harness.bootstrap(_widget_bot(), _widget_request())
        assert harness.writes == 1
        assert deletes == []

    def test_first_seen_still_stamps_and_invalidates_without_redis(self, monkeypatch):
        """First-install detection is a one-off fact the setup checklist needs,
        so it keeps its own DB-guarded path and must survive a Redis outage."""
        from app.api import bot_routes as br

        harness = _WidgetHarness(monkeypatch, None)
        deletes: list[str] = []
        monkeypatch.setattr(br, "cache_delete", lambda key: deletes.append(key) or True)

        harness.bootstrap(_widget_bot(widget_installed_at=None), _widget_request())
        assert harness.writes == 1
        assert deletes == ["oyechats:bot:bot-heartbeat"]

    def test_first_seen_claims_the_throttle_slot(self, monkeypatch):
        """The stamp already wrote ``widget_last_seen_at`` and the origin, so the
        very next page load from that origin has nothing to add."""
        redis = _FakeRedis()
        harness = _WidgetHarness(monkeypatch, redis)

        harness.bootstrap(_widget_bot(widget_installed_at=None), _widget_request())
        assert harness.writes == 1
        assert redis.store["oyechats:widget:seen:5"] == "acme.com"
        harness.bootstrap(_widget_bot(), _widget_request())
        assert harness.writes == 1

    def test_a_broken_heartbeat_never_fails_the_bootstrap(self, monkeypatch):
        """Telemetry is not allowed to take a customer's widget down."""

        class _ExplodingRedis:
            def set(self, *a, **kw):
                raise RuntimeError("redis exploded")

        harness = _WidgetHarness(monkeypatch, _ExplodingRedis())
        result = harness.bootstrap(_widget_bot(), _widget_request())
        assert result["primary_color"] == "#4F46E5"


class TestWidgetOriginIsDiagnosticOnly:
    """``widget_last_origin`` is written from a browser-forgeable header by an
    endpoint whose bot key is public. If enforcement ever consulted it, the
    column would be a self-authorisation channel: bootstrap once from
    ``evil.example`` to stamp it, then be recognised from then on.

    Asserted through ``_enforce_bot_origin``'s actual verdict rather than by
    grepping its source for the column name. A grep passes whether or not any
    of this exists, and would miss the value arriving via a helper or a local
    variable.
    """

    @staticmethod
    def _bot(**kw):
        return SimpleNamespace(id=1, domain_check_enabled=True, allowed_domains=["acme.com"], **kw)

    @staticmethod
    def _request(origin):
        return SimpleNamespace(headers={"origin": origin})

    def test_a_foreign_origin_is_rejected_even_after_being_recorded(self):
        from fastapi import HTTPException

        from app.api import auth

        with pytest.raises(HTTPException) as excinfo:
            auth._enforce_bot_origin(
                self._bot(widget_last_origin="evil.example"),
                self._request("https://evil.example"),
            )
        assert excinfo.value.status_code == 403

    @pytest.mark.parametrize("recorded", [None, "acme.com", "evil.example", "sub.evil.example"])
    def test_the_recorded_origin_never_moves_the_verdict(self, recorded):
        """Same bot, same two requests, the column is the only thing that varies:
        the allowlisted origin always passes and the foreign one always 403s."""
        from fastapi import HTTPException

        from app.api import auth

        auth._enforce_bot_origin(self._bot(widget_last_origin=recorded), self._request("https://acme.com"))
        with pytest.raises(HTTPException):
            auth._enforce_bot_origin(self._bot(widget_last_origin=recorded), self._request("https://evil.example"))


class TestWidgetHeartbeatCacheRoundTrip:
    def test_both_columns_survive_the_bot_config_cache(self):
        """``_bot_from_cache_dict`` starts from a bare ``Bot()``, so a column the
        serializer forgets comes back None on every cache hit — and a datetime
        missing from ``_CACHED_DATETIME_FIELDS`` comes back a string."""
        from app.api import auth
        from app.db.models import Bot

        seen = datetime(2026, 8, 1, 9, 30, tzinfo=UTC)
        bot = Bot(id=1, client_id=1, bot_key="bot-rt", name="RT")
        bot.widget_last_seen_at = seen
        bot.widget_last_origin = "shop.acme.com"

        restored = auth._bot_from_cache_dict(auth._bot_to_cache_dict(bot))
        assert restored.widget_last_seen_at == seen
        assert isinstance(restored.widget_last_seen_at, datetime)
        assert restored.widget_last_origin == "shop.acme.com"

    def test_an_unseen_widget_round_trips_as_none(self):
        from app.api import auth
        from app.db.models import Bot

        restored = auth._bot_from_cache_dict(
            auth._bot_to_cache_dict(Bot(id=1, client_id=1, bot_key="bot-rt2", name="RT"))
        )
        assert restored.widget_last_seen_at is None
        assert restored.widget_last_origin is None

    def test_a_cache_entry_written_before_this_column_existed_still_decodes(self):
        """The deploy this column ships in has warm Redis entries written by the
        previous build, which carry neither key. Decoding one must yield None
        rather than raise — this runs on ``get_current_bot``, so a throw here is
        a 500 on the widget bootstrap for every bot with a warm cache."""
        from app.api import auth

        pre_migration_entry = {
            "id": 1,
            "client_id": 1,
            "bot_key": "bot-preexisting",
            "name": "Old Build",
            "created_at": None,
        }
        restored = auth._bot_from_cache_dict(pre_migration_entry)
        assert restored.widget_last_seen_at is None
        assert restored.widget_last_origin is None
        # ...and re-serializing that rebuilt object must not throw either.
        assert auth._bot_to_cache_dict(restored)["widget_last_seen_at"] is None
        assert auth._bot_to_cache_dict(restored)["widget_last_origin"] is None

    def test_a_bot_stand_in_without_the_attributes_still_serializes(self):
        """``_bot_to_cache_dict`` is also handed lightweight fakes (see
        ``test_suspension_enforcement``). A bare ``bot.<new_column>`` read turns
        every one of those into an AttributeError on the auth path."""
        from types import SimpleNamespace

        from app.api import auth
        from app.db.models import Bot

        columns = {c.key for c in Bot.__table__.columns}
        stand_in = SimpleNamespace(**dict.fromkeys(columns - {"widget_last_seen_at", "widget_last_origin"}))
        encoded = auth._bot_to_cache_dict(stand_in)
        assert encoded["widget_last_seen_at"] is None
        assert encoded["widget_last_origin"] is None


# ── Migration ────────────────────────────────────────────────────────────────


@pg
def test_widget_heartbeat_migration_creates_both_columns(monkeypatch):
    """``Base.metadata.create_all`` validates the ORM, never the Alembic DDL, so
    a column added to the model but forgotten in a migration passes every other
    test in this file and only fails on a real deploy."""
    from alembic.config import Config
    from sqlalchemy import create_engine, inspect, make_url, text

    import app.config as app_config
    from alembic import command

    tmp_db = "oyechats_widget_heartbeat_migration_test"
    # ``make_url().set(database=...)`` rather than string surgery on DB_URL: a
    # socket-style URL (``...@/db?host=/tmp&port=5433``) carries slashes in its
    # query string, so splitting on the last "/" mangles it.
    base_url = make_url(os.environ["DB_URL"])
    tmp_url = base_url.set(database=tmp_db)
    admin = create_engine(base_url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {tmp_db}"))
        conn.execute(text(f"CREATE DATABASE {tmp_db}"))

    tmp_admin = create_engine(tmp_url, isolation_level="AUTOCOMMIT")
    with tmp_admin.connect() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS citext"))
    tmp_admin.dispose()

    try:
        # ``env.py`` feeds this straight into ``config.set_main_option``, which
        # is configparser-backed and treats "%" as interpolation syntax. A
        # socket URL renders its host as "%2Ftmp", so the "%" has to be doubled;
        # configparser hands back "%2F" and SQLAlchemy decodes it to "/".
        monkeypatch.setattr(app_config, "DB_URL", str(tmp_url).replace("%", "%%"))
        cfg = Config()
        cfg.set_main_option("script_location", "alembic")

        command.upgrade(cfg, "head")
        eng = create_engine(tmp_url)
        columns = {c["name"]: c for c in inspect(eng).get_columns("bots")}
        assert {"widget_last_seen_at", "widget_last_origin"} <= set(columns)
        # NULL is a real state ("not seen since this shipped"), so both must be
        # nullable with no default and no backfill.
        for name in ("widget_last_seen_at", "widget_last_origin"):
            assert columns[name]["nullable"] is True
            assert columns[name]["default"] is None
        eng.dispose()

        # Reversible, then re-runnable.
        command.downgrade(cfg, "-1")
        eng = create_engine(tmp_url)
        after_down = {c["name"] for c in inspect(eng).get_columns("bots")}
        assert not ({"widget_last_seen_at", "widget_last_origin"} & after_down)
        eng.dispose()

        command.upgrade(cfg, "head")
        eng = create_engine(tmp_url)
        assert {"widget_last_seen_at", "widget_last_origin"} <= {c["name"] for c in inspect(eng).get_columns("bots")}
        eng.dispose()
    finally:
        with admin.connect() as conn:
            conn.execute(
                text(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = :db AND pid <> pg_backend_pid()"
                ),
                {"db": tmp_db},
            )
            conn.execute(text(f"DROP DATABASE IF EXISTS {tmp_db}"))
        admin.dispose()
