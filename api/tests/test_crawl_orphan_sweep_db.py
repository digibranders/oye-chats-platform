"""The orphan sweep, exercised against a real database row.

``tests/test_crawl_orphan_sweep.py`` drives the sweep through a ``MagicMock``
session whose ``filter`` returns itself, so the candidate query's predicate is
never evaluated: it passed against a filter that could not match any row in
Postgres. It could not, and did not, catch the defect this module pins.

The defect: the candidate query compared a SQL expression that KEPT the scheme
(``https://acme.com``) against a ``replace_source`` the dashboard sends as a
bare host (``acme.com``). The two can never be equal, so the sweep found
nothing, ever. A page deleted from the customer's site kept its chunks forever
and the chatbot went on answering from it.
"""

from __future__ import annotations

import os
from contextlib import contextmanager

import pytest

import app.services.crawl_orchestrator as orch
import app.services.url_discovery as url_discovery
from app.db.models import Client, Document

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

_EMBEDDING = [0.0] * 768


def _seed_pages(db, client_id: int, urls: list[str]) -> None:
    for url in urls:
        db.add(
            Document(
                client_id=client_id,
                document_name=url,
                source="crawl",
                file_hash=f"h-{url}",
                content=f"body of {url}",
                metadata_info={"url": url},
                embedding=_EMBEDDING,
            )
        )
    db.commit()


def _stub_crawl(monkeypatch, db, fetched: list[str], liveness: dict[str, bool]) -> dict:
    checked: dict = {}

    async def fake_fetch_urls(urls, **kw):
        return {
            "results": [{"url": u, "content": "fresh copy"} for u in fetched],
            "recommended_colors": [],
            "discovered_total": len(fetched),
            "queue_remaining": 0,
        }

    async def fake_alive(urls, **kw):
        checked["urls"] = sorted(urls)
        return {u: liveness.get(u, True) for u in urls}

    async def no_colors(_url):
        return []

    monkeypatch.setattr(orch, "fetch_urls", fake_fetch_urls)
    monkeypatch.setattr(orch, "fetch_recommended_colors", no_colors)
    monkeypatch.setattr(url_discovery, "check_urls_alive", fake_alive)
    monkeypatch.setattr(
        orch,
        "batch_web_ingestion",
        lambda cid, pages, **kw: {
            "chunks": len(pages),
            "pages_changed": len(pages),
            "pages_charged": len(pages),
            "pages_failed": 0,
            "credits_deducted": 0,
            "aborted": False,
            "abort_reason": None,
        },
    )
    monkeypatch.setattr(orch, "set_crawl_progress", lambda *a, **k: None)
    monkeypatch.setattr(orch, "release_crawl_lock", lambda *a, **k: None)
    monkeypatch.setattr(orch, "_record_bot_crawl_state", lambda *a, **k: None)

    # The orchestrator opens its own sessions; hand it the test session so the
    # rows seeded here are the rows the sweep sees.
    @contextmanager
    def fake_session():
        yield db

    monkeypatch.setattr(orch, "get_session", fake_session)
    return checked


@pytest.mark.asyncio
async def test_the_candidate_query_actually_matches_a_stored_row(db, monkeypatch):
    """A bare-host ``replace_source`` must select the bot's stored URLs."""
    client = Client(name="Acme", email="sweep@test.local", hashed_password="x", api_key="k-sweep")
    db.add(client)
    db.flush()
    _seed_pages(db, client.id, ["https://acme.test/kept", "https://acme.test/retired"])

    checked = _stub_crawl(
        monkeypatch,
        db,
        fetched=["https://acme.test/kept"],
        liveness={"https://acme.test/retired": False},
    )

    await orch.run_full_crawl(
        client_id=client.id,
        bot_id=None,
        url="https://acme.test",
        max_pages=10,
        use_js=False,
        replace_source="acme.test",
        cost_per_page=0,
        ordered_urls=["https://acme.test/kept"],
    )

    # The page missing from this crawl was found as a candidate…
    assert checked["urls"] == ["https://acme.test/retired"]
    # …confirmed gone, and its chunks removed. The page still on the site stays.
    remaining = {row[0] for row in db.query(Document.document_name).all()}
    assert remaining == {"https://acme.test/kept"}


@pytest.mark.asyncio
async def test_a_www_prefixed_stored_url_is_matched_too(db, monkeypatch):
    """Stored URLs carry whatever host the sitemap used; both sides normalise."""
    client = Client(name="Acme", email="sweep2@test.local", hashed_password="x", api_key="k-sweep2")
    db.add(client)
    db.flush()
    _seed_pages(db, client.id, ["https://www.acme.test/kept", "https://www.acme.test/retired"])

    checked = _stub_crawl(
        monkeypatch,
        db,
        fetched=["https://www.acme.test/kept"],
        liveness={"https://www.acme.test/retired": False},
    )

    await orch.run_full_crawl(
        client_id=client.id,
        bot_id=None,
        url="https://www.acme.test",
        max_pages=10,
        use_js=False,
        # A caller that sends the full root URL rather than the bare host must
        # land on the same canonical form.
        replace_source="https://www.acme.test",
        cost_per_page=0,
        ordered_urls=["https://www.acme.test/kept"],
    )

    assert checked["urls"] == ["https://www.acme.test/retired"]
    assert {row[0] for row in db.query(Document.document_name).all()} == {"https://www.acme.test/kept"}


@pytest.mark.asyncio
async def test_a_live_page_missing_from_the_crawl_is_never_deleted(db, monkeypatch):
    """Liveness stays the safety net now that the sweep actually runs."""
    client = Client(name="Acme", email="sweep3@test.local", hashed_password="x", api_key="k-sweep3")
    db.add(client)
    db.flush()
    _seed_pages(db, client.id, ["https://acme.test/kept", "https://acme.test/slow"])

    _stub_crawl(monkeypatch, db, fetched=["https://acme.test/kept"], liveness={"https://acme.test/slow": True})

    await orch.run_full_crawl(
        client_id=client.id,
        bot_id=None,
        url="https://acme.test",
        max_pages=10,
        use_js=False,
        replace_source="acme.test",
        cost_per_page=0,
        ordered_urls=["https://acme.test/kept"],
    )

    assert {row[0] for row in db.query(Document.document_name).all()} == {
        "https://acme.test/kept",
        "https://acme.test/slow",
    }
