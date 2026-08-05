"""Impersonation auth resolution + the fail-closed write guard.

A super-admin support session is carried by an ``X-Impersonation-Token``
header, validated against ``impersonation_tokens`` on *every* request. These
tests cover the three client resolvers in ``app.api.auth``
(``get_current_client``, ``get_current_client_strict``,
``get_current_client_or_operator``), the ``impersonation_writable`` marker,
and the default-deny write guard that keeps the blast radius small.

The last test in the guard section is a regression guard: it registers a brand
new mutating route without the marker and asserts it is denied. That is the
test which keeps the fail-closed property true as routes are added over time.
"""

import hashlib
import os
import secrets
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app.api import auth
from app.db.models import AuditLog, Bot, Client, ImpersonationToken
from app.services.audit_service import record_audit

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _mk_admin(db, email: str) -> Client:
    admin = Client(name=f"Admin-{email}", email=email, api_key=f"key-{email}", is_superadmin=True)
    db.add(admin)
    db.flush()
    return admin


def _mk_target(db, email: str, **extra) -> Client:
    target = Client(name=f"Target-{email}", email=email, api_key=f"key-{email}", **extra)
    db.add(target)
    db.flush()
    return target


def _mk_token(db, actor: Client, target: Client, *, expires_in: timedelta = timedelta(minutes=30)) -> tuple[str, int]:
    """Mint an impersonation token exactly as ``/impersonate`` does.

    Returns ``(raw_token, token_id)`` — the raw value never leaves this helper
    in production, so tests must capture it at mint time just like the browser.
    """
    raw = secrets.token_urlsafe(32)
    record = ImpersonationToken(
        token_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        actor_id=actor.id,
        target_id=target.id,
        expires_at=datetime.now(UTC) + expires_in,
    )
    db.add(record)
    db.flush()
    return raw, record.id


def _http_request(method: str = "GET", path: str = "/probe") -> Request:
    """A minimal ASGI request for calling the resolvers directly."""
    return Request({"type": "http", "method": method, "path": path, "headers": []})


def _patch_session(monkeypatch, db) -> None:
    monkeypatch.setattr(auth, "get_session", lambda: _ctx(db))


def _resolve_expecting_401(raw: str) -> str:
    """Call ``get_current_client`` with ``raw`` and return the 401 detail."""
    with pytest.raises(HTTPException) as exc:
        auth.get_current_client(
            _http_request(),
            api_key=None,
            operator_key=None,
            legacy_agent_key=None,
            impersonation_token=raw,
        )
    assert exc.value.status_code == 401
    return exc.value.detail


# ── Resolution: X-Impersonation-Token → target Account ───────────────────────


class TestImpersonationResolution:
    def test_token_resolves_to_the_target_account(self, db, monkeypatch):
        admin = _mk_admin(db, "imp-res-admin@test.example")
        target = _mk_target(db, "imp-res-target@test.example")
        admin_id, target_id = admin.id, target.id
        raw, token_id = _mk_token(db, admin, target)
        _patch_session(monkeypatch, db)

        client = auth.get_current_client(
            _http_request(),
            api_key=None,
            operator_key=None,
            legacy_agent_key=None,
            impersonation_token=raw,
        )

        assert client.id == target_id
        assert client._impersonator_id == admin_id
        assert client._impersonation_token_id == token_id

    def test_resolved_client_never_carries_the_permanent_api_key(self, db, monkeypatch):
        """Constraint 3.1: the Account's api_key is permanent and unrevocable,
        so an impersonated session must never be able to echo it back."""
        admin = _mk_admin(db, "imp-key-admin@test.example")
        target = _mk_target(db, "imp-key-target@test.example")
        target_id, real_key = target.id, target.api_key
        raw, _ = _mk_token(db, admin, target)
        _patch_session(monkeypatch, db)

        client = auth.get_current_client(
            _http_request(),
            api_key=None,
            operator_key=None,
            legacy_agent_key=None,
            impersonation_token=raw,
        )

        assert client.api_key is None
        # Scrubbing happens on the detached copy only — the stored credential
        # must be untouched.
        assert db.get(Client, target_id).api_key == real_key

    def test_unknown_token_is_rejected(self, db, monkeypatch):
        _patch_session(monkeypatch, db)

        assert _resolve_expecting_401("never-minted") == "Impersonation session expired or revoked."

    def test_expired_token_is_rejected(self, db, monkeypatch):
        admin = _mk_admin(db, "imp-exp-admin@test.example")
        target = _mk_target(db, "imp-exp-target@test.example")
        raw, _ = _mk_token(db, admin, target, expires_in=timedelta(seconds=-1))
        _patch_session(monkeypatch, db)

        assert _resolve_expecting_401(raw) == "Impersonation session expired or revoked."

    def test_token_valid_up_to_the_expiry_boundary(self, db, monkeypatch):
        """A token one second short of expiry still resolves — the boundary is
        ``expires_at > now``, not ``>=`` with a safety margin."""
        admin = _mk_admin(db, "imp-bound-admin@test.example")
        target = _mk_target(db, "imp-bound-target@test.example")
        target_id = target.id
        raw, _ = _mk_token(db, admin, target, expires_in=timedelta(seconds=1))
        _patch_session(monkeypatch, db)

        client = auth.get_current_client(
            _http_request(),
            api_key=None,
            operator_key=None,
            legacy_agent_key=None,
            impersonation_token=raw,
        )
        assert client.id == target_id

    def test_revoking_mid_session_401s_the_very_next_request(self, db, monkeypatch):
        admin = _mk_admin(db, "imp-rev-admin@test.example")
        target = _mk_target(db, "imp-rev-target@test.example")
        target_id = target.id
        raw, token_id = _mk_token(db, admin, target)
        _patch_session(monkeypatch, db)

        first = auth.get_current_client(
            _http_request(),
            api_key=None,
            operator_key=None,
            legacy_agent_key=None,
            impersonation_token=raw,
        )
        assert first.id == target_id

        db.get(ImpersonationToken, token_id).revoked_at = datetime.now(UTC)
        db.flush()

        assert _resolve_expecting_401(raw) == "Impersonation session expired or revoked."

    def test_suspended_account_can_still_be_impersonated(self, db, monkeypatch):
        """Decision D-2: ``_ensure_client_authenticatable`` is bypassed on this
        path so support can debug *why* an Account was suspended."""
        admin = _mk_admin(db, "imp-susp-admin@test.example")
        target = _mk_target(db, "imp-susp-target@test.example", suspended_at=datetime.now(UTC))
        target_id = target.id
        raw, _ = _mk_token(db, admin, target)
        _patch_session(monkeypatch, db)

        client = auth.get_current_client(
            _http_request(),
            api_key=None,
            operator_key=None,
            legacy_agent_key=None,
            impersonation_token=raw,
        )
        assert client.id == target_id

    def test_deactivated_account_can_still_be_impersonated(self, db, monkeypatch):
        admin = _mk_admin(db, "imp-deact-admin@test.example")
        target = _mk_target(db, "imp-deact-target@test.example", deactivated_at=datetime.now(UTC))
        target_id = target.id
        raw, _ = _mk_token(db, admin, target)
        _patch_session(monkeypatch, db)

        client = auth.get_current_client(
            _http_request(),
            api_key=None,
            operator_key=None,
            legacy_agent_key=None,
            impersonation_token=raw,
        )
        assert client.id == target_id


# ── Precedence and the other two resolvers ──────────────────────────────────


class TestImpersonationPrecedence:
    def test_impersonation_token_beats_api_key(self, db, monkeypatch):
        admin = _mk_admin(db, "imp-prec-admin@test.example")
        target = _mk_target(db, "imp-prec-target@test.example")
        other = _mk_target(db, "imp-prec-other@test.example")
        target_id, other_key = target.id, other.api_key
        raw, _ = _mk_token(db, admin, target)
        _patch_session(monkeypatch, db)

        client = auth.get_current_client(
            _http_request(),
            api_key=other_key,
            operator_key=None,
            legacy_agent_key=None,
            impersonation_token=raw,
        )
        assert client.id == target_id

    def test_strict_resolver_accepts_the_impersonation_token(self, db, monkeypatch):
        admin = _mk_admin(db, "imp-strict-admin@test.example")
        target = _mk_target(db, "imp-strict-target@test.example")
        target_id = target.id
        raw, _ = _mk_token(db, admin, target)
        _patch_session(monkeypatch, db)

        client = auth.get_current_client_strict(_http_request(), api_key=None, impersonation_token=raw)
        assert client.id == target_id
        assert client.api_key is None

    def test_strict_resolver_prefers_impersonation_over_api_key(self, db, monkeypatch):
        admin = _mk_admin(db, "imp-strict2-admin@test.example")
        target = _mk_target(db, "imp-strict2-target@test.example")
        other = _mk_target(db, "imp-strict2-other@test.example")
        target_id, other_key = target.id, other.api_key
        raw, _ = _mk_token(db, admin, target)
        _patch_session(monkeypatch, db)

        client = auth.get_current_client_strict(_http_request(), api_key=other_key, impersonation_token=raw)
        assert client.id == target_id

    def test_or_operator_resolver_accepts_the_impersonation_token(self, db, monkeypatch):
        admin = _mk_admin(db, "imp-oo-admin@test.example")
        target = _mk_target(db, "imp-oo-target@test.example")
        admin_id, target_id = admin.id, target.id
        raw, _ = _mk_token(db, admin, target)
        _patch_session(monkeypatch, db)

        result = auth.get_current_client_or_operator(
            _http_request(),
            api_key=None,
            operator_key=None,
            legacy_agent_key=None,
            workspace_id_raw=None,
            impersonation_token=raw,
        )
        assert result["type"] == "client"
        assert result["client_id"] == target_id
        assert result["operator_id"] is None
        assert result["entity"]._impersonator_id == admin_id

    def test_or_operator_resolver_prefers_impersonation_over_operator_key(self, db, monkeypatch):
        admin = _mk_admin(db, "imp-oo2-admin@test.example")
        target = _mk_target(db, "imp-oo2-target@test.example")
        target_id = target.id
        raw, _ = _mk_token(db, admin, target)
        _patch_session(monkeypatch, db)

        result = auth.get_current_client_or_operator(
            _http_request(),
            api_key=None,
            operator_key="some-operator-key",
            legacy_agent_key=None,
            workspace_id_raw=None,
            impersonation_token=raw,
        )
        assert result["client_id"] == target_id


# ── Route-level behaviour: bot keys, raw tokens, and the write guard ────────


def _probe_client(db, monkeypatch) -> TestClient:
    """An app exposing read/write probes behind the real (unmocked) auth deps."""
    _patch_session(monkeypatch, db)
    router = APIRouter()

    @router.get("/probe")
    def read_probe(client: Client = Depends(auth.get_current_client)):
        return {"client_id": client.id}

    @router.post("/probe")
    def write_probe(client: Client = Depends(auth.get_current_client)):
        return {"client_id": client.id}

    @router.post("/probe/marked")
    @auth.impersonation_writable
    def marked_write_probe(client: Client = Depends(auth.get_current_client)):
        return {"client_id": client.id}

    @router.delete("/probe")
    def delete_probe(auth_ctx: dict = Depends(auth.get_current_client_or_operator)):
        return {"client_id": auth_ctx["client_id"]}

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


class TestBotKeysStayExcluded:
    def test_bot_key_cannot_resolve_to_a_client(self, db, monkeypatch):
        """Bot keys are public (embedded in every widget script) and must never
        resolve to a Client — impersonation support does not change that."""
        owner = _mk_target(db, "imp-botkey-owner@test.example")
        db.add(Bot(client_id=owner.id, bot_key="bot-imp-public-key"))
        db.flush()
        c = _probe_client(db, monkeypatch)

        res = c.get("/probe", headers={"X-Bot-Key": "bot-imp-public-key"})
        assert res.status_code == 401

    def test_raw_impersonation_token_is_not_an_api_key(self, db, monkeypatch):
        admin = _mk_admin(db, "imp-notkey-admin@test.example")
        target = _mk_target(db, "imp-notkey-target@test.example")
        raw, _ = _mk_token(db, admin, target)
        c = _probe_client(db, monkeypatch)

        res = c.get("/probe", headers={"X-API-Key": raw})
        assert res.status_code == 401
        assert res.json()["detail"] == "Invalid API Key."


class TestImpersonationWriteGuard:
    def test_get_is_always_allowed(self, db, monkeypatch):
        admin = _mk_admin(db, "imp-g1-admin@test.example")
        target = _mk_target(db, "imp-g1-target@test.example")
        target_id = target.id
        raw, _ = _mk_token(db, admin, target)
        c = _probe_client(db, monkeypatch)

        res = c.get("/probe", headers={"X-Impersonation-Token": raw})
        assert res.status_code == 200, res.text
        assert res.json()["client_id"] == target_id

    def test_unmarked_post_is_denied(self, db, monkeypatch):
        admin = _mk_admin(db, "imp-g2-admin@test.example")
        target = _mk_target(db, "imp-g2-target@test.example")
        raw, _ = _mk_token(db, admin, target)
        c = _probe_client(db, monkeypatch)

        res = c.post("/probe", headers={"X-Impersonation-Token": raw})
        assert res.status_code == 403, res.text
        assert res.json()["detail"]["error"] == "impersonation_read_only"

    def test_unmarked_delete_is_denied(self, db, monkeypatch):
        """The guard keys on the HTTP method, not on POST specifically — and it
        applies to ``get_current_client_or_operator`` too."""
        admin = _mk_admin(db, "imp-g3-admin@test.example")
        target = _mk_target(db, "imp-g3-target@test.example")
        raw, _ = _mk_token(db, admin, target)
        c = _probe_client(db, monkeypatch)

        res = c.delete("/probe", headers={"X-Impersonation-Token": raw})
        assert res.status_code == 403, res.text

    def test_marked_post_is_allowed(self, db, monkeypatch):
        admin = _mk_admin(db, "imp-g4-admin@test.example")
        target = _mk_target(db, "imp-g4-target@test.example")
        target_id = target.id
        raw, _ = _mk_token(db, admin, target)
        c = _probe_client(db, monkeypatch)

        res = c.post("/probe/marked", headers={"X-Impersonation-Token": raw})
        assert res.status_code == 200, res.text
        assert res.json()["client_id"] == target_id

    def test_guard_does_not_touch_ordinary_api_key_writes(self, db, monkeypatch):
        """The guard is scoped to impersonated callers — a customer POSTing to
        an unmarked route with their own key must keep working."""
        target = _mk_target(db, "imp-g5-target@test.example")
        target_id, api_key = target.id, target.api_key
        c = _probe_client(db, monkeypatch)

        res = c.post("/probe", headers={"X-API-Key": api_key})
        assert res.status_code == 200, res.text
        assert res.json()["client_id"] == target_id

    def test_marker_is_readable_from_the_matched_route(self):
        """``impersonation_writable`` must set the attribute on the function the
        router registers, which is why it goes BELOW the route decorator."""

        @auth.impersonation_writable
        def handler():
            return None

        assert handler.impersonation_writable is True

    def test_newly_registered_mutating_route_is_denied_by_default(self, db, monkeypatch):
        """REGRESSION GUARD — do not delete.

        A mutating route added later, by someone who has never heard of
        impersonation, must be inert under an impersonated session until a human
        deliberately marks it. This test simulates exactly that: it registers a
        brand new POST route carrying no marker and asserts the guard denies it.
        If this ever goes green-by-allowing, the write guard has silently
        flipped from default-deny to default-allow.
        """
        admin = _mk_admin(db, "imp-reg-admin@test.example")
        target = _mk_target(db, "imp-reg-target@test.example")
        raw, _ = _mk_token(db, admin, target)
        _patch_session(monkeypatch, db)

        app = FastAPI()

        @app.post("/a-route-someone-added-later")
        def newly_added_route(client: Client = Depends(auth.get_current_client)):
            return {"client_id": client.id}

        c = TestClient(app)
        res = c.post("/a-route-someone-added-later", headers={"X-Impersonation-Token": raw})
        assert res.status_code == 403, res.text
        assert res.json()["detail"]["error"] == "impersonation_read_only"


# ── Audit tagging of permitted writes ───────────────────────────────────────


class TestAuditTagging:
    def test_audit_row_records_the_real_actor(self, db, monkeypatch):
        """A permitted write under impersonation must be attributed to the
        super-admin who performed it, not to the customer being impersonated."""
        admin = _mk_admin(db, "imp-aud-admin@test.example")
        target = _mk_target(db, "imp-aud-target@test.example")
        admin_id, admin_name, target_id, target_name = admin.id, admin.name, target.id, target.name
        raw, token_id = _mk_token(db, admin, target)
        _patch_session(monkeypatch, db)

        client = auth.get_current_client(
            _http_request(),
            api_key=None,
            operator_key=None,
            legacy_agent_key=None,
            impersonation_token=raw,
        )

        entry = record_audit(
            db,
            actor=client,
            action="bot.update",
            target_type="bot",
            target_id=7,
            after={"name": "Renamed"},
        )

        assert entry is not None
        assert entry.actor_id == admin_id
        assert admin_name in entry.actor_name
        assert target_name in entry.actor_name
        assert entry.after["name"] == "Renamed"
        assert entry.after["impersonation"]["impersonator_id"] == admin_id
        assert entry.after["impersonation"]["impersonated_client_id"] == target_id
        assert entry.after["impersonation"]["impersonation_token_id"] == token_id

    def test_audit_row_unchanged_for_an_ordinary_caller(self, db):
        """The common (non-impersonated) path must be byte-for-byte unchanged."""
        target = _mk_target(db, "imp-aud2-target@test.example")
        target_id, target_name = target.id, target.name

        entry = record_audit(
            db,
            actor=target,
            action="bot.update",
            target_type="bot",
            target_id=7,
            after={"name": "Renamed"},
        )

        assert entry is not None
        assert entry.actor_id == target_id
        assert entry.actor_name == target_name
        assert entry.after == {"name": "Renamed"}
        assert db.query(AuditLog).filter(AuditLog.action == "bot.update").count() == 1


# ── Owner-preview chat under impersonation ───────────────────────────────────


class TestImpersonatedPreviewChat:
    """``get_bot_for_chat`` must accept an impersonation token, but ONLY on the
    free owner-preview path.

    Without this, the "preview-mode test chat" entry in the design's §6.1
    allowlist is decoration: the resolver required ``X-API-Key``, which an
    impersonated session deliberately does not send and whose Client attribute
    is scrubbed to ``None``, so the branch was structurally unreachable and the
    caller 401'd at bot auth before the write guard ever ran.
    """

    def _bot_for(self, db, owner: Client, bot_key: str) -> Bot:
        bot = Bot(client_id=owner.id, bot_key=bot_key, name="Preview Agent")
        db.add(bot)
        db.flush()
        return bot

    def test_impersonated_preview_resolves_the_bot_for_free(self, db, monkeypatch):
        _patch_session(monkeypatch, db)
        admin = _mk_admin(db, "imp-prev-admin@test.example")
        target = _mk_target(db, "imp-prev-target@test.example")
        bot = self._bot_for(db, target, "bot-imp-preview-1")
        raw, _ = _mk_token(db, admin, target)

        resolved = auth.get_bot_for_chat(
            _http_request("POST", "/chat"),
            preview=True,
            bot_id=bot.id,
            bot_key=None,
            api_key=None,
            impersonation_token=raw,
        )

        assert resolved.id == bot.id
        # ``_is_preview`` is what makes this safe: the reply skips credit
        # deduction, so a support session cannot spend the Account's money.
        assert resolved._is_preview is True

    def test_impersonation_alone_cannot_reach_the_paid_widget_path(self, db, monkeypatch):
        """Without ``preview``, the token must NOT authenticate a chat request.

        The paid path on this same endpoint deducts the Account's credits, so
        the impersonation token is never forwarded to ``get_current_bot``.
        """
        _patch_session(monkeypatch, db)
        admin = _mk_admin(db, "imp-prev-paid-admin@test.example")
        target = _mk_target(db, "imp-prev-paid-target@test.example")
        self._bot_for(db, target, "bot-imp-preview-2")
        raw, _ = _mk_token(db, admin, target)

        with pytest.raises(HTTPException) as exc:
            auth.get_bot_for_chat(
                _http_request("POST", "/chat"),
                preview=False,
                bot_id=None,
                bot_key=None,
                api_key=None,
                impersonation_token=raw,
            )
        assert exc.value.status_code == 401

    def test_revoked_token_cannot_preview(self, db, monkeypatch):
        _patch_session(monkeypatch, db)
        admin = _mk_admin(db, "imp-prev-rev-admin@test.example")
        target = _mk_target(db, "imp-prev-rev-target@test.example")
        bot = self._bot_for(db, target, "bot-imp-preview-3")
        raw, token_id = _mk_token(db, admin, target)
        db.get(ImpersonationToken, token_id).revoked_at = datetime.now(UTC)
        db.flush()

        with pytest.raises(HTTPException) as exc:
            auth.get_bot_for_chat(
                _http_request("POST", "/chat"),
                preview=True,
                bot_id=bot.id,
                bot_key=None,
                api_key=None,
                impersonation_token=raw,
            )
        assert exc.value.status_code == 401

    def test_impersonation_cannot_preview_another_accounts_bot(self, db, monkeypatch):
        """Tenant scoping still applies — the token grants ONE Account."""
        _patch_session(monkeypatch, db)
        admin = _mk_admin(db, "imp-prev-x-admin@test.example")
        target = _mk_target(db, "imp-prev-x-target@test.example")
        stranger = _mk_target(db, "imp-prev-x-stranger@test.example")
        foreign_bot = self._bot_for(db, stranger, "bot-imp-preview-4")
        raw, _ = _mk_token(db, admin, target)

        with pytest.raises(HTTPException) as exc:
            auth.get_bot_for_chat(
                _http_request("POST", "/chat"),
                preview=True,
                bot_id=foreign_bot.id,
                bot_key=None,
                api_key=None,
                impersonation_token=raw,
            )
        assert exc.value.status_code == 404

    def test_suspended_account_can_still_be_previewed(self, db, monkeypatch):
        """Decision D-2: debugging a suspended Account is a core support need."""
        _patch_session(monkeypatch, db)
        admin = _mk_admin(db, "imp-prev-susp-admin@test.example")
        target = _mk_target(db, "imp-prev-susp-target@test.example", suspended_at=datetime.now(UTC))
        bot = self._bot_for(db, target, "bot-imp-preview-5")
        raw, _ = _mk_token(db, admin, target)

        resolved = auth.get_bot_for_chat(
            _http_request("POST", "/chat"),
            preview=True,
            bot_id=bot.id,
            bot_key=None,
            api_key=None,
            impersonation_token=raw,
        )
        assert resolved.id == bot.id

    def test_owner_api_key_preview_is_unchanged(self, db, monkeypatch):
        """The pre-existing Build Studio path must behave exactly as before."""
        _patch_session(monkeypatch, db)
        owner = _mk_target(db, "imp-prev-owner@test.example")
        bot = self._bot_for(db, owner, "bot-imp-preview-6")

        resolved = auth.get_bot_for_chat(
            _http_request("POST", "/chat"),
            preview=True,
            bot_id=bot.id,
            bot_key=None,
            api_key=owner.api_key,
            impersonation_token=None,
        )
        assert resolved.id == bot.id
        assert resolved._is_preview is True


# ── Privilege re-checks on every request (not just at mint) ──────────────────


class TestImpersonationPrivilegeRechecks:
    """Mint-time checks are not enough for a credential that outlives them.

    ``get_current_client_strict`` honours ``X-Impersonation-Token`` and
    ``get_superadmin`` depends on it, inspecting only the RESOLVED client. So a
    token whose target is (or becomes) a super-admin grants the whole
    ``/superadmin/*`` surface — and every read there is a safe method the write
    guard waves through, so the escalation leaks every Account's data, not one.
    """

    def test_token_whose_target_was_promoted_is_rejected(self, db, monkeypatch):
        """The promotion happens AFTER minting — the mint filter cannot see it."""
        _patch_session(monkeypatch, db)
        admin = _mk_admin(db, "esc-promo-admin@test.example")
        target = _mk_target(db, "esc-promo-target@test.example")
        raw, _ = _mk_token(db, admin, target)

        # Sanity: resolves fine while the target is an ordinary Account.
        assert (
            auth.get_current_client(
                _http_request(),
                api_key=None,
                operator_key=None,
                legacy_agent_key=None,
                impersonation_token=raw,
            ).id
            == target.id
        )

        db.get(Client, target.id).is_superadmin = True
        db.flush()

        assert _resolve_expecting_401(raw) == auth.IMPERSONATION_REJECTED_DETAIL

    def test_token_from_a_demoted_actor_is_rejected(self, db, monkeypatch):
        """Offboarding a super-admin must kill the tokens they already minted."""
        _patch_session(monkeypatch, db)
        admin = _mk_admin(db, "esc-demote-admin@test.example")
        target = _mk_target(db, "esc-demote-target@test.example")
        raw, _ = _mk_token(db, admin, target)

        db.get(Client, admin.id).is_superadmin = False
        db.flush()

        assert _resolve_expecting_401(raw) == auth.IMPERSONATION_REJECTED_DETAIL

    def test_preview_path_also_rejects_a_superadmin_target(self, db, monkeypatch):
        """``_resolve_preview_client`` is a second entry point and needs the same rule."""
        _patch_session(monkeypatch, db)
        admin = _mk_admin(db, "esc-prev-admin@test.example")
        target = _mk_target(db, "esc-prev-target@test.example")
        bot = Bot(client_id=target.id, bot_key="bot-esc-preview", name="Esc Agent")
        db.add(bot)
        db.flush()
        raw, _ = _mk_token(db, admin, target)

        db.get(Client, target.id).is_superadmin = True
        db.flush()

        with pytest.raises(HTTPException) as exc:
            auth.get_bot_for_chat(
                _http_request("POST", "/chat"),
                preview=True,
                bot_id=bot.id,
                bot_key=None,
                api_key=None,
                impersonation_token=raw,
            )
        assert exc.value.status_code == 401

    def test_preview_path_also_rejects_a_demoted_actor(self, db, monkeypatch):
        """Mirror of the demoted-actor rule on the preview entry point: an
        offboarded admin's outstanding token must not keep exercising the
        target's AI Agent (its knowledge base is the customer's proprietary
        content) for the token's remaining life."""
        _patch_session(monkeypatch, db)
        admin = _mk_admin(db, "esc-prev-demote-admin@test.example")
        target = _mk_target(db, "esc-prev-demote-target@test.example")
        bot = Bot(client_id=target.id, bot_key="bot-esc-prev-demote", name="Esc Agent")
        db.add(bot)
        db.flush()
        raw, _ = _mk_token(db, admin, target)

        db.get(Client, admin.id).is_superadmin = False
        db.flush()

        with pytest.raises(HTTPException) as exc:
            auth.get_bot_for_chat(
                _http_request("POST", "/chat"),
                preview=True,
                bot_id=bot.id,
                bot_key=None,
                api_key=None,
                impersonation_token=raw,
            )
        assert exc.value.status_code == 401
