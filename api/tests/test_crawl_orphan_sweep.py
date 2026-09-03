"""Orphan sweep must delete a stored page only when it is CONFIRMED gone.

Regression guard: a full re-crawl that discovers fewer pages than are stored
(e.g. the sitemap was briefly unreachable and the crawl fell back to a shallower
link/recursive pass) must not delete pages that still resolve, it must verify
liveness first via check_urls_alive.
"""

from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest

import app.services.crawl_orchestrator as orch
import app.services.url_discovery as url_discovery


def _wire_common(monkeypatch, del_session, candidates, liveness):
    q = MagicMock()
    del_session.query.return_value = q
    q.filter.return_value = q
    q.distinct.return_value = q
    q.all.return_value = [(u,) for u in candidates]
    q.delete.return_value = len(candidates)

    @contextmanager
    def fake_session():
        yield del_session

    async def fake_crawl(url, **kw):
        return {
            "results": [{"url": "https://acme.test/kept", "content": "fresh"}],
            "recommended_colors": [],
            "discovered_total": 1,
            "queue_remaining": 0,
        }

    checked = {}

    async def fake_alive(urls, **kw):
        checked["urls"] = list(urls)
        return {u: liveness[u] for u in urls}

    monkeypatch.setattr(orch, "crawl_website", fake_crawl)
    monkeypatch.setattr(orch, "get_session", fake_session)
    monkeypatch.setattr(url_discovery, "check_urls_alive", fake_alive)
    monkeypatch.setattr(
        orch,
        "batch_web_ingestion",
        lambda cid, pages, **kw: {
            "chunks": len(pages),
            "pages_charged": len(pages),
            "credits_deducted": 5 * len(pages),
        },
    )
    monkeypatch.setattr(orch, "set_crawl_progress", lambda *a, **k: None)
    monkeypatch.setattr(orch, "release_crawl_lock", lambda *a, **k: None)
    return q, checked


@pytest.mark.asyncio
async def test_orphan_sweep_deletes_only_confirmed_dead(monkeypatch):
    del_session = MagicMock()
    candidates = ["https://acme.test/gone", "https://acme.test/still-here"]
    liveness = {"https://acme.test/gone": False, "https://acme.test/still-here": True}
    q, checked = _wire_common(monkeypatch, del_session, candidates, liveness)

    await orch.run_full_crawl(
        client_id=1,
        bot_id=None,
        url="https://acme.test",
        max_pages=50,
        use_js=False,
        replace_source="acme.test",
        cost_per_page=5,
    )

    # Liveness was checked for every stored page missing from this crawl…
    assert set(checked["urls"]) == set(candidates)
    # …and exactly one delete ran (only the confirmed-dead page).
    q.delete.assert_called_once()


@pytest.mark.asyncio
async def test_orphan_sweep_retains_live_pages_on_discovery_shortfall(monkeypatch):
    del_session = MagicMock()
    candidates = ["https://acme.test/a", "https://acme.test/b", "https://acme.test/c"]
    liveness = {u: True for u in candidates}  # all still resolve
    q, checked = _wire_common(monkeypatch, del_session, candidates, liveness)

    await orch.run_full_crawl(
        client_id=1,
        bot_id=None,
        url="https://acme.test",
        max_pages=50,
        use_js=False,
        replace_source="acme.test",
        cost_per_page=5,
    )

    assert set(checked["urls"]) == set(candidates)
    # Nothing is confirmed gone → no deletion runs.
    q.delete.assert_not_called()


@pytest.mark.asyncio
async def test_orphan_sweep_reclaims_kb_characters_before_deleting(monkeypatch):
    """I6: the char count lives on the rows the sweep is about to delete, so it
    has to be handed back first or ``kb_characters_used`` only ever grows."""
    del_session = MagicMock()
    candidates = ["https://acme.test/gone"]
    liveness = {"https://acme.test/gone": False}
    q, _checked = _wire_common(monkeypatch, del_session, candidates, liveness)

    order: list[str] = []
    q.delete.side_effect = lambda *a, **kw: order.append("delete") or 1

    def fake_release(session, *, client_id, bot_id, document_names):
        order.append("release")
        assert document_names == candidates
        return 480

    monkeypatch.setattr(orch, "release_kb_usage_for_sources", fake_release)

    await orch.run_full_crawl(
        client_id=1,
        bot_id=None,
        url="https://acme.test",
        max_pages=50,
        use_js=False,
        replace_source="acme.test",
        cost_per_page=5,
    )

    assert order == ["release", "delete"]


@pytest.mark.asyncio
async def test_retry_skips_when_another_crawl_holds_the_lock(monkeypatch):
    """I9: this function releases the crawl lock in its ``finally``, so an ARQ
    retry re-enters holding nothing. It must not run beside a newer crawl."""
    del_session = MagicMock()
    _wire_common(monkeypatch, del_session, [], {})
    monkeypatch.setattr(orch, "crawl_lock_holder", lambda cid: "interactive:someone-else")
    monkeypatch.setattr(orch, "acquire_crawl_lock", lambda *a, **kw: None)

    result = await orch.run_full_crawl(
        client_id=1,
        bot_id=None,
        url="https://acme.test",
        max_pages=50,
        use_js=False,
        replace_source=None,
        cost_per_page=5,
        lock_token="interactive:mine",
        job_try=2,
    )

    assert result["chunks_processed"] == 0
    assert "skipped" in result["message"].lower()


@pytest.mark.asyncio
async def test_retry_reacquires_a_lapsed_lock_and_runs(monkeypatch):
    """A worker killed mid-crawl lets the lock's TTL lapse. The retry re-takes
    it (with a fresh token) rather than crawling unprotected."""
    del_session = MagicMock()
    _wire_common(monkeypatch, del_session, [], {})
    monkeypatch.setattr(orch, "crawl_lock_holder", lambda cid: None)
    acquired = {}

    def fake_acquire(client_id, *a, **kw):
        acquired["kind"] = kw.get("kind")
        return "interactive:fresh"

    released = {}
    monkeypatch.setattr(orch, "acquire_crawl_lock", fake_acquire)
    monkeypatch.setattr(orch, "release_crawl_lock", lambda cid, token=None: released.update(token=token))

    result = await orch.run_full_crawl(
        client_id=1,
        bot_id=None,
        url="https://acme.test",
        max_pages=50,
        use_js=False,
        replace_source=None,
        cost_per_page=5,
        lock_token="interactive:stale",
        job_try=3,
    )

    assert acquired["kind"] == "interactive"
    assert result["chunks_processed"] == 1
    # The finally block releases the token this run actually owns.
    assert released["token"] == "interactive:fresh"
