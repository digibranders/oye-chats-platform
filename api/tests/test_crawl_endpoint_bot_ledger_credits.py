# Regression test for the /documents/crawl credit precheck-vs-deduction bucket
# mismatch: the pipeline (app/ingestion/pipeline.py::batch_web_ingestion)
# deducts crawl credits from the RESOLVED BOT LEDGER bucket
# (credit_service.check_and_deduct(..., bot_id=ledger_bot_id)), so the
# pre-flight gate in crawl_endpoint must check that SAME bucket via
# credit_service.get_balance(db, client_id, bot_id=ledger_bot_id), not the
# client pool (bot_id=None). Otherwise a per-bot subscriber with an empty
# client pool but a funded bot ledger gets hard-402'd forever, or (the
# inverse) a subscriber with an empty bot ledger but stale client-pool
# credits gets waved through a crawl the pipeline will then reject mid-run.
#
# Harness mirrors tests/test_crawl_discover_credits.py: bare FastAPI app +
# router + dependency overrides + monkeypatched get_session. No async_client.
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

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


@contextmanager
def _session_ctx(session):
    yield session


def _build_app():
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
    return app


def _patch_common(monkeypatch, *, balances_by_bucket: dict[str, int], plan_max_pages=UNLIMITED):
    """Wire up everything crawl_endpoint touches besides the credit gate.

    ``balances_by_bucket`` maps "client_pool" -> balance when bot_id is None
    and "bot_ledger" -> balance when a bot_id IS passed through, so the fake
    ``get_balance`` can prove which bucket the endpoint actually queried.
    """
    # SSRF hostname check on CrawlRequest.url. Bypass for the fake test domain.
    monkeypatch.setattr("app.schemas.client._is_public_hostname", lambda h: True)

    # A session whose ORM query for bot ownership (_verify_bot_ownership) and
    # ``db.get(Bot, bot_id)`` (ledger resolution) both resolve truthy.
    fake_session = MagicMock()
    fake_session.execute.return_value.scalar_one_or_none.return_value = SimpleNamespace(id=7, client_id=1)
    fake_session.get.return_value = SimpleNamespace(id=7, client_id=1, subscription_id=99, is_legacy_pooled=False)
    monkeypatch.setattr(document_routes, "get_session", lambda: _session_ctx(fake_session))

    monkeypatch.setattr(
        "app.services.plan_service.get_client_plan",
        lambda db, cid: SimpleNamespace(slug="standard", name="Standard"),
    )
    monkeypatch.setattr(
        "app.services.plan_service.get_crawl_limits",
        lambda plan: {
            "max_crawl_pages": plan_max_pages,
            "max_crawl_depth": 3,
            "max_crawl_js_pages": 50,
            "max_crawl_concurrency": 5,
        },
    )
    monkeypatch.setattr("app.services.credit_service.get_credit_cost", lambda db, action: 1)
    # The per-page price is resolved through the plan's entitlements now, so the
    # trial's first website training can be free. These tests drive a Standard
    # bot through a MagicMock session, so the entitlement lookup is stubbed to a
    # tier without the flag: every page is charged, exactly as before.
    monkeypatch.setattr(
        "app.services.plan_entitlements_service.get_entitlements",
        lambda client_id, session, **kwargs: SimpleNamespace(has_feature=lambda name: False),
    )

    # This bot IS resolved to its own ledger bucket, the credit routing
    # decision itself (resolve_bot_ledger_bot_id) is exercised for real by
    # crawl_endpoint; what we control is what each bucket's balance reports.
    monkeypatch.setattr("app.services.credit_service.resolve_bot_ledger_bot_id", lambda bot: 7)

    def _fake_get_balance(db, client_id, bot_id=None):
        return balances_by_bucket["bot_ledger"] if bot_id is not None else balances_by_bucket["client_pool"]

    monkeypatch.setattr("app.services.credit_service.get_balance", _fake_get_balance)

    monkeypatch.setattr(document_routes, "_check_memory", lambda: None)
    monkeypatch.setattr(document_routes, "clear_cancellation", lambda client_id: None)
    monkeypatch.setattr(document_routes, "set_crawl_progress", lambda *a, **k: None)

    async def _fake_acquire_lock(client_id):
        return "test-lock-token"

    monkeypatch.setattr(document_routes, "_acquire_crawl_lock_or_preempt", _fake_acquire_lock)

    monkeypatch.setattr("app.worker.enqueue.WORKER_ENABLED", True)

    async def _fake_enqueue(*args, **kwargs):
        return SimpleNamespace(job_id="job-123")

    monkeypatch.setattr("app.worker.enqueue.enqueue", _fake_enqueue)


def test_crawl_allowed_when_bot_ledger_funded_but_client_pool_empty(monkeypatch):
    """Per-bot subscription: client pool is drained to zero (all its free/legacy
    credits spent elsewhere) but the bot's OWN ledger (the bucket the pipeline
    will actually deduct from) is funded. The crawl must be ALLOWED."""
    _patch_common(monkeypatch, balances_by_bucket={"client_pool": 0, "bot_ledger": 500})

    resp = TestClient(_build_app()).post(
        "/crawl",
        params={"bot_id": 7},
        json={"url": "https://acme.test", "max_pages": 10},
    )

    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["status"] == "running"
    assert body["job_id"] == "job-123"


def test_crawl_blocked_when_bot_ledger_empty_even_if_client_pool_funded(monkeypatch):
    """Inverse case: the bot's own ledger (the bucket that will actually be
    charged) is empty, even though the client pool has plenty. The crawl must
    be BLOCKED (402), proving the gate checks the deduction bucket and not
    stale/irrelevant client-pool credits."""
    _patch_common(monkeypatch, balances_by_bucket={"client_pool": 500, "bot_ledger": 0})

    resp = TestClient(_build_app()).post(
        "/crawl",
        params={"bot_id": 7},
        json={"url": "https://acme.test", "max_pages": 10},
    )

    assert resp.status_code == 402, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == "insufficient_credits"
    assert detail["required"] == 10
    assert detail["available"] == 0


# ── discovered_pages: initial-crawl credit pre-flight right-sizing ────────────
# The pre-flight used to reserve plan_max × cost_per_page for every initial
# crawl, so a small site (e.g. 13 pages) was gated at the plan ceiling (20 × 5 =
# 100 credits) and could be wrongly blocked. Supplying the discovered sitemap
# count now sizes the reservation to the actual pages. cost_per_page = 1 here.


def test_initial_crawl_gated_at_plan_max_without_discovered_pages(monkeypatch):
    """Pre-fix worst case: a fixed-cap plan with no max_pages / no discovered_pages
    reserves the full plan ceiling, a 5-credit balance can't clear the 20-page
    reservation even though the real site may be far smaller."""
    _patch_common(
        monkeypatch,
        balances_by_bucket={"client_pool": 0, "bot_ledger": 5},
        plan_max_pages=20,
    )

    resp = TestClient(_build_app()).post(
        "/crawl",
        params={"bot_id": 7},
        json={"url": "https://acme.test"},
    )

    assert resp.status_code == 402, resp.text
    detail = resp.json()["detail"]
    assert detail["error"] == "insufficient_credits"
    assert detail["required"] == 20  # plan_max (20) × cost_per_page (1)


def test_initial_crawl_credit_gate_sized_to_discovered_pages(monkeypatch):
    """Fix: an initial crawl that reports discovered_pages sizes the pre-flight to
    min(plan_max, discovered), a 3-page site reserves 3 credits, so a balance of
    5 is enough and the crawl is ALLOWED."""
    _patch_common(
        monkeypatch,
        balances_by_bucket={"client_pool": 0, "bot_ledger": 5},
        plan_max_pages=20,
    )

    resp = TestClient(_build_app()).post(
        "/crawl",
        params={"bot_id": 7},
        json={"url": "https://acme.test", "discovered_pages": 3},
    )

    assert resp.status_code == 202, resp.text
    assert resp.json()["status"] == "running"


def test_discovered_pages_does_not_exceed_plan_cap(monkeypatch):
    """discovered_pages only ever TIGHTENS the reservation, a discovered count
    above the plan cap is clamped to the cap (never loosens it)."""
    _patch_common(
        monkeypatch,
        balances_by_bucket={"client_pool": 0, "bot_ledger": 5},
        plan_max_pages=20,
    )

    resp = TestClient(_build_app()).post(
        "/crawl",
        params={"bot_id": 7},
        json={"url": "https://acme.test", "discovered_pages": 500},
    )

    # min(plan_max 20, discovered 500) = 20 -> 20 credits > 5 balance -> blocked.
    assert resp.status_code == 402, resp.text
    assert resp.json()["detail"]["required"] == 20


def test_discovered_pages_ignored_on_recrawl(monkeypatch):
    """discovered_pages is an INITIAL-crawl signal only: with replace_source set
    (a recrawl) it must NOT loosen the pre-flight, the recrawl path
    (expected_new_pages) governs instead, so here it falls back to the plan cap."""
    _patch_common(
        monkeypatch,
        balances_by_bucket={"client_pool": 0, "bot_ledger": 5},
        plan_max_pages=20,
    )

    resp = TestClient(_build_app()).post(
        "/crawl",
        params={"bot_id": 7},
        json={
            "url": "https://acme.test",
            "discovered_pages": 3,
            "replace_source": "acme.test",
            "mode": "full",
        },
    )

    assert resp.status_code == 402, resp.text
    assert resp.json()["detail"]["required"] == 20
