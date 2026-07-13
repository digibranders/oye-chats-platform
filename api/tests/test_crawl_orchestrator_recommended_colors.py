"""run_full_crawl must always overwrite recommended_colors so a re-crawl of a
different site never shows the stale palette from the previous website.

Regression guard for the bug where Spider/Jina return ``recommended_colors=[]``
(they never extract colors), which used to be silently skipped by a truthy
guard — leaving whatever palette the previous crawl wrote in place forever.
"""

from contextlib import contextmanager
from unittest.mock import MagicMock

import pytest

import app.services.crawl_orchestrator as orch


def _wire(monkeypatch, bot_db, extractor_result):
    session = MagicMock()
    session.get.return_value = bot_db
    session.query.return_value.filter.return_value.limit.return_value.count.return_value = 0
    session.query.return_value.filter.return_value.all.return_value = []
    session.query.return_value.filter.return_value.distinct.return_value.all.return_value = []

    @contextmanager
    def fake_session():
        yield session

    async def fake_crawl(url, **kw):
        return {
            "results": [{"url": "https://newsite.test/a", "content": "hello"}],
            "recommended_colors": [],
            "discovered_total": 1,
            "queue_remaining": 0,
        }

    async def fake_extractor(url, **kw):
        return list(extractor_result)

    monkeypatch.setattr(orch, "crawl_website", fake_crawl)
    monkeypatch.setattr(orch, "get_session", fake_session)
    monkeypatch.setattr(orch, "fetch_recommended_colors", fake_extractor)
    monkeypatch.setattr(orch, "extract_brand_tone", lambda *a, **k: None)
    monkeypatch.setattr(orch, "extract_company_context", lambda *a, **k: None)
    monkeypatch.setattr(
        orch,
        "batch_web_ingestion",
        lambda cid, pages, **kw: {
            "chunks": len(pages),
            "pages_charged": len(pages),
            "credits_deducted": 0,
        },
    )
    monkeypatch.setattr(orch, "set_crawl_progress", lambda *a, **k: None)
    monkeypatch.setattr(orch, "release_crawl_lock", lambda *a, **k: None)
    return session


@pytest.mark.asyncio
async def test_recrawl_overwrites_stale_palette(monkeypatch):
    """New crawl → new colors extracted → bot.recommended_colors is REPLACED."""
    bot_db = MagicMock()
    bot_db.client_id = 1
    bot_db.services_url = "https://old.test/services"
    bot_db.recommended_colors = ["#0F172A", "#CBF7F7"]  # stale palette from prior crawl

    _wire(monkeypatch, bot_db, extractor_result=["#e11d48", "#f59e0b"])

    await orch.run_full_crawl(
        client_id=1,
        bot_id=42,
        url="https://newsite.test",
        max_pages=10,
        use_js=False,
        replace_source=None,
        cost_per_page=0,
    )

    assert bot_db.recommended_colors == ["#e11d48", "#f59e0b"]


@pytest.mark.asyncio
async def test_recrawl_resets_palette_when_no_colors_found(monkeypatch):
    """New crawl → extractor returns [] → stale colors are CLEARED, not kept."""
    bot_db = MagicMock()
    bot_db.client_id = 1
    bot_db.services_url = "https://old.test/services"
    bot_db.recommended_colors = ["#0F172A", "#CBF7F7"]  # stale palette

    _wire(monkeypatch, bot_db, extractor_result=[])

    await orch.run_full_crawl(
        client_id=1,
        bot_id=42,
        url="https://newsite.test",
        max_pages=10,
        use_js=False,
        replace_source=None,
        cost_per_page=0,
    )

    assert bot_db.recommended_colors == []
