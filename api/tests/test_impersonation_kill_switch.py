"""Impersonation kill switch (design §14).

The switch has two asymmetric layers:

* ``IMPERSONATION_ENABLED`` (env) is the floor — false means off, full stop,
  without consulting the DB, so it survives a DB outage or a rogue
  ``pricing_config`` edit.
* ``impersonation.enabled`` (pricing_config row) is the fast lever — flip it
  from the super-admin UI and it applies on the next request.

The property that matters most: because validity is re-checked per request,
turning the switch off ends sessions **already in flight**, not just new
redemptions. A switch that leaves live sessions running is not a kill switch.
"""

import hashlib
import os
import secrets
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from app.api import auth, superadmin_routes_v2
from app.api.auth import get_superadmin
from app.db.models import Bot, Client, ImpersonationToken
from app.services import runtime_config

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


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


def _http_request(method: str = "GET", path: str = "/probe") -> Request:
    """A minimal ASGI request for calling the resolvers directly."""
    return Request({"type": "http", "method": method, "path": path, "headers": []})


def _disable_via_runtime(monkeypatch) -> None:
    """Simulate the pricing_config row being flipped off."""
    monkeypatch.setattr(
        runtime_config, "get", lambda key, default=None: False if key == "impersonation.enabled" else default
    )


def _disable_via_env(monkeypatch) -> None:
    """Simulate IMPERSONATION_ENABLED=false — the floor, DB not consulted."""
    monkeypatch.setattr(runtime_config, "IMPERSONATION_ENABLED", False)


# ── The two layers ───────────────────────────────────────────────────────────


class TestSwitchLayers:
    def test_enabled_by_default(self):
        assert runtime_config.is_impersonation_enabled() is True

    def test_runtime_row_can_disable(self, monkeypatch):
        _disable_via_runtime(monkeypatch)
        assert runtime_config.is_impersonation_enabled() is False

    def test_env_floor_disables_without_consulting_the_db(self, monkeypatch):
        _disable_via_env(monkeypatch)

        def _explode(*_a, **_kw):  # pragma: no cover - must never be called
            raise AssertionError("DB must not be consulted when the env floor is off")

        monkeypatch.setattr(runtime_config, "get", _explode)
        assert runtime_config.is_impersonation_enabled() is False

    @pytest.mark.parametrize("raw", ["false", "FALSE", "0", "no", "off", " Off "])
    def test_falsy_strings_disable(self, monkeypatch, raw):
        monkeypatch.setattr(runtime_config, "get", lambda key, default=None: raw)
        assert runtime_config.is_impersonation_enabled() is False

    @pytest.mark.parametrize("raw", ["true", "1", "yes", "on"])
    def test_truthy_strings_enable(self, monkeypatch, raw):
        monkeypatch.setattr(runtime_config, "get", lambda key, default=None: raw)
        assert runtime_config.is_impersonation_enabled() is True

    def test_unparseable_db_value_stays_enabled(self, monkeypatch):
        """The env var is the mechanism for an unambiguous off, not a typo."""
        monkeypatch.setattr(runtime_config, "get", lambda key, default=None: "banana")
        assert runtime_config.is_impersonation_enabled() is True


# ── Enforcement at every entry point ─────────────────────────────────────────


class TestEnforcement:
    def test_in_flight_session_is_ended(self, db, monkeypatch):
        """The headline property: a live, valid, unrevoked token stops working."""
        monkeypatch.setattr(auth, "get_session", lambda: _ctx(db))
        admin = _mk_admin(db, "ks-live-admin@test.example")
        target = _mk_target(db, "ks-live-target@test.example")
        raw = _mk_token(db, admin, target)

        # Sanity: it works while enabled.
        resolved = auth.get_current_client(
            _http_request(),
            api_key=None,
            operator_key=None,
            legacy_agent_key=None,
            impersonation_token=raw,
        )
        assert resolved.id == target.id

        monkeypatch.setattr(auth, "is_impersonation_enabled", lambda: False)
        with pytest.raises(HTTPException) as exc:
            auth.get_current_client(
                _http_request(),
                api_key=None,
                operator_key=None,
                legacy_agent_key=None,
                impersonation_token=raw,
            )
        # 401, not 403 — the customer app treats 401 as "session ended" and
        # renders its terminal notice, cleanly ejecting the tab.
        assert exc.value.status_code == 401

    def test_preview_chat_path_is_disabled(self, db, monkeypatch):
        monkeypatch.setattr(auth, "get_session", lambda: _ctx(db))
        monkeypatch.setattr(auth, "is_impersonation_enabled", lambda: False)
        admin = _mk_admin(db, "ks-prev-admin@test.example")
        target = _mk_target(db, "ks-prev-target@test.example")
        bot = Bot(client_id=target.id, bot_key="bot-ks-preview", name="KS Agent")
        db.add(bot)
        db.flush()
        raw = _mk_token(db, admin, target)

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

    def test_mint_is_blocked_and_writes_no_row(self, db, monkeypatch):
        monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
        monkeypatch.setattr(superadmin_routes_v2, "is_impersonation_enabled", lambda: False)
        admin = _mk_admin(db, "ks-mint-admin@test.example")
        target = _mk_target(db, "ks-mint-target@test.example")

        app = FastAPI()
        app.include_router(superadmin_routes_v2.router)
        app.dependency_overrides[get_superadmin] = lambda: admin
        before = db.query(ImpersonationToken).count()

        res = TestClient(app).post(f"/superadmin/clients/{target.id}/impersonate")
        assert res.status_code == 403
        assert "disabled" in res.json()["detail"].lower()
        assert db.query(ImpersonationToken).count() == before

    def test_redeem_is_blocked_with_a_distinct_status(self, db, monkeypatch):
        """403 + a real message, NOT the 401 "expired or revoked".

        The customer app renders the server's message for a 403 but shows
        "this link has expired" for a 401 — an operator debugging a flipped
        kill switch must not be told the link expired.
        """
        from app.api import auth_routes

        monkeypatch.setattr(auth_routes, "get_session", lambda: _ctx(db))
        monkeypatch.setattr(auth_routes, "is_impersonation_enabled", lambda: False)
        admin = _mk_admin(db, "ks-redeem-admin@test.example")
        target = _mk_target(db, "ks-redeem-target@test.example")
        raw = _mk_token(db, admin, target)

        with pytest.raises(HTTPException) as exc:
            auth_routes.redeem_impersonation_token(
                _http_request("POST", "/auth/impersonation/redeem"),
                auth_routes.ImpersonationRedeemRequest(token=raw),
            )
        assert exc.value.status_code == 403
        assert "disabled" in exc.value.detail.lower()

    def test_the_runtime_lever_is_reachable_through_the_api(self, db, monkeypatch):
        """A kill switch you cannot flip is not a kill switch.

        ``PUT /superadmin/model-config`` writes runtime config through an
        explicit field->key map; a key absent from that map has no API path at
        all and could only be changed by a deploy or a manual DB edit. This
        pins that ``impersonation.enabled`` is wired into it, persists, and
        invalidates the cache so the next request sees it.
        """
        from app.db.models import PricingConfig

        monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
        admin = _mk_admin(db, "ks-lever-admin@test.example")

        app = FastAPI()
        app.include_router(superadmin_routes_v2.router)
        app.dependency_overrides[get_superadmin] = lambda: admin

        res = TestClient(app).put("/superadmin/model-config", json={"impersonation_enabled": False})
        assert res.status_code == 200, res.text
        # The endpoint reports the pricing_config key, not the request field.
        assert "impersonation.enabled" in res.json()["changed"]

        row = db.get(PricingConfig, "impersonation.enabled")
        assert row is not None and row.value is False

        # And the getter honours it once the cache is refreshed.
        monkeypatch.setattr(
            runtime_config, "get", lambda key, default=None: row.value if key == "impersonation.enabled" else default
        )
        assert runtime_config.is_impersonation_enabled() is False

    def test_revoke_still_works_while_disabled(self, db, monkeypatch):
        """Revocation only ever reduces privilege, and an operator may need it
        precisely *because* they flipped the switch."""
        monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
        monkeypatch.setattr(superadmin_routes_v2, "is_impersonation_enabled", lambda: False)
        admin = _mk_admin(db, "ks-rev-admin@test.example")
        target = _mk_target(db, "ks-rev-target@test.example")
        _mk_token(db, admin, target)
        token = db.query(ImpersonationToken).filter(ImpersonationToken.actor_id == admin.id).first()

        app = FastAPI()
        app.include_router(superadmin_routes_v2.router)
        app.dependency_overrides[get_superadmin] = lambda: admin

        res = TestClient(app).post(f"/superadmin/impersonation/{token.id}/revoke")
        assert res.status_code == 200
        assert db.get(ImpersonationToken, token.id).revoked_at is not None
