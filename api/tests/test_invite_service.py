"""Integration tests for ``app.services.invite_service`` — real Postgres.

Operator invites are auth-adjacent and security-sensitive: token opacity, RBAC,
seat limits, the live-chat feature gate, and idempotent state transitions. All
of that is DB-bound (entitlements resolve from real ``Plan``/``Subscription``
rows, seat checks count real ``Operator`` rows, partial-unique indexes enforce
"one pending invite per email"), so these run against the shared throwaway
Postgres ``db`` fixture from ``conftest.py`` rather than mocks.

KNOWN BUG (see the module report): ``invite_service.create_invite`` constructs
``OperatorInvite(bot_id=...)`` and ``accept_invite`` reads ``invite.bot_id``,
but ``OperatorInvite`` has no ``bot_id`` column in either the ORM model or the
baseline schema. Every code path that reaches the ``OperatorInvite`` constructor
or ``_require_seat_available(..., invite.bot_id)`` therefore raises at runtime.
These tests exercise every branch that is reachable BEFORE that point — all the
guardrails (which raise first), the token helpers, ``get_invite_by_token``,
``revoke_invite``, ``resend_invite``, and the accept branches that never touch
``bot_id``. The success paths of create/accept are intentionally NOT asserted as
working, because they cannot be until the missing column is added.
"""

import hashlib
import os
import secrets
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

from app.db.models import Bot, Client, Operator, OperatorInvite, Plan, Subscription
from app.services import invite_service as svc

pytestmark = pytest.mark.skipif(
    os.getenv("DB_URL") is None,
    reason="invite integration tests need a reachable Postgres at DB_URL",
)

_seq = iter(range(1, 100_000))


# ── Row factories ────────────────────────────────────────────────────────────


def make_client(db, *, email=None, is_superadmin=False, name=None) -> Client:
    n = next(_seq)
    client = Client(
        name=name or f"Client {n}",
        email=(email or f"client{n}@example.com").lower(),
        hashed_password="$2b$12$notarealhash",
        api_key=f"api-key-{n}",
        is_superadmin=is_superadmin,
    )
    db.add(client)
    db.commit()
    return client


def make_bot(db, owner) -> Bot:
    n = next(_seq)
    bot = Bot(client_id=owner.id, bot_key=f"bot-inv-{n}", name="Invite Bot")
    db.add(bot)
    db.commit()
    return bot


def make_plan(db, *, live_chat=True, operators_ceiling=5, included_seats=5) -> Plan:
    n = next(_seq)
    plan = Plan(
        name=f"Plan {n}",
        slug=f"plan-{n}",
        monthly_price_cents=94900,
        limits={"operators": operators_ceiling, "bots": 1},
        features={"live_chat": live_chat},
        included_operator_seats=included_seats,
        is_active=True,
    )
    db.add(plan)
    db.commit()
    return plan


def make_subscription(db, owner, plan, *, operator_quantity=5) -> Subscription:
    sub = Subscription(
        client_id=owner.id,
        plan_id=plan.id,
        bot_id=None,
        status="active",
        operator_quantity=operator_quantity,
        created_at=datetime.now(UTC),
    )
    db.add(sub)
    db.commit()
    return sub


def make_operator(db, owner, bot, *, email=None, linked_client=None, role="operator", is_active=True) -> Operator:
    n = next(_seq)
    op = Operator(
        client_id=owner.id,
        bot_id=bot.id,
        name=f"Op {n}",
        email=(email or f"op{n}@example.com").lower(),
        role=role,
        is_active=is_active,
        linked_client_id=linked_client.id if linked_client is not None else None,
    )
    db.add(op)
    db.commit()
    return op


def make_invite(
    db, ws, *, email, status="pending", role="operator", expires_in_days=7, resend_count=0, token_plaintext=None
):
    """Insert an OperatorInvite directly (bypassing the broken create_invite).

    OperatorInvite has no bot_id column, so we never pass one — this mirrors the
    actual persisted shape and lets us test the invite lifecycle functions that
    don't depend on the missing column.
    """
    plaintext = token_plaintext or secrets.token_urlsafe(32)
    inv = OperatorInvite(
        client_id=ws.workspace_id,
        email=email.lower(),
        role=role,
        token_hash=hashlib.sha256(plaintext.encode()).hexdigest(),
        status=status,
        expires_at=datetime.now(UTC) + timedelta(days=expires_in_days),
        invited_by_client_id=ws.owner.id,
        invited_by_name=ws.owner.name,
        sent_at=datetime.now(UTC),
        resend_count=resend_count,
    )
    db.add(inv)
    db.commit()
    return inv, plaintext


def make_ws(db):
    """Owner + bot only — for lifecycle tests that don't consult entitlements."""
    owner = make_client(db)
    bot = make_bot(db, owner)
    return SimpleNamespace(owner=owner, bot=bot, workspace_id=owner.id)


def setup_workspace(db, *, live_chat=True, operators_ceiling=5, included_seats=5, operator_quantity=5):
    """Owner + bot + active paid subscription granting live_chat + seats."""
    owner = make_client(db)
    bot = make_bot(db, owner)
    plan = make_plan(db, live_chat=live_chat, operators_ceiling=operators_ceiling, included_seats=included_seats)
    sub = make_subscription(db, owner, plan, operator_quantity=operator_quantity)
    return SimpleNamespace(owner=owner, bot=bot, plan=plan, sub=sub, workspace_id=owner.id)


def _active_op_count(db, owner_id, bot_id) -> int:
    return int(
        db.execute(
            select(func.count(Operator.id)).where(
                Operator.client_id == owner_id,
                Operator.bot_id == bot_id,
                Operator.is_active.is_(True),
            )
        ).scalar_one()
    )


# ── Token helpers (pure, security-sensitive) ─────────────────────────────────


class TestTokenHelpers:
    def test_hash_matches_sha256_of_plaintext(self):
        assert svc._hash_token("hello") == hashlib.sha256(b"hello").hexdigest()

    def test_generate_returns_plaintext_and_its_hash(self):
        plaintext, token_hash = svc._generate_invite_token()
        assert token_hash == hashlib.sha256(plaintext.encode()).hexdigest()
        # The stored value is opaque — never equal to the pre-image.
        assert plaintext != token_hash
        assert len(token_hash) == 64

    def test_generated_tokens_are_unique(self):
        assert svc._generate_invite_token()[0] != svc._generate_invite_token()[0]

    @pytest.mark.parametrize(
        "raw,expected",
        [("  Foo@Bar.COM ", "foo@bar.com"), ("already@low.com", "already@low.com")],
    )
    def test_normalize_email(self, raw, expected):
        assert svc._normalize_email(raw) == expected


# ── create_invite guardrails (all raise before the OperatorInvite build) ─────


class TestCreateInviteGuards:
    def test_invalid_role_rejected(self, db):
        ws = setup_workspace(db)
        with pytest.raises(svc.InviteError) as exc:
            svc.create_invite(
                db,
                workspace_id=ws.workspace_id,
                email="x@example.com",
                role="superuser",
                bot_id=ws.bot.id,
                department_id=None,
                invited_by=ws.owner,
            )
        assert exc.value.code == "invalid_role"

    def test_bot_in_another_workspace_rejected(self, db):
        ws = setup_workspace(db)
        other = setup_workspace(db)
        with pytest.raises(svc.InviteError) as exc:
            svc.create_invite(
                db,
                workspace_id=ws.workspace_id,
                email="x@example.com",
                role="operator",
                bot_id=other.bot.id,
                department_id=None,
                invited_by=ws.owner,
            )
        assert exc.value.code == "bot_not_found"
        assert exc.value.status_code == 404

    def test_non_manager_cannot_invite(self, db):
        ws = setup_workspace(db)
        stranger = make_client(db)
        make_operator(db, ws.owner, ws.bot, linked_client=stranger, role="operator")
        with pytest.raises(svc.InviteError) as exc:
            svc.create_invite(
                db,
                workspace_id=ws.workspace_id,
                email="x@example.com",
                role="operator",
                bot_id=ws.bot.id,
                department_id=None,
                invited_by=stranger,
            )
        assert exc.value.code == "insufficient_permissions"
        assert exc.value.status_code == 403

    def test_live_chat_feature_gate(self, db):
        ws = setup_workspace(db, live_chat=False)
        with pytest.raises(svc.InviteError) as exc:
            svc.create_invite(
                db,
                workspace_id=ws.workspace_id,
                email="x@example.com",
                role="operator",
                bot_id=ws.bot.id,
                department_id=None,
                invited_by=ws.owner,
            )
        assert exc.value.code == "live_chat_locked"
        assert exc.value.status_code == 403

    def test_cannot_invite_superadmin(self, db):
        ws = setup_workspace(db)
        make_client(db, email="root@platform.com", is_superadmin=True)
        with pytest.raises(svc.InviteError) as exc:
            svc.create_invite(
                db,
                workspace_id=ws.workspace_id,
                email="root@platform.com",
                role="operator",
                bot_id=ws.bot.id,
                department_id=None,
                invited_by=ws.owner,
            )
        assert exc.value.code == "cannot_invite_superadmin"

    def test_cannot_invite_workspace_owner(self, db):
        ws = setup_workspace(db)
        with pytest.raises(svc.InviteError) as exc:
            svc.create_invite(
                db,
                workspace_id=ws.workspace_id,
                email=ws.owner.email,
                role="operator",
                bot_id=ws.bot.id,
                department_id=None,
                invited_by=ws.owner,
            )
        assert exc.value.code == "cannot_invite_owner"

    def test_existing_active_operator_conflicts(self, db):
        ws = setup_workspace(db)
        make_operator(db, ws.owner, ws.bot, email="dup@example.com", role="operator")
        with pytest.raises(svc.InviteError) as exc:
            svc.create_invite(
                db,
                workspace_id=ws.workspace_id,
                email="dup@example.com",
                role="operator",
                bot_id=ws.bot.id,
                department_id=None,
                invited_by=ws.owner,
            )
        assert exc.value.code == "operator_already_exists"
        assert exc.value.status_code == 409

    def test_duplicate_pending_invite_conflicts(self, db):
        ws = setup_workspace(db)
        make_invite(db, ws, email="again@example.com", status="pending")
        with pytest.raises(svc.InviteError) as exc:
            svc.create_invite(
                db,
                workspace_id=ws.workspace_id,
                email="again@example.com",
                role="operator",
                bot_id=ws.bot.id,
                department_id=None,
                invited_by=ws.owner,
            )
        assert exc.value.code == "invite_already_pending"
        assert exc.value.status_code == 409

    def test_seat_limit_reached(self, db):
        ws = setup_workspace(db, operators_ceiling=1, included_seats=1, operator_quantity=1)
        make_operator(db, ws.owner, ws.bot, email="seat@example.com")  # consumes the one seat
        with pytest.raises(svc.InviteError) as exc:
            svc.create_invite(
                db,
                workspace_id=ws.workspace_id,
                email="waiting@example.com",
                role="operator",
                bot_id=ws.bot.id,
                department_id=None,
                invited_by=ws.owner,
            )
        assert exc.value.code == "seat_limit_reached"
        assert exc.value.status_code == 403


# ── get_invite_by_token ──────────────────────────────────────────────────────


class TestGetInviteByToken:
    def test_resolves_correct_token(self, db):
        ws = make_ws(db)
        invite, plaintext = make_invite(db, ws, email="tok@example.com")
        assert svc.get_invite_by_token(db, plaintext).id == invite.id

    def test_token_lookup_is_hash_based(self, db):
        ws = make_ws(db)
        _, plaintext = make_invite(db, ws, email="tok2@example.com")
        # Presenting the stored hash itself must NOT resolve — only the pre-image.
        stored_hash = hashlib.sha256(plaintext.encode()).hexdigest()
        assert svc.get_invite_by_token(db, stored_hash) is None

    def test_wrong_token_returns_none(self, db):
        ws = make_ws(db)
        make_invite(db, ws, email="tok3@example.com")
        assert svc.get_invite_by_token(db, "not-the-token") is None

    @pytest.mark.parametrize("bad", ["", "   ", None])
    def test_empty_token_returns_none(self, db, bad):
        assert svc.get_invite_by_token(db, bad) is None


# ── accept_invite — branches reachable without invite.bot_id ─────────────────


class TestAcceptInviteGuards:
    def test_email_mismatch_rejected(self, db):
        ws = make_ws(db)
        invite, _ = make_invite(db, ws, email="intended@example.com")
        wrong = make_client(db, email="someone.else@example.com")
        with pytest.raises(svc.InviteError) as exc:
            svc.accept_invite(db, invite, wrong)
        assert exc.value.code == "email_mismatch"
        assert exc.value.status_code == 403

    def test_revoked_invite_rejected(self, db):
        ws = make_ws(db)
        invitee = make_client(db, email="rev@example.com")
        invite, _ = make_invite(db, ws, email="rev@example.com", status="revoked")
        with pytest.raises(svc.InviteError) as exc:
            svc.accept_invite(db, invite, invitee)
        assert exc.value.code == "invite_revoked"
        assert exc.value.status_code == 410

    def test_already_accepted_rejected(self, db):
        ws = make_ws(db)
        invitee = make_client(db, email="acc@example.com")
        invite, _ = make_invite(db, ws, email="acc@example.com", status="accepted")
        with pytest.raises(svc.InviteError) as exc:
            svc.accept_invite(db, invite, invitee)
        assert exc.value.code == "invite_already_accepted"

    def test_expired_invite_rejected_and_swept(self, db):
        ws = make_ws(db)
        invitee = make_client(db, email="exp@example.com")
        invite, _ = make_invite(db, ws, email="exp@example.com", status="pending", expires_in_days=-1)
        with pytest.raises(svc.InviteError) as exc:
            svc.accept_invite(db, invite, invitee)
        assert exc.value.code == "invite_expired"
        assert exc.value.status_code == 410
        # Lazy expiry sweep persisted the transition.
        assert invite.status == "expired"

    def test_already_active_operator_is_idempotent_noop(self, db):
        # Accept when the invitee already holds an active linked operator here:
        # the service short-circuits to "accepted" without creating a row or
        # consuming a seat (and, notably, without touching invite.bot_id).
        ws = make_ws(db)
        invitee = make_client(db, email="idem@example.com")
        existing = make_operator(db, ws.owner, ws.bot, email="idem@example.com", linked_client=invitee)
        invite, _ = make_invite(db, ws, email="idem@example.com")

        result = svc.accept_invite(db, invite, invitee)
        db.commit()

        assert result.id == existing.id  # same row, no duplicate
        assert _active_op_count(db, ws.owner.id, ws.bot.id) == 1
        assert invite.status == "accepted"
        assert invite.accepted_by_client_id == invitee.id
        assert invite.accepted_at is not None


# ── revoke_invite ────────────────────────────────────────────────────────────


class TestRevokeInvite:
    def test_pending_invite_revoked(self, db):
        ws = make_ws(db)
        invite, _ = make_invite(db, ws, email="rv@example.com")
        svc.revoke_invite(db, invite, ws.owner, ws.workspace_id)
        db.commit()
        assert invite.status == "revoked"
        assert invite.revoked_at is not None
        assert invite.revoked_by_client_id == ws.owner.id

    def test_non_manager_cannot_revoke(self, db):
        ws = make_ws(db)
        invite, _ = make_invite(db, ws, email="rv2@example.com")
        stranger = make_client(db)
        with pytest.raises(svc.InviteError) as exc:
            svc.revoke_invite(db, invite, stranger, ws.workspace_id)
        assert exc.value.code == "insufficient_permissions"

    def test_foreign_invite_rejected(self, db):
        ws = make_ws(db)
        other = make_ws(db)
        foreign_invite, _ = make_invite(db, other, email="foreign@example.com")
        # Manager of workspace A tries to revoke workspace B's invite.
        with pytest.raises(svc.InviteError) as exc:
            svc.revoke_invite(db, foreign_invite, ws.owner, ws.workspace_id)
        assert exc.value.code == "invite_not_found"
        assert exc.value.status_code == 404

    def test_revoke_already_resolved_is_noop(self, db):
        ws = make_ws(db)
        invite, _ = make_invite(db, ws, email="rv3@example.com", status="accepted")
        # No raise; terminal status untouched.
        svc.revoke_invite(db, invite, ws.owner, ws.workspace_id)
        db.commit()
        assert invite.status == "accepted"


# ── resend_invite ────────────────────────────────────────────────────────────


class TestResendInvite:
    def test_rotates_token_and_invalidates_old_link(self, db):
        ws = make_ws(db)
        invite, old_plaintext = make_invite(db, ws, email="rs@example.com")
        old_hash = invite.token_hash

        new_plaintext = svc.resend_invite(db, invite, ws.owner, ws.workspace_id)
        db.commit()

        assert new_plaintext != old_plaintext
        assert invite.token_hash != old_hash
        assert invite.token_hash == hashlib.sha256(new_plaintext.encode()).hexdigest()
        assert invite.resend_count == 1
        # Old magic link is dead; the fresh one resolves.
        assert svc.get_invite_by_token(db, old_plaintext) is None
        assert svc.get_invite_by_token(db, new_plaintext).id == invite.id

    def test_non_manager_cannot_resend(self, db):
        ws = make_ws(db)
        invite, _ = make_invite(db, ws, email="rs2@example.com")
        stranger = make_client(db)
        with pytest.raises(svc.InviteError) as exc:
            svc.resend_invite(db, invite, stranger, ws.workspace_id)
        assert exc.value.code == "insufficient_permissions"

    def test_foreign_invite_rejected(self, db):
        ws = make_ws(db)
        other = make_ws(db)
        foreign_invite, _ = make_invite(db, other, email="foreign2@example.com")
        with pytest.raises(svc.InviteError) as exc:
            svc.resend_invite(db, foreign_invite, ws.owner, ws.workspace_id)
        assert exc.value.code == "invite_not_found"

    def test_non_pending_invite_rejected(self, db):
        ws = make_ws(db)
        invite, _ = make_invite(db, ws, email="rs3@example.com", status="accepted")
        with pytest.raises(svc.InviteError) as exc:
            svc.resend_invite(db, invite, ws.owner, ws.workspace_id)
        assert exc.value.code == "invite_not_pending"
        assert exc.value.status_code == 400

    def test_expired_invite_rejected(self, db):
        ws = make_ws(db)
        invite, _ = make_invite(db, ws, email="rs4@example.com", status="pending", expires_in_days=-1)
        with pytest.raises(svc.InviteError) as exc:
            svc.resend_invite(db, invite, ws.owner, ws.workspace_id)
        assert exc.value.code == "invite_expired"
        assert exc.value.status_code == 410

    def test_resend_limit_reached(self, db):
        ws = make_ws(db)
        invite, _ = make_invite(db, ws, email="rs5@example.com", resend_count=svc.MAX_RESEND_PER_INVITE)
        with pytest.raises(svc.InviteError) as exc:
            svc.resend_invite(db, invite, ws.owner, ws.workspace_id)
        assert exc.value.code == "resend_limit_reached"
        assert exc.value.status_code == 429
