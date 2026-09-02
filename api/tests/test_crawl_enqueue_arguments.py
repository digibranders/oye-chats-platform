"""What the crawl route hands the worker must land where the worker expects it.

The route enqueued nine values POSITIONALLY. The task then grew a `free_pages`
parameter between `cost_per_page` and `max_depth`, and every argument after the
insertion point shifted one slot left without a single test noticing:

    cost_per_page   -> cost_per_page   ok
    plan_max_depth  -> free_pages      wrong
    plan_concurrency-> max_depth       wrong
    (nothing)       -> concurrency     wrong, took its default

`free_pages` is the trial's free-training-page allowance. Receiving
`max_crawl_depth` (3) instead meant a trial customer with 25 free pages was
charged for about 22 of them, while a paid account whose allowance is 0 was
handed 3 free pages on every crawl. Both crawl knobs also stopped varying by
plan. The inline `WORKER_ENABLED=false` fallback in the same function always
passed keywords, so it stayed correct and local runs never showed any of it.

These bind the captured call against the REAL task signature rather than
asserting on a list of positions, so the next parameter inserted into the task
cannot reintroduce the same silent shift.
"""

from __future__ import annotations

import inspect
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import document_routes
from app.api.auth import (
    get_current_client_or_operator,
    require_active_subscription_for_workspace,
    require_verified_email_for_workspace,
)
from app.api.document_routes import router
from app.services.plan_service import UNLIMITED

PLAN_DEPTH = 4
PLAN_CONCURRENCY = 6
FREE_TRAINING_PAGES = 25


@contextmanager
def _session_ctx(session):
    yield session


@pytest.fixture()
def captured(monkeypatch):
    """Drive POST /crawl and hand back the arguments the worker was given."""
    calls: list[tuple[tuple, dict]] = []

    monkeypatch.setattr("app.schemas.client._is_public_hostname", lambda h: True)

    fake_session = MagicMock()
    fake_session.execute.return_value.scalar_one_or_none.return_value = SimpleNamespace(id=7, client_id=1)
    # `resolve_crawl_pricing` counts already-crawled pages with `.scalar()`.
    # Zero used, so the whole allowance is still available.
    fake_session.execute.return_value.scalar.return_value = 0
    fake_session.get.return_value = SimpleNamespace(id=7, client_id=1, subscription_id=99, is_legacy_pooled=False)
    monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(fake_session))

    monkeypatch.setattr(
        "app.services.plan_service.get_client_plan",
        lambda db, cid: SimpleNamespace(slug="trial", name="Trial"),
    )
    monkeypatch.setattr(
        "app.services.plan_service.get_crawl_limits",
        lambda plan: {
            "max_crawl_pages": UNLIMITED,
            "max_crawl_depth": PLAN_DEPTH,
            "max_crawl_js_pages": 50,
            "max_crawl_concurrency": PLAN_CONCURRENCY,
        },
    )
    monkeypatch.setattr("app.services.credit_service.get_credit_cost", lambda db, action: 5)
    monkeypatch.setattr(
        "app.services.plan_entitlements_service.get_entitlements",
        lambda client_id, session, **kw: SimpleNamespace(
            has_feature=lambda name: False,
            limit_for=lambda name: FREE_TRAINING_PAGES if name == "free_training_pages" else 0,
        ),
    )
    monkeypatch.setattr("app.services.credit_service.resolve_bot_ledger_bot_id", lambda bot: 7)
    monkeypatch.setattr("app.services.credit_service.get_balance", lambda db, cid, bot_id=None: 10_000)
    monkeypatch.setattr(document_routes, "_check_memory", lambda: None)
    monkeypatch.setattr(document_routes, "clear_cancellation", lambda client_id: None)
    monkeypatch.setattr(document_routes, "set_crawl_progress", lambda *a, **k: None)

    async def _fake_lock(client_id):
        return "test-lock-token"

    monkeypatch.setattr(document_routes, "_acquire_crawl_lock_or_preempt", _fake_lock)
    monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", True)

    async def _fake_enqueue(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(job_id="job-123")

    monkeypatch.setattr("app.worker.enqueue.enqueue", _fake_enqueue)

    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": SimpleNamespace(id=1),
        "client_id": 1,
        "operator_id": None,
    }
    app.dependency_overrides[require_active_subscription_for_workspace] = lambda: None
    app.dependency_overrides[require_verified_email_for_workspace] = lambda: None

    resp = TestClient(app).post(
        "/crawl",
        params={"bot_id": 7},
        json={"url": "https://acme.test", "max_pages": 10},
    )
    assert resp.status_code == 202, resp.text
    assert calls, "the route did not enqueue anything"
    return calls[0]


def _bind(captured) -> inspect.BoundArguments:
    """Resolve the call the way ARQ will, against the real task signature."""
    from app.worker.tasks import task_crawl_and_ingest

    args, kwargs = captured
    assert args[0] == "task_crawl_and_ingest"
    sig = inspect.signature(task_crawl_and_ingest)
    # `ctx` is supplied by the worker, not the caller.
    bound = sig.bind_partial(None, *args[1:], **kwargs)
    bound.apply_defaults()
    return bound


def test_the_free_training_allowance_reaches_the_worker(captured):
    """The money assertion. `free_pages` decides what the customer is charged."""
    assert _bind(captured).arguments["free_pages"] == FREE_TRAINING_PAGES


def test_the_plan_crawl_knobs_are_not_shifted_into_each_other(captured):
    bound = _bind(captured).arguments
    assert bound["max_depth"] == PLAN_DEPTH
    assert bound["concurrency"] == PLAN_CONCURRENCY


def test_the_leading_arguments_still_land_correctly(captured):
    bound = _bind(captured).arguments
    assert bound["client_id"] == 1
    assert bound["bot_id"] == 7
    assert bound["url"] == "https://acme.test"
    assert bound["cost_per_page"] == 5


def test_nothing_is_passed_positionally(captured):
    """Positional coupling to a signature that grows is the whole defect.

    Keywords are what make an inserted parameter a no-op here instead of a
    silent one-slot shift of everything after it.
    """
    args, _ = captured
    assert args == ("task_crawl_and_ingest",), f"unexpected positional args: {args[1:]}"
