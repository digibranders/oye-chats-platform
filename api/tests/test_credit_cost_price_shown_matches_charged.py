"""The per-action credit price ``GET /credits/balance`` SHOWS is the one that CHARGES.

``pricing_config.value`` is untyped JSONB and ``PUT /superadmin/pricing-config/{key}``
takes ``value: Any``, so whatever a super admin types in the pricing panel reaches
these reads verbatim. Two things must hold for every credit_cost key:

* the balance payload must never raise on a bad value — a typo in an internal
  admin panel must not 500 the Usage and Billing pages for every customer; and
* the number it serves must equal the number the deduction path computes, or the
  console advertises one price beside a charge for another.

The document-upload pair already had this guard (``test_document_upload_rate``).
These pin the other five actions, which read the raw config directly.
"""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import superadmin_routes_v2
from app.api.auth import get_superadmin
from app.api.subscription_routes import _credit_costs_payload
from app.db.models import Client, PricingConfig
from app.services import credit_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

# Every action the payload prices, minus the two document-upload fields, which
# already route through the charge path's clamping accessors.
ACTIONS = ["ai_chat", "url_scan", "email_send", "email_verification", "company_name"]

# What a super admin can actually save into the untyped JSONB ``value``: a
# cleared field, a typo'd sign, a word, a decimal, a pasted list.
BROKEN_VALUES = [None, -5, "free", 1.5, [1], True, "3"]


@pytest.fixture(autouse=True)
def _clean_pricing_cache():
    credit_service.invalidate_pricing_cache()
    yield
    credit_service.invalidate_pricing_cache()


def _override(db, key: str, value: object) -> None:
    """Write one pricing_config row the way the super-admin panel would."""
    db.merge(PricingConfig(key=key, value=value))
    db.commit()
    credit_service.invalidate_pricing_cache()


@pytest.mark.parametrize("action", ACTIONS)
@pytest.mark.parametrize("broken", BROKEN_VALUES)
def test_a_bad_price_never_500s_the_balance_endpoint(db, action, broken):
    """One mistyped value in the pricing panel must not take the page down.

    ``GET /credits/balance`` backs the Usage and Billing pages for EVERY
    customer. A ``ValueError`` here is a platform-wide outage triggered by a
    single internal typo, while billing carries on charging correctly.
    """
    _override(db, f"credit_cost.{action}", broken)
    payload = _credit_costs_payload(db)
    assert isinstance(payload[action], int)
    assert payload[action] >= 0


@pytest.mark.parametrize("action", ACTIONS)
@pytest.mark.parametrize("broken", BROKEN_VALUES)
def test_the_price_shown_is_the_price_charged(db, action, broken):
    """Whatever the config says, the console is told what the ledger will take."""
    _override(db, f"credit_cost.{action}", broken)
    assert _credit_costs_payload(db)[action] == credit_service.get_credit_cost(db, action)


@pytest.mark.parametrize("action", ACTIONS)
def test_a_real_override_moves_both_halves(db, action):
    """The clamping must not flatten a legitimate super-admin price."""
    _override(db, f"credit_cost.{action}", 9)
    assert _credit_costs_payload(db)[action] == 9
    assert credit_service.get_credit_cost(db, action) == 9


@pytest.mark.parametrize(
    ("broken", "why"),
    [
        (None, "a cleared field is not 'free'"),
        (-5, "a negative price is a typo, not a rebate"),
        ("free", "a word is not a price"),
        ([1], "a pasted list is not a price"),
        # JSONB itself rejects a bare NaN/Infinity token, but ``float()``
        # happily parses these as STRINGS, and a JSON text field accepts them.
        ("NaN", "NaN is not a price"),
        ("Infinity", "infinity is not a price"),
    ],
)
def test_get_credit_cost_fails_closed_on_an_unusable_value(db, broken, why):
    """The charge path's own clamp: unusable means charge the default, never 0.

    ``max(int(raw), 0)`` turned a negative into a FREE action — a revenue leak
    on exactly the typo this helper exists to survive.
    """
    _override(db, "credit_cost.ai_chat", broken)
    assert credit_service.get_credit_cost(db, "ai_chat") == credit_service._DEFAULT_CREDIT_COST, why


def test_an_explicit_zero_is_still_honoured_as_free(db):
    """0 is a deliberate 'this action is free', not a malformed value."""
    _override(db, "credit_cost.ai_chat", 0)
    assert credit_service.get_credit_cost(db, "ai_chat") == 0
    assert _credit_costs_payload(db)["ai_chat"] == 0


def test_a_fractional_price_is_charged_as_a_whole_credit(db):
    """Credits are whole units; a partial one is charged as one, never truncated.

    Matches ``get_document_upload_cost_for_size``'s "a partial block of words is
    a whole credit". Truncating 1.5 to 1 would undercharge silently.
    """
    _override(db, "credit_cost.ai_chat", 1.5)
    assert credit_service.get_credit_cost(db, "ai_chat") == 2
    assert _credit_costs_payload(db)["ai_chat"] == 2


# ── The write side: a typo should not reach the database at all ──────────────


@contextmanager
def _ctx(session):
    yield session


def _superadmin_client(db, monkeypatch) -> TestClient:
    """A TestClient for the pricing-config editor, authenticated as an owner."""
    admin = Client(
        name="Super Admin",
        email="root@oyechats.test",
        api_key="key-root",
        is_superadmin=True,
        superadmin_role="owner",
    )
    db.add(admin)
    db.commit()
    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: admin
    return TestClient(app)


@pytest.mark.parametrize("broken", [None, -5, "free", 1.5, [1], True, "3"])
def test_the_pricing_panel_refuses_a_value_that_is_not_a_credit_count(db, monkeypatch, broken):
    """Failing closed on read is not the same as accepting the typo.

    A super admin who saved ``"fre"`` into ``credit_cost.ai_chat`` got a 200 and
    a panel that showed it saved, while every chat carried on being charged the
    fail-closed default. Refuse at the boundary so the stored value means what
    the panel says it means.
    """
    client = _superadmin_client(db, monkeypatch)
    resp = client.put("/superadmin/pricing-config/credit_cost.ai_chat", json={"value": broken})
    assert resp.status_code == 422, resp.text
    assert db.get(PricingConfig, "credit_cost.ai_chat") is None, "the bad value must not have been stored"


def test_a_zero_divisor_is_refused_rather_than_silently_ignored(db, monkeypatch):
    """0 words per credit is not a price change; the charge path ignores it."""
    client = _superadmin_client(db, monkeypatch)
    resp = client.put(
        "/superadmin/pricing-config/credit_cost.document_upload_words_per_credit",
        json={"value": 0},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.parametrize("value", [0, 1, 7, 500])
def test_a_real_price_still_saves(db, monkeypatch, value):
    """The guard must not block the panel's actual job."""
    client = _superadmin_client(db, monkeypatch)
    resp = client.put("/superadmin/pricing-config/credit_cost.ai_chat", json={"value": value})
    assert resp.status_code == 200, resp.text
    assert db.get(PricingConfig, "credit_cost.ai_chat").value == value


def test_non_credit_cost_keys_are_untouched_by_the_guard(db, monkeypatch):
    """``pricing_config`` is a shared KV store: packs are lists, switches bools."""
    client = _superadmin_client(db, monkeypatch)
    assert client.put("/superadmin/pricing-config/kill_switch", json={"value": True}).status_code == 200
    packs = [{"inr": 1000, "credits": 2000}]
    assert client.put("/superadmin/pricing-config/topup_packs", json={"value": packs}).status_code == 200
