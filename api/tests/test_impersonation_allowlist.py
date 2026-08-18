"""The §6.1 impersonation allowlist - *which* writes a support session may make.

``tests/test_impersonation_auth.py`` covers the mechanism: how an
``X-Impersonation-Token`` resolves, and that the write guard is fail-closed.
This file covers the **policy** that mechanism enforces, the concrete set of
endpoints carrying ``@impersonation_writable``:

* one representative marked endpoint per allowlist surface reaches its handler,
* the surfaces §6.2 (and decision D-1) deliberately leave unmarked stay 403,
* reads are never affected, on those very same routers, and
* :func:`test_marked_endpoints_are_exactly_the_intended_allowlist` pins the
  whole-app set, so widening the blast radius takes a deliberate edit here.

Every test drives the *real* auth dependencies (no ``dependency_overrides`` for
auth) because the guard lives inside them and stubbing them out would test
nothing.
"""

import hashlib
import os
import secrets
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import (
    auth,
    bot_routes,
    canned_response_routes,
    chat_routes,
    client_routes,
    document_routes,
    invite_routes,
    operator_routes,
    subscription_routes,
)
from app.db.models import Bot, CannedResponse, ChatSession, Client, Department, ImpersonationToken
from app.services import webhook_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


# ── The allowlist itself ────────────────────────────────────────────────────
#
# THE list. Adding an entry here is the deliberate act that widens what a
# super-admin can do inside a customer's Account. Treat it like a permission
# grant, not like bookkeeping. Each entry maps to a row of design §6.1.

IMPERSONATION_ALLOWLIST: frozenset[tuple[str, str]] = frozenset(
    {
        # AI Agent (Bot) config edits. Name, greeting, tone, appearance/branding.
        ("PATCH", "/bots/{bot_id}"),
        # Canned-response CRUD. Pure workspace content, reversible.
        ("POST", "/canned-responses"),
        ("PATCH", "/canned-responses/{response_id}"),
        ("DELETE", "/canned-responses/{response_id}"),
        # Conversation (ChatSession) status changes + operator assignment.
        ("POST", "/operators/accept/{session_id}"),
        ("POST", "/operators/close/{session_id}"),
        ("POST", "/operators/resolve/{session_id}"),
        ("POST", "/operators/transfer/{session_id}"),
        # Department edits (NOT create/delete, NOT operator invites).
        ("PATCH", "/operators/departments/{department_id}"),
        # Preview-mode test chat. Owner-preview replies skip credit deduction.
        ("POST", "/chat"),
        ("POST", "/chat/stream"),
    }
)


# ── Fixtures / helpers (mirrors tests/test_impersonation_auth.py) ───────────


@contextmanager
def _ctx(session):
    yield session


def _mk_admin(db, email: str) -> Client:
    admin = Client(name=f"Admin-{email}", email=email, api_key=f"key-{email}", is_superadmin=True)
    db.add(admin)
    db.flush()
    return admin


def _mk_target(db, email: str) -> Client:
    target = Client(name=f"Target-{email}", email=email, api_key=f"key-{email}")
    db.add(target)
    db.flush()
    return target


def _mk_token(db, actor: Client, target: Client) -> str:
    """Mint a live impersonation token exactly as ``/impersonate`` does."""
    raw = secrets.token_urlsafe(32)
    db.add(
        ImpersonationToken(
            token_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
            actor_id=actor.id,
            target_id=target.id,
            expires_at=datetime.now(UTC) + timedelta(minutes=30),
        )
    )
    db.flush()
    return raw


def _mk_bot(db, client_id: int, bot_key: str, name: str = "Support Bot") -> Bot:
    bot = Bot(client_id=client_id, bot_key=bot_key, name=name)
    db.add(bot)
    db.flush()
    return bot


@pytest.fixture()
def session_maker(db, monkeypatch):
    """Point every module's ``get_session`` at the throwaway test session.

    The resolvers in ``app.api.auth`` and each route module bound
    ``get_session`` into their own namespace at import, so patching the source
    module would miss them. Patch each namespace explicitly.
    """

    def _patch(*modules) -> None:
        for module in (auth, *modules):
            monkeypatch.setattr(module, "get_session", lambda: _ctx(db))

    return _patch


def _client_for(*routers) -> TestClient:
    """Mount routers on a bare app, keeping the REAL auth dependencies."""
    app = FastAPI()
    for router in routers:
        app.include_router(router)
    return TestClient(app)


def _impersonating(raw: str) -> dict[str, str]:
    return {"X-Impersonation-Token": raw}


# ── The five allowlist surfaces: a marked endpoint reaches its handler ──────


class TestAllowlistedSurfacesAreWritable:
    def test_ai_agent_config_edit_is_permitted(self, db, session_maker):
        """Surface 1. AI Agent config (name, greeting, tone, appearance)."""
        session_maker(bot_routes)
        admin = _mk_admin(db, "allow-bot-admin@test.example")
        target = _mk_target(db, "allow-bot-target@test.example")
        bot = _mk_bot(db, target.id, "bot-allow-config")
        bot_id = bot.id
        raw = _mk_token(db, admin, target)

        res = _client_for(bot_routes.router).patch(
            f"/bots/{bot_id}",
            json={"name": "Renamed by support", "welcome_title": "Hi!"},
            headers=_impersonating(raw),
        )

        assert res.status_code == 200, res.text
        db.expire_all()
        assert db.get(Bot, bot_id).name == "Renamed by support"

    def test_ai_agent_config_edit_rejects_security_sensitive_fields(self, db, session_maker):
        """The marked ``PATCH /bots/{bot_id}`` grants config edits, NOT the
        widget origin allowlist or the customer's lead-email routing: those are
        persistent security-relevant changes that outlive the 30-minute token,
        so the endpoint field-guards them for impersonated callers."""
        session_maker(bot_routes)
        admin = _mk_admin(db, "allow-bot-guard-admin@test.example")
        target = _mk_target(db, "allow-bot-guard-target@test.example")
        bot = _mk_bot(db, target.id, "bot-allow-guard")
        bot_id = bot.id
        original_name = bot.name
        raw = _mk_token(db, admin, target)

        for payload in (
            {"allowed_domains": ["evil.example"]},
            {"domain_check_enabled": False},
            {"session_share_domain": "evil.example"},
            {"notification_email": "attacker@evil.example"},
            {"reply_to_email": "attacker@evil.example"},
            # Mixed: one benign + one sensitive field must be rejected whole.
            {"name": "Renamed by support", "domain_check_enabled": False},
        ):
            res = _client_for(bot_routes.router).patch(
                f"/bots/{bot_id}",
                json=payload,
                headers=_impersonating(raw),
            )
            assert res.status_code == 403, f"{payload} → {res.status_code}: {res.text}"
            assert res.json()["detail"]["error"] == "impersonation_read_only"

        # Nothing was applied, including the benign half of the mixed payload.
        db.expire_all()
        stored = db.get(Bot, bot_id)
        assert stored.name == original_name
        assert stored.domain_check_enabled is not False or stored.allowed_domains != ["evil.example"]

    def test_owner_still_edits_the_guarded_fields(self, db, session_maker):
        """The field guard is impersonation-scoped: the real owner's own
        ``X-API-Key`` keeps full access to the same fields."""
        session_maker(bot_routes)
        target = _mk_target(db, "allow-bot-owner@test.example")
        bot = _mk_bot(db, target.id, "bot-owner-guarded")
        bot_id = bot.id

        res = _client_for(bot_routes.router).patch(
            f"/bots/{bot_id}",
            json={"allowed_domains": ["customer.example"]},
            headers={"X-API-Key": target.api_key},
        )

        assert res.status_code == 200, res.text
        db.expire_all()
        assert db.get(Bot, bot_id).allowed_domains == ["customer.example"]

    def test_canned_response_create_is_permitted(self, db, session_maker):
        """Surface 2. Canned-response CRUD."""
        session_maker(canned_response_routes)
        admin = _mk_admin(db, "allow-canned-admin@test.example")
        target = _mk_target(db, "allow-canned-target@test.example")
        target_id = target.id
        raw = _mk_token(db, admin, target)

        res = _client_for(canned_response_routes.router).post(
            "/canned-responses",
            json={"title": "Refund policy", "content": "We refund within 14 days."},
            headers=_impersonating(raw),
        )

        assert res.status_code == 200, res.text
        stored = db.query(CannedResponse).filter(CannedResponse.client_id == target_id).one()
        assert stored.title == "Refund policy"

    def test_conversation_status_change_is_permitted(self, db, session_maker, monkeypatch):
        """Surface 3. Conversation status changes / operator assignment.

        ``fire_webhook`` and the live-chat ``manager`` reach outside the test
        session (the customer's webhook endpoints, open WebSockets); both are
        stubbed so the assertion is about the guard and the persisted status,
        not about live-chat fan-out.
        """
        session_maker(operator_routes)
        monkeypatch.setattr(webhook_service, "fire_webhook", lambda *a, **kw: None)
        monkeypatch.setattr(operator_routes, "manager", AsyncMock())

        admin = _mk_admin(db, "allow-conv-admin@test.example")
        target = _mk_target(db, "allow-conv-target@test.example")
        bot = _mk_bot(db, target.id, "bot-allow-conv")
        db.add(ChatSession(id="sess-allow-conv", bot_id=bot.id, client_id=target.id, status="live"))
        db.flush()
        raw = _mk_token(db, admin, target)

        res = _client_for(operator_routes.router).post(
            "/operators/close/sess-allow-conv",
            headers=_impersonating(raw),
        )

        assert res.status_code == 200, res.text
        db.expire_all()
        closed = db.get(ChatSession, "sess-allow-conv")
        assert closed.status == "bot"
        assert closed.assigned_operator_id is None

    def test_department_edit_is_permitted(self, db, session_maker):
        """Surface 4. Department edits (config only, never invites)."""
        session_maker(operator_routes)
        admin = _mk_admin(db, "allow-dept-admin@test.example")
        target = _mk_target(db, "allow-dept-target@test.example")
        dept = Department(client_id=target.id, name="Support")
        db.add(dept)
        db.flush()
        dept_id = dept.id
        raw = _mk_token(db, admin, target)

        res = _client_for(operator_routes.router).patch(
            f"/operators/departments/{dept_id}",
            json={"name": "Customer Success"},
            headers=_impersonating(raw),
        )

        assert res.status_code == 200, res.text
        db.expire_all()
        assert db.get(Department, dept_id).name == "Customer Success"

    def test_preview_test_chat_is_not_blocked_by_the_write_guard(self, db, session_maker):
        """Surface 5. Preview-mode test chat.

        ``POST /chat`` resolves its bot through ``get_bot_for_chat``, which has
        no ``X-Impersonation-Token`` branch, so an impersonated caller is turned
        away by *bot* auth (401) long before the write guard would see the
        request. The marker is therefore declarative today. What this test pins
        is the part that matters: the write guard is **not** what blocks the
        preview surface. If impersonation is ever wired into
        ``get_bot_for_chat``, this must stay true, and that branch must admit
        the owner-preview path only, since the same endpoint's paid path
        deducts the Account's credits.
        """
        session_maker(chat_routes)
        admin = _mk_admin(db, "allow-chat-admin@test.example")
        target = _mk_target(db, "allow-chat-target@test.example")
        _mk_bot(db, target.id, "bot-allow-chat")
        raw = _mk_token(db, admin, target)

        res = _client_for(chat_routes.router).post(
            "/chat",
            json={"question": "hello", "session_id": "sess-preview"},
            headers=_impersonating(raw),
        )

        assert res.status_code != 403, res.text
        assert res.status_code == 401, "expected bot auth (not the write guard) to be the blocker"


# ── Denied by construction (§6.2 + decision D-1) ────────────────────────────


def _assert_read_only_403(res) -> None:
    assert res.status_code == 403, res.text
    assert res.json()["detail"]["error"] == "impersonation_read_only"


class TestDeniedSurfacesStay403:
    def test_credit_topup_is_denied(self, db, session_maker):
        """§6.2. Billing / credits / payments. Spends the customer's money."""
        session_maker(subscription_routes)
        admin = _mk_admin(db, "deny-topup-admin@test.example")
        target = _mk_target(db, "deny-topup-target@test.example")
        raw = _mk_token(db, admin, target)

        res = _client_for(subscription_routes.credits_router).post(
            "/credits/topup",
            json={"amount": 1000},
            headers=_impersonating(raw),
        )
        _assert_read_only_403(res)

    def test_subscription_checkout_is_denied(self, db, session_maker):
        """§6.2. Subscription checkout is the same money-committing family."""
        session_maker(subscription_routes)
        admin = _mk_admin(db, "deny-checkout-admin@test.example")
        target = _mk_target(db, "deny-checkout-target@test.example")
        raw = _mk_token(db, admin, target)

        res = _client_for(subscription_routes.router).post(
            "/subscriptions/checkout",
            json={"plan_id": 1},
            headers=_impersonating(raw),
        )
        _assert_read_only_403(res)

    def test_ai_agent_deletion_is_denied(self, db, session_maker):
        """§6.2. AI Agent deletion. Irreversible, and cancels a subscription."""
        session_maker(bot_routes)
        admin = _mk_admin(db, "deny-del-admin@test.example")
        target = _mk_target(db, "deny-del-target@test.example")
        bot = _mk_bot(db, target.id, "bot-deny-delete")
        bot_id = bot.id
        raw = _mk_token(db, admin, target)

        _assert_read_only_403(_client_for(bot_routes.router).delete(f"/bots/{bot_id}", headers=_impersonating(raw)))
        db.expire_all()
        assert db.get(Bot, bot_id) is not None

    def test_crawl_train_trigger_is_denied(self, db, session_maker):
        """Decision D-1. Training spends the Account's credits, so it stays
        denied even though it looks like useful debugging surface."""
        session_maker(document_routes)
        admin = _mk_admin(db, "deny-crawl-admin@test.example")
        target = _mk_target(db, "deny-crawl-target@test.example")
        raw = _mk_token(db, admin, target)

        res = _client_for(document_routes.router).post(
            "/crawl",
            json={"url": "https://example.com"},
            headers=_impersonating(raw),
        )
        _assert_read_only_403(res)

    def test_auto_recrawl_toggle_is_denied(self, db, session_maker):
        """Decision D-1 again. Scheduling a recrawl schedules the spend."""
        session_maker(bot_routes)
        admin = _mk_admin(db, "deny-recrawl-admin@test.example")
        target = _mk_target(db, "deny-recrawl-target@test.example")
        bot = _mk_bot(db, target.id, "bot-deny-recrawl")
        bot_id = bot.id
        raw = _mk_token(db, admin, target)

        res = _client_for(bot_routes.router).patch(
            f"/bots/{bot_id}/recrawl",
            json={"enabled": True},
            headers=_impersonating(raw),
        )
        _assert_read_only_403(res)

    def test_api_key_rotation_is_denied(self, db, session_maker):
        """§6.2. Rotating the key would lock the customer's own integrations
        out, and hand the session a credential that outlives it."""
        session_maker(client_routes)
        admin = _mk_admin(db, "deny-key-admin@test.example")
        target = _mk_target(db, "deny-key-target@test.example")
        target_id, original_key = target.id, target.api_key
        raw = _mk_token(db, admin, target)

        res = _client_for(client_routes.router).post("/client/api-key/regenerate", headers=_impersonating(raw))

        _assert_read_only_403(res)
        db.expire_all()
        assert db.get(Client, target_id).api_key == original_key

    def test_operator_invite_is_denied(self, db, session_maker):
        """§6.2, an invite sends email over the customer's name."""
        session_maker(invite_routes)
        admin = _mk_admin(db, "deny-invite-admin@test.example")
        target = _mk_target(db, "deny-invite-target@test.example")
        raw = _mk_token(db, admin, target)

        res = _client_for(invite_routes.router).post(
            "/invites",
            json={"email": "new-operator@test.example", "role": "operator"},
            headers=_impersonating(raw),
        )
        _assert_read_only_403(res)

    def test_department_create_and_delete_stay_denied(self, db, session_maker):
        """§6.1 grants department *edits*. Create and delete are outside it,
        and a delete re-parents every operator in the department."""
        session_maker(operator_routes)
        admin = _mk_admin(db, "deny-dept-admin@test.example")
        target = _mk_target(db, "deny-dept-target@test.example")
        dept = Department(client_id=target.id, name="Billing")
        db.add(dept)
        db.flush()
        dept_id = dept.id
        raw = _mk_token(db, admin, target)
        c = _client_for(operator_routes.router)

        _assert_read_only_403(c.post("/operators/departments", json={"name": "New"}, headers=_impersonating(raw)))
        _assert_read_only_403(c.delete(f"/operators/departments/{dept_id}", headers=_impersonating(raw)))
        db.expire_all()
        assert db.get(Department, dept_id) is not None


# ── Reads are never affected ────────────────────────────────────────────────


class TestReadsStayAllowed:
    def test_get_is_allowed_on_every_touched_router(self, db, session_maker):
        """GET/HEAD/OPTIONS pass unconditionally, including on the routers
        that carry the denied mutations, so support can still *see* billing,
        credentials and knowledge-base state while unable to change them."""
        session_maker(bot_routes, canned_response_routes, client_routes, operator_routes, subscription_routes)
        admin = _mk_admin(db, "read-admin@test.example")
        target = _mk_target(db, "read-target@test.example")
        bot = _mk_bot(db, target.id, "bot-read-allowed")
        bot_id = bot.id
        db.add(Department(client_id=target.id, name="Support"))
        db.flush()
        raw = _mk_token(db, admin, target)

        c = _client_for(
            bot_routes.router,
            canned_response_routes.router,
            client_routes.router,
            operator_routes.router,
            subscription_routes.credits_router,
        )
        headers = _impersonating(raw)

        for path in (
            f"/bots/{bot_id}",  # same router as the denied DELETE /bots/{bot_id}
            "/canned-responses",
            "/client/api-key",  # same router as the denied key rotation
            "/operators/departments",
            "/credits/history",  # same router as the denied top-up
        ):
            res = c.get(path, headers=headers)
            assert res.status_code == 200, f"GET {path} -> {res.status_code}: {res.text}"

    def test_read_of_the_api_key_never_leaks_the_real_credential(self, db, session_maker):
        """The api_key is scrubbed on the impersonated Client (constraint 3.1),
        so even the masked read degrades instead of echoing the customer's
        permanent credential back to the admin."""
        session_maker(client_routes)
        admin = _mk_admin(db, "read-key-admin@test.example")
        target = _mk_target(db, "read-key-target@test.example")
        real_key = target.api_key
        raw = _mk_token(db, admin, target)

        res = _client_for(client_routes.router).get("/client/api-key", headers=_impersonating(raw))

        assert res.status_code == 200, res.text
        assert real_key[-4:] not in res.json()["api_key_masked"]


# ── The regression guard over the whole app ─────────────────────────────────


class TestAllowlistIsPinned:
    def test_marked_endpoints_are_exactly_the_intended_allowlist(self):
        """REGRESSION GUARD. Do not weaken.

        Walks every route the application registers and asserts the set that
        carries ``impersonation_writable`` is exactly
        :data:`IMPERSONATION_ALLOWLIST`. Marking a new endpoint therefore fails
        this test until someone edits the list above on purpose, which is the
        review moment where "should a super-admin be able to do this inside a
        customer's Account?" actually gets asked.
        """
        from app.main import app as fastapi_app

        marked: set[tuple[str, str]] = set()
        for route in fastapi_app.routes:
            endpoint = getattr(route, "endpoint", None)
            if endpoint is None or getattr(endpoint, "impersonation_writable", False) is not True:
                continue
            for method in getattr(route, "methods", set()):
                if method in {"HEAD", "OPTIONS"}:
                    continue
                marked.add((method, route.path))

        assert marked == set(IMPERSONATION_ALLOWLIST), (
            f"unexpected marks: {sorted(marked - set(IMPERSONATION_ALLOWLIST))} · "
            f"missing marks: {sorted(set(IMPERSONATION_ALLOWLIST) - marked)}"
        )

    def test_no_safe_method_route_is_marked(self):
        """A marker on a GET route is always a mistake. Safe methods already
        pass unconditionally, so it can only signal a misunderstanding of what
        the marker means."""
        from app.main import app as fastapi_app

        for route in fastapi_app.routes:
            endpoint = getattr(route, "endpoint", None)
            if endpoint is None or getattr(endpoint, "impersonation_writable", False) is not True:
                continue
            assert getattr(route, "methods", set()) - {"HEAD", "OPTIONS"} != {"GET"}, (
                f"{route.path} is a read-only route and must not carry the marker"
            )


class TestImpersonationCannotReEnableMeteredSpend:
    """A support session must not be able to switch a customer's paid
    enrichments back on.

    `PATCH /bots/{id}` is `@impersonation_writable`, and the blocked-field set
    was scoped to security controls plus lead-email redirection. The two
    metered toggles belong in the same category for a different reason: a
    customer turns them off specifically so credits stop being spent, and a
    super-admin opening a session to fix something that "looks wrong" could
    turn spending back on with nothing but a field name in a log line as the
    trace.
    """

    def test_both_enrichment_toggles_are_in_the_blocked_set(self):
        """Reads the set out of the handler source rather than driving a full
        impersonated request, so it stays a cheap guard against someone adding
        a third metered toggle and forgetting this list."""
        import inspect
        import re

        from app.api import bot_routes

        source = inspect.getsource(bot_routes.update_bot)
        start = source.index("blocked = sorted(")
        block = source[start : source.index("& update_data.keys()", start)]
        blocked = set(re.findall(r'"([a-z_][a-z0-9_]*)"', block))

        assert "email_verification_enabled" in blocked
        assert "company_lookup_enabled" in blocked, (
            "an impersonated support session can switch metered spending back on"
        )
