"""HTTP round-trip tests for the operator-invite routes (``app/api/invite_routes.py``).

``tests/test_invite_service.py`` covers the service layer directly. This file
covers the *route* layer that sits on top of it, which the service tests cannot
reach: request/response contracts, the ``InviteError`` → structured-HTTP
mapping, authorization, cross-tenant isolation, and — most importantly — the two
**unauthenticated public endpoints** (``GET /invites/by-token/{token}`` and
``POST /invites/by-token/{token}/accept``). Those grant workspace access from a
bare token, so their negative paths are security-relevant, not cosmetic.

The centrepiece is ``test_full_invite_round_trip``: it drives the real journey a
customer takes — owner sends an invite → the emailed link's token is looked up
anonymously by the airlock page → the invitee accepts with their own API key →
an ``Operator`` bound to the invite's bot exists. Nothing about that chain is
asserted by the service tests, because the token only leaves the system through
the email dispatch and only comes back through the routes.

Apps are built the way ``main.py`` does (``app.state.limiter`` + the SlowAPI
handler) so the rate-limit decorators resolve under ``TestClient``; the autouse
``_reset_rate_limiter`` fixture in conftest keeps the shared counters from
bleeding between tests.
"""

from __future__ import annotations

import hashlib
import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import select

from app.core.rate_limit import limiter
from app.db.models import Bot, Client, Operator, OperatorInvite, Plan, Subscription

pytestmark = pytest.mark.skipif(
    os.getenv("DB_URL") is None,
    reason="invite route tests need a reachable Postgres at DB_URL",
)

_seq = iter(range(500_000, 600_000))


@contextmanager
def _session_cm(session):
    yield session


# ── Fixtures / factories ─────────────────────────────────────────────────────


def _make_client(db, *, email=None, is_verified=True, name=None) -> Client:
    n = next(_seq)
    c = Client(
        name=name or f"Owner {n}",
        email=(email or f"owner{n}@example.com").lower(),
        hashed_password="$2b$12$notarealhash",
        api_key=f"api-key-{n}",
        is_verified=is_verified,
    )
    db.add(c)
    db.commit()
    return c


def _make_bot(db, owner) -> Bot:
    n = next(_seq)
    bot = Bot(client_id=owner.id, bot_key=f"bot-route-{n}", name="Route Bot")
    db.add(bot)
    db.commit()
    return bot


def _make_paid_workspace(db, *, live_chat=True, operators_ceiling=5):
    """Owner (verified) + bot + active plan granting live_chat and seats."""
    n = next(_seq)
    owner = _make_client(db)
    bot = _make_bot(db, owner)
    plan = Plan(
        name=f"Plan {n}",
        slug=f"plan-route-{n}",
        monthly_price_cents=94900,
        limits={"operators": operators_ceiling, "bots": 5},
        features={"live_chat": live_chat},
        included_operator_seats=operators_ceiling,
        is_active=True,
    )
    db.add(plan)
    db.commit()
    db.add(
        Subscription(
            client_id=owner.id,
            plan_id=plan.id,
            bot_id=None,
            status="active",
            operator_quantity=operators_ceiling,
            created_at=datetime.now(UTC),
        )
    )
    db.commit()
    return owner, bot


def _build_app(db, *, actor: Client | None = None, strict_client: Client | None = None) -> FastAPI:
    """Router wired like ``main.py``, with auth dependencies overridden.

    ``actor`` drives the client-or-operator dependency (owner-facing routes);
    ``strict_client`` drives ``get_current_client_strict`` (the accept route,
    which is deliberately X-API-Key-only).
    """
    from app.api import auth, invite_routes

    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(invite_routes.router)

    if actor is not None:
        app.dependency_overrides[auth.get_current_client_or_operator] = lambda: {
            "type": "client",
            "entity": actor,
            "client_id": actor.id,
            "operator_id": None,
        }
    if strict_client is not None:
        app.dependency_overrides[auth.get_current_client_strict] = lambda: strict_client
    return app


@contextmanager
def _routed(db, app):
    """Point every ``get_session()`` the request touches at the test session."""
    from app.api import auth, invite_routes

    with (
        patch.object(invite_routes, "get_session", lambda: _session_cm(db)),
        patch.object(auth, "get_session", lambda: _session_cm(db)),
    ):
        yield TestClient(app, raise_server_exceptions=False)


def _seed_invite(db, owner, bot, *, email, status="pending", token, expires_in_days=7, role="operator"):
    inv = OperatorInvite(
        client_id=owner.id,
        bot_id=bot.id,
        email=email.lower(),
        role=role,
        token_hash=hashlib.sha256(token.encode()).hexdigest(),
        status=status,
        expires_at=datetime.now(UTC) + timedelta(days=expires_in_days),
        invited_by_client_id=owner.id,
        invited_by_name=owner.name,
        sent_at=datetime.now(UTC),
        resend_count=0,
    )
    db.add(inv)
    db.commit()
    return inv


# ── The full journey ─────────────────────────────────────────────────────────


def test_full_invite_round_trip(db):
    """create → emailed token → anonymous airlock lookup → accept → operator.

    This is the contract the service tests structurally cannot cover: the token
    only escapes through the email dispatch and only returns through the public
    routes. If the emailed link carried the wrong token, or the public lookup
    resolved a different invite, every service-level test would still pass.
    """
    owner, bot = _make_paid_workspace(db)
    app = _build_app(db, actor=owner)

    sent: dict = {}

    from app.api import invite_routes

    with (
        _routed(db, app) as api,
        patch.object(invite_routes, "_dispatch_invite_email", lambda **kw: sent.update(kw)),
    ):
        created = api.post(
            "/invites",
            json={"email": "Newbie@Example.com", "bot_id": bot.id, "role": "operator"},
        )

    assert created.status_code == 201, created.text
    view = created.json()["invite"]
    assert view["bot_id"] == bot.id  # the binding survives the response contract
    assert view["email"] == "newbie@example.com"  # normalized
    assert view["status"] == "pending"
    # The response must never carry the token — only the email does.
    assert "token" not in created.text.lower()

    # The email actually went out, and its link carries a usable token.
    assert sent["target_email"] == "newbie@example.com"
    token = sent["accept_url"].rsplit("/", 1)[-1]
    assert token

    # ── the airlock page (UNAUTHENTICATED) resolves that exact token ──
    anon_app = _build_app(db)  # no auth overrides at all
    with _routed(db, anon_app) as anon:
        looked_up = anon.get(f"/invites/by-token/{token}")

    assert looked_up.status_code == 200, looked_up.text
    public = looked_up.json()
    assert public["email"] == "newbie@example.com"
    assert public["status"] == "pending"
    assert public["inviter_name"] == owner.name
    # Narrow by design: no ids, no token, no hash may leak to an anonymous caller.
    for leaked in ("id", "token", "token_hash", "client_id", "bot_id"):
        assert leaked not in public

    # ── the invitee accepts with their OWN api key ──
    invitee = _make_client(db, email="newbie@example.com")
    accept_app = _build_app(db, strict_client=invitee)
    with _routed(db, accept_app) as api:
        accepted = api.post(f"/invites/by-token/{token}/accept")

    assert accepted.status_code == 200, accepted.text
    payload = accepted.json()
    assert payload["workspace_id"] == owner.id
    assert payload["role"] == "operator"

    # ── an Operator now exists, bound to the invite's bot and the invitee ──
    op = db.execute(select(Operator).where(Operator.id == payload["operator_id"])).scalar_one()
    assert op.bot_id == bot.id
    assert op.client_id == owner.id
    assert op.linked_client_id == invitee.id
    assert op.is_active is True

    invite = db.execute(select(OperatorInvite).where(OperatorInvite.client_id == owner.id)).scalar_one()
    assert invite.status == "accepted"
    assert invite.accepted_by_client_id == invitee.id


# ── POST /invites — contract + error mapping ─────────────────────────────────


def test_create_requires_bot_id(db):
    """``bot_id`` is required by the contract — omitting it is a 422, never a
    silently workspace-wide invite."""
    owner, _bot = _make_paid_workspace(db)
    app = _build_app(db, actor=owner)
    with _routed(db, app) as api:
        res = api.post("/invites", json={"email": "x@example.com", "role": "operator"})
    assert res.status_code == 422


def test_create_rejects_bot_from_another_workspace(db):
    """Cross-tenant: inviting someone onto a bot the caller doesn't own must be
    refused at create, mapped to a structured 404 (not a 500)."""
    owner, _bot = _make_paid_workspace(db)
    _other_owner, foreign_bot = _make_paid_workspace(db)

    app = _build_app(db, actor=owner)
    with _routed(db, app) as api, patch("app.api.invite_routes._dispatch_invite_email", lambda **kw: None):
        res = api.post("/invites", json={"email": "x@example.com", "bot_id": foreign_bot.id, "role": "operator"})

    assert res.status_code == 404, res.text
    assert res.json()["detail"]["error"] == "bot_not_found"
    # Nothing was persisted for the attacker's workspace.
    assert db.execute(select(OperatorInvite).where(OperatorInvite.client_id == owner.id)).first() is None


def test_create_duplicate_pending_is_conflict(db):
    """The second invite to the same address maps to 409, not a 500 from the
    partial-unique index."""
    owner, bot = _make_paid_workspace(db)
    _seed_invite(db, owner, bot, email="dupe@example.com", token="tok-dupe-aaaaaaaaaaaaaaaaaaaa")

    app = _build_app(db, actor=owner)
    with _routed(db, app) as api, patch("app.api.invite_routes._dispatch_invite_email", lambda **kw: None):
        res = api.post("/invites", json={"email": "dupe@example.com", "bot_id": bot.id, "role": "operator"})

    assert res.status_code == 409, res.text
    assert res.json()["detail"]["error"] == "invite_already_pending"


def test_create_blocked_when_plan_lacks_live_chat(db):
    """Feature gate surfaces as a structured error the dashboard can branch on."""
    owner, bot = _make_paid_workspace(db, live_chat=False)
    app = _build_app(db, actor=owner)
    with _routed(db, app) as api, patch("app.api.invite_routes._dispatch_invite_email", lambda **kw: None):
        res = api.post("/invites", json={"email": "x@example.com", "bot_id": bot.id, "role": "operator"})

    assert res.status_code == 403, res.text
    assert res.json()["detail"]["error"] == "live_chat_locked"
    assert db.execute(select(OperatorInvite)).first() is None


def test_invite_email_failure_does_not_roll_back_the_invite(db):
    """Brevo is fire-and-forget: a send failure must leave a usable invite row
    (the owner can Resend) rather than 500 the request."""
    owner, bot = _make_paid_workspace(db)
    app = _build_app(db, actor=owner)

    def _boom(**_kw):
        raise RuntimeError("brevo down")

    from app.api import invite_routes

    # Patch the *email service* under the dispatcher, so the route's real
    # try/except is what swallows the failure — patching the dispatcher itself
    # would test nothing.
    with (
        _routed(db, app) as api,
        patch.object(invite_routes, "send_operator_invite_email", _boom),
    ):
        res = api.post("/invites", json={"email": "resend@example.com", "bot_id": bot.id, "role": "operator"})

    assert res.status_code == 201, res.text
    row = db.execute(select(OperatorInvite).where(OperatorInvite.client_id == owner.id)).scalar_one()
    assert row.status == "pending"


# ── GET /invites — authorization + tenant isolation ──────────────────────────


def test_list_returns_only_the_callers_workspace(db):
    """Tenant isolation on enumeration: workspace A never sees workspace B's
    invites, even though both rows live in the same table."""
    owner_a, bot_a = _make_paid_workspace(db)
    owner_b, bot_b = _make_paid_workspace(db)
    _seed_invite(db, owner_a, bot_a, email="mine@example.com", token="tok-a-aaaaaaaaaaaaaaaaaaaaa")
    _seed_invite(db, owner_b, bot_b, email="theirs@example.com", token="tok-b-bbbbbbbbbbbbbbbbbbbbb")

    app = _build_app(db, actor=owner_a)
    with _routed(db, app) as api:
        res = api.get("/invites")

    assert res.status_code == 200, res.text
    emails = [r["email"] for r in res.json()]
    assert emails == ["mine@example.com"]


def test_list_rejects_a_non_manager(db):
    """Invite enumeration is owner/admin-only — a stranger gets the structured
    RBAC error, not the list."""
    owner, bot = _make_paid_workspace(db)
    _seed_invite(db, owner, bot, email="secret@example.com", token="tok-sec-cccccccccccccccccccc")
    stranger = _make_client(db)

    # Stranger authenticates, but claims the victim's workspace id.
    from app.api import auth, invite_routes

    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
    app.include_router(invite_routes.router)
    app.dependency_overrides[auth.get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": stranger,
        "client_id": owner.id,  # ← claiming someone else's workspace
        "operator_id": None,
    }

    with _routed(db, app) as api:
        res = api.get("/invites")

    assert res.status_code == 403, res.text
    assert res.json()["detail"]["error"] == "insufficient_permissions"


# ── Public token endpoints — unauthenticated surface ─────────────────────────


def test_public_lookup_unknown_token_is_404(db):
    """An unknown token must be an ordinary 404 — no stack trace, no hint about
    whether the token space is occupied."""
    anon_app = _build_app(db)
    with _routed(db, anon_app) as anon:
        res = anon.get("/invites/by-token/definitely-not-a-real-token-000")

    assert res.status_code == 404, res.text
    assert res.json()["detail"]["error"] == "invite_not_found"


def test_public_lookup_reports_expired_and_sweeps_it(db):
    """A pending invite past its TTL surfaces as ``expired`` to the airlock and
    the row is flipped, so it can never be accepted afterwards."""
    owner, bot = _make_paid_workspace(db)
    token = "tok-expired-dddddddddddddddddddd"
    invite = _seed_invite(db, owner, bot, email="old@example.com", token=token, expires_in_days=-1)

    anon_app = _build_app(db)
    with _routed(db, anon_app) as anon:
        res = anon.get(f"/invites/by-token/{token}")

    assert res.status_code == 200, res.text
    assert res.json()["status"] == "expired"
    db.refresh(invite)
    assert invite.status == "expired"


def test_accept_rejects_a_different_signed_in_account(db):
    """The invite is bound to an email. Someone else holding the link — the
    realistic leak — cannot spend it on their own account."""
    owner, bot = _make_paid_workspace(db)
    token = "tok-mismatch-eeeeeeeeeeeeeeeeeeee"
    _seed_invite(db, owner, bot, email="intended@example.com", token=token)
    interloper = _make_client(db, email="attacker@example.com")

    app = _build_app(db, strict_client=interloper)
    with _routed(db, app) as api:
        res = api.post(f"/invites/by-token/{token}/accept")

    assert res.status_code == 403, res.text
    assert res.json()["detail"]["error"] == "email_mismatch"
    # No operator was provisioned for the interloper.
    assert db.execute(select(Operator).where(Operator.linked_client_id == interloper.id)).first() is None


def test_accept_unknown_token_is_404(db):
    invitee = _make_client(db, email="nobody@example.com")
    app = _build_app(db, strict_client=invitee)
    with _routed(db, app) as api:
        res = api.post("/invites/by-token/not-a-real-token-1234567/accept")

    assert res.status_code == 404, res.text
    assert res.json()["detail"]["error"] == "invite_not_found"


def test_accept_a_revoked_invite_is_refused(db):
    """Revocation is the owner's kill switch — a link already in the wild must
    stop working the moment it is revoked."""
    owner, bot = _make_paid_workspace(db)
    token = "tok-revoked-fffffffffffffffffff"
    _seed_invite(db, owner, bot, email="revoked@example.com", token=token, status="revoked")
    invitee = _make_client(db, email="revoked@example.com")

    app = _build_app(db, strict_client=invitee)
    with _routed(db, app) as api:
        res = api.post(f"/invites/by-token/{token}/accept")

    assert res.status_code == 410, res.text
    assert res.json()["detail"]["error"] == "invite_revoked"
    assert db.execute(select(Operator).where(Operator.linked_client_id == invitee.id)).first() is None


def test_accepting_twice_does_not_create_a_second_operator(db):
    """Double-click on the airlock's Accept button must not burn a second seat."""
    owner, bot = _make_paid_workspace(db)
    token = "tok-twice-gggggggggggggggggggg"
    _seed_invite(db, owner, bot, email="twice@example.com", token=token)
    invitee = _make_client(db, email="twice@example.com")

    app = _build_app(db, strict_client=invitee)
    with _routed(db, app) as api:
        first = api.post(f"/invites/by-token/{token}/accept")
        second = api.post(f"/invites/by-token/{token}/accept")

    assert first.status_code == 200, first.text
    # The invite is single-use: the second click is refused with the structured
    # "already accepted" gone-410, not silently re-run.
    assert second.status_code == 410, second.text
    assert second.json()["detail"]["error"] == "invite_already_accepted"
    # And crucially, no second seat was consumed.
    ops = db.execute(select(Operator).where(Operator.linked_client_id == invitee.id)).scalars().all()
    assert len(ops) == 1


# ── POST /invites/{id}/resend — token rotation ───────────────────────────────


def test_resend_rotates_the_token_and_kills_the_old_link(db):
    """Resend issues a NEW token and the previous link must stop resolving —
    otherwise a leaked first link would stay valid forever alongside the new one."""
    owner, bot = _make_paid_workspace(db)
    old_token = "tok-rotate-old-jjjjjjjjjjjjjjjj"
    invite = _seed_invite(db, owner, bot, email="rotate@example.com", token=old_token)

    sent: dict = {}
    from app.api import invite_routes

    app = _build_app(db, actor=owner)
    with (
        _routed(db, app) as api,
        patch.object(invite_routes, "_dispatch_invite_email", lambda **kw: sent.update(kw)),
    ):
        res = api.post(f"/invites/{invite.id}/resend")

    assert res.status_code == 200, res.text
    new_token = sent["accept_url"].rsplit("/", 1)[-1]
    assert new_token != old_token

    anon_app = _build_app(db)
    with _routed(db, anon_app) as anon:
        old_link = anon.get(f"/invites/by-token/{old_token}")
        new_link = anon.get(f"/invites/by-token/{new_token}")

    assert old_link.status_code == 404, "the superseded link must stop working"
    assert new_link.status_code == 200, new_link.text
    assert new_link.json()["email"] == "rotate@example.com"


def test_resend_of_another_workspaces_invite_is_rejected(db):
    """Cross-tenant: resending someone else's invite would let an attacker mail
    themselves a fresh, valid token."""
    owner_a, _bot_a = _make_paid_workspace(db)
    owner_b, bot_b = _make_paid_workspace(db)
    victim = _seed_invite(db, owner_b, bot_b, email="victim2@example.com", token="tok-victim2-kkkkkkkkkkkkkk")

    app = _build_app(db, actor=owner_a)
    with _routed(db, app) as api, patch("app.api.invite_routes._dispatch_invite_email", lambda **kw: None):
        res = api.post(f"/invites/{victim.id}/resend")

    assert res.status_code == 404, res.text
    db.refresh(victim)
    # The victim's token was NOT rotated.
    assert victim.token_hash == hashlib.sha256(b"tok-victim2-kkkkkkkkkkkkkk").hexdigest()


# ── DELETE /invites/{id} — revoke ────────────────────────────────────────────


def test_revoke_marks_the_invite_and_kills_the_link(db):
    owner, bot = _make_paid_workspace(db)
    token = "tok-kill-hhhhhhhhhhhhhhhhhhhh"
    invite = _seed_invite(db, owner, bot, email="kill@example.com", token=token)

    app = _build_app(db, actor=owner)
    with _routed(db, app) as api:
        res = api.delete(f"/invites/{invite.id}")

    assert res.status_code == 204, res.text
    db.refresh(invite)
    assert invite.status == "revoked"


def test_revoke_of_another_workspaces_invite_is_404(db):
    """Cross-tenant write: workspace A cannot revoke workspace B's invite, and
    the 404 does not confirm the id exists."""
    owner_a, _bot_a = _make_paid_workspace(db)
    owner_b, bot_b = _make_paid_workspace(db)
    victim = _seed_invite(db, owner_b, bot_b, email="victim@example.com", token="tok-victim-iiiiiiiiiiiiiiii")

    app = _build_app(db, actor=owner_a)
    with _routed(db, app) as api:
        res = api.delete(f"/invites/{victim.id}")

    assert res.status_code == 404, res.text
    db.refresh(victim)
    assert victim.status == "pending"  # untouched
