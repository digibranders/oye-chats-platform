"""Orphan sweep must delete a stored page only when it is CONFIRMED gone.

Regression guard: a full re-crawl that discovers fewer pages than are stored
(e.g. the sitemap was briefly unreachable and the crawl fell back to a shallower
link/recursive pass) must not delete pages that still resolve — it must verify
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
