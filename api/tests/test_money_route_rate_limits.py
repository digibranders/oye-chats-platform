"""Wave 3.2 (M7): per-client abuse ceilings on the money routes.

Generous limits (10/min on mandate-minting routes) that a real customer can
never feel, keyed on the API key so the ceiling is per account. Applied as a
FastAPI dependency rather than @limiter.limit because these routes name their
Pydantic BODY `request`, the decorator resolves the request by parameter
name and would hand the key function the body model.
"""

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import subscription_routes
from app.api.auth import get_current_client_strict, require_verified_email
from app.db.models import Client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def test_checkout_burst_hits_the_ceiling(db, monkeypatch):
    client = Client(name="RL", email="rl@test.example", api_key="key-rl-burst")
    db.add(client)
    db.flush()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: None)
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    app.dependency_overrides[require_verified_email] = lambda: client
    api = TestClient(app)

    # A nonexistent plan 404s AFTER the limit dependency, so every call counts.
    headers = {"x-api-key": "key-rl-burst"}
    statuses = [
        api.post("/subscriptions/checkout", json={"plan_id": 999999}, headers=headers).status_code for _ in range(11)
    ]
    assert statuses[:10] == [404] * 10
    assert statuses[10] == 429


def test_different_clients_have_separate_buckets(db, monkeypatch):
    client = Client(name="RL2", email="rl2@test.example", api_key="key-rl-a")
    db.add(client)
    db.flush()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    monkeypatch.setattr(subscription_routes, "resolve_country", lambda request: None)
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[get_current_client_strict] = lambda: client
    app.dependency_overrides[require_verified_email] = lambda: client
    api = TestClient(app)

    for _ in range(10):
        api.post("/subscriptions/checkout", json={"plan_id": 999999}, headers={"x-api-key": "key-rl-a"})
    # Key A is exhausted; key B still has a fresh bucket.
    assert (
        api.post("/subscriptions/checkout", json={"plan_id": 999999}, headers={"x-api-key": "key-rl-a"}).status_code
        == 429
    )
    assert (
        api.post("/subscriptions/checkout", json={"plan_id": 999999}, headers={"x-api-key": "key-rl-b"}).status_code
        == 404
    )
