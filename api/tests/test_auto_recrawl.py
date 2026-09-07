"""Auto-recrawl. Service, worker tasks, and API endpoints (steve branch).

The feature shipped without tests; these are the characterization + contract
tests it should have carried. Coverage map:

* recrawl_service. URL loading (source discriminator), status classification,
  summary persistence (next_recrawl_at MUST advance or the sweep re-matches
  hourly), and the rolling-history cap.
* worker tasks, the hourly sweep enqueues exactly the due/enabled/active
  bots with an hour-bucketed dedup job id; the per-bot task force-disables
  the toggle when the plan lost the entitlement between sweep and execution.
* API. Tenant isolation, the 403 feature_locked upsell, and the toggle
  contract (on stamps now+7d, off clears the schedule but keeps history).
"""

import asyncio
import os
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Bot, Client, Document
from app.services import recrawl_service

# Applied per test rather than module-wide: the pure-function and fully-mocked
# tests below have no reason to skip on a machine without Postgres.
needs_db = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _mk_client(db, email):
    c = Client(name="R", email=email, api_key=f"key-{email}")
    db.add(c)
    db.flush()
    return c


def _mk_bot(db, client_id, key, **kw):
    b = Bot(client_id=client_id, name=f"B-{key}", bot_key=key, **kw)
    db.add(b)
    db.flush()
    return b


def _mk_doc(db, bot_id, client_id, name, source="crawl", chars=None):
    db.add(
        Document(
            client_id=client_id,
            bot_id=bot_id,
            document_name=name,
            source=source,
            file_hash=f"h-{name}",
            content="x",
            embedding=[0.0] * 768,
            source_char_count=chars,
        )
    )


# ── recrawl_service ───────────────────────────────────────────────────────────


@needs_db
def test_load_crawl_urls_excludes_uploads_and_dedupes(db):
    c = _mk_client(db, "rc-urls@test.example")
    bot = _mk_bot(db, c.id, "bot-rc-urls")
    other = _mk_bot(db, c.id, "bot-rc-other")
    _mk_doc(db, bot.id, c.id, "https://a.test/page1")
    _mk_doc(db, bot.id, c.id, "https://a.test/page1")  # chunk dupe → one URL
    _mk_doc(db, bot.id, c.id, "https://a.test/page2")
    _mk_doc(db, bot.id, c.id, "notes.pdf", source="upload")  # never recrawled
    _mk_doc(db, other.id, c.id, "https://b.test/elsewhere")  # other bot
    db.commit()

    urls = recrawl_service._load_crawl_urls_for_bot(db, bot.id)
    assert sorted(urls) == ["https://a.test/page1", "https://a.test/page2"]


def test_classify_status_covers_all_outcomes():
    assert recrawl_service._classify_status(changed=0, failed=0, total=0) == "empty"
    assert recrawl_service._classify_status(changed=0, failed=3, total=3) == "failed"
    assert recrawl_service._classify_status(changed=1, failed=1, total=3) == "partial"
    assert recrawl_service._classify_status(changed=0, failed=0, total=3) == "success"


def test_compute_next_recrawl_at_is_seven_days(monkeypatch):
    """Weekly cadence still holds when jitter is disabled, the +7d contract
    is what the sweep query relies on. Disable jitter via the module var so
    this test stays deterministic without seeding ``random``."""
    monkeypatch.setattr(recrawl_service, "RECRAWL_JITTER_HOURS", 0.0)
    now = datetime(2026, 7, 7, 12, 0, tzinfo=UTC)
    assert recrawl_service.compute_next_recrawl_at(now) == now + timedelta(days=7)


def test_compute_next_recrawl_at_applies_jitter_within_configured_window(monkeypatch):
    """With jitter enabled, the result lands inside ``[now+7d, now+7d+Nh]``.
    Seeded ``random`` gives a deterministic offset so this test doesn't flake."""
    import random as _random

    monkeypatch.setattr(recrawl_service, "RECRAWL_JITTER_HOURS", 24.0)
    _random.seed(1234)  # module-level `random`, same reference recrawl_service uses
    now = datetime(2026, 7, 7, 12, 0, tzinfo=UTC)
    result = recrawl_service.compute_next_recrawl_at(now)
    delta = result - now
    assert timedelta(days=7) <= delta <= timedelta(days=7, hours=24)
    # Guard against the jitter accidentally being zero (would silently
    # disable A). A seeded uniform(0, 24) never returns exactly 0.
    assert delta > timedelta(days=7)


def test_compute_next_recrawl_at_disperses_a_cohort(monkeypatch):
    """The real-world win: 10 bots toggled at the same instant land on 10
    different ``next_recrawl_at`` values spread across the jitter window."""
    import random as _random

    monkeypatch.setattr(recrawl_service, "RECRAWL_JITTER_HOURS", 24.0)
    _random.seed(42)
    now = datetime(2026, 7, 14, 10, 0, tzinfo=UTC)
    schedule = [recrawl_service.compute_next_recrawl_at(now) for _ in range(10)]
    assert len(set(schedule)) == 10  # every bot got a distinct timestamp
    # And the spread is meaningful. First-to-last > 1 hour, so a sweep
    # tick catches at most a handful of them, not the entire cohort.
    assert max(schedule) - min(schedule) > timedelta(hours=1)


@needs_db
def test_recrawl_bot_persists_summary_and_advances_schedule(db, monkeypatch):
    c = _mk_client(db, "rc-run@test.example")
    bot = _mk_bot(
        db,
        c.id,
        "bot-rc-run",
        recrawl_enabled=True,
        next_recrawl_at=datetime.now(UTC) - timedelta(hours=1),
    )
    _mk_doc(db, bot.id, c.id, "https://a.test/ok")
    _mk_doc(db, bot.id, c.id, "https://a.test/broken")
    db.commit()

    monkeypatch.setattr(recrawl_service, "get_session", lambda: _ctx(db))

    async def _fake_fetch(urls, **kw):
        # /ok comes back with content; /broken is silently missing, the
        # provider-shape for a per-URL fetch failure.
        return {"results": [{"url": "https://a.test/ok", "text": "fresh content"}]}

    monkeypatch.setattr(recrawl_service, "fetch_urls", _fake_fetch)
    monkeypatch.setattr(
        recrawl_service,
        "batch_web_ingestion",
        lambda client_id, pages, **kw: {
            "chunks": 4,
            "pages_changed": 1,
            "pages_charged": 0,
            "credits_deducted": 0,
        },
    )

    # /broken timed out rather than 404ing: not confirmed gone, so it stays a
    # failure and keeps its chunks.
    async def _still_alive(urls, **kw):
        return dict.fromkeys(urls, True)

    monkeypatch.setattr(recrawl_service, "check_urls_alive", _still_alive)

    before = datetime.now(UTC)
    summary = asyncio.run(recrawl_service.recrawl_bot(bot.id))

    assert summary["status"] == "partial"  # one fetched, one failed
    assert summary["total_urls"] == 2
    assert summary["changed_pages"] == 1
    assert summary["failed"] == 1
    assert summary["failed_urls"] == ["https://a.test/broken"]
    assert summary["chunks_updated"] == 4
    assert summary["removed_pages"] == 0

    db.refresh(bot)
    assert bot.last_recrawl_status == "partial"
    assert bot.last_recrawl_summary["failed"] == 1
    assert bot.last_recrawl_at is not None
    # The schedule MUST advance ~7 days or the hourly sweep re-matches forever.
    assert bot.next_recrawl_at >= before + timedelta(days=7) - timedelta(minutes=1)
    assert bot.recrawl_history[0]["status"] == "partial"


@needs_db
def test_recrawl_bot_reports_accurate_changed_count_when_every_page_changed(db, monkeypatch):
    """Prior to the fix, ``recrawl_service`` fell back to ``changed_pages = 1``
    whenever any chunks landed. Because the paid-crawl path leans on
    ``pages_charged`` for the count and ``cost_per_page`` is 0 on auto-recrawl,
    that fallback was the only signal. If a customer redesigned their whole
    site and 5 pages all changed, the summary reported ``1 changed, 4
    unchanged``, a 4-page lie.

    ``batch_web_ingestion`` now returns an accurate ``pages_changed``; the
    stub below mimics the "all 5 fetched pages actually changed" case and
    the summary must reflect it exactly."""
    c = _mk_client(db, "rc-allchanged@test.example")
    bot = _mk_bot(
        db,
        c.id,
        "bot-rc-allchanged",
        recrawl_enabled=True,
        next_recrawl_at=datetime.now(UTC) - timedelta(hours=1),
    )
    urls = [f"https://a.test/p{i}" for i in range(5)]
    for u in urls:
        _mk_doc(db, bot.id, c.id, u)
    db.commit()

    monkeypatch.setattr(recrawl_service, "get_session", lambda: _ctx(db))

    async def _fake_fetch(fetch_urls_arg, **kw):
        return {"results": [{"url": u, "text": f"fresh body {u}"} for u in fetch_urls_arg]}

    monkeypatch.setattr(recrawl_service, "fetch_urls", _fake_fetch)
    monkeypatch.setattr(
        recrawl_service,
        "batch_web_ingestion",
        lambda client_id, pages, **kw: {
            "chunks": 40,  # ~8 chunks per page × 5 pages
            "pages_changed": 5,  # all five made it past hash-skip and committed
            "pages_charged": 0,  # cost_per_page=0 on auto-recrawl
            "credits_deducted": 0,
        },
    )

    summary = asyncio.run(recrawl_service.recrawl_bot(bot.id))

    assert summary["status"] == "success"
    assert summary["total_urls"] == 5
    assert summary["changed_pages"] == 5, "must NOT fall back to 1 when all 5 pages changed"
    assert summary["unchanged_pages"] == 0
    assert summary["failed"] == 0
    assert summary["chunks_updated"] == 40


@needs_db
def test_recrawl_bot_reports_accurate_mixed_change_count(db, monkeypatch):
    """The mixed case: 5 URLs, 2 changed, 3 unchanged, 0 failed. Confirms the
    summary math (unchanged = fetched - changed) still holds when the ingest
    stub reports a partial change rather than everything-or-nothing."""
    c = _mk_client(db, "rc-mixed@test.example")
    bot = _mk_bot(
        db,
        c.id,
        "bot-rc-mixed",
        recrawl_enabled=True,
        next_recrawl_at=datetime.now(UTC) - timedelta(hours=1),
    )
    urls = [f"https://a.test/m{i}" for i in range(5)]
    for u in urls:
        _mk_doc(db, bot.id, c.id, u)
    db.commit()

    monkeypatch.setattr(recrawl_service, "get_session", lambda: _ctx(db))

    async def _fake_fetch(fetch_urls_arg, **kw):
        return {"results": [{"url": u, "text": f"body {u}"} for u in fetch_urls_arg]}

    monkeypatch.setattr(recrawl_service, "fetch_urls", _fake_fetch)
    monkeypatch.setattr(
        recrawl_service,
        "batch_web_ingestion",
        lambda client_id, pages, **kw: {
            "chunks": 16,  # e.g. 8 chunks × 2 changed pages
            "pages_changed": 2,
            "pages_charged": 0,
            "credits_deducted": 0,
        },
    )

    summary = asyncio.run(recrawl_service.recrawl_bot(bot.id))

    assert summary["total_urls"] == 5
    assert summary["changed_pages"] == 2
    assert summary["unchanged_pages"] == 3, "5 fetched - 2 changed = 3 unchanged"
    assert summary["failed"] == 0
    assert summary["chunks_updated"] == 16
    assert summary["status"] == "success"


@needs_db
def test_recrawl_bot_empty_still_advances_schedule(db, monkeypatch):
    c = _mk_client(db, "rc-empty@test.example")
    bot = _mk_bot(
        db,
        c.id,
        "bot-rc-empty",
        recrawl_enabled=True,
        next_recrawl_at=datetime.now(UTC) - timedelta(hours=1),
    )
    db.commit()
    monkeypatch.setattr(recrawl_service, "get_session", lambda: _ctx(db))

    summary = asyncio.run(recrawl_service.recrawl_bot(bot.id))

    assert summary["status"] == "empty"
    db.refresh(bot)
    assert bot.next_recrawl_at > datetime.now(UTC) + timedelta(days=6)


@needs_db
def test_recrawl_history_is_capped_newest_first(db, monkeypatch):
    c = _mk_client(db, "rc-hist@test.example")
    bot = _mk_bot(db, c.id, "bot-rc-hist", recrawl_enabled=True)
    # Pre-fill the window to the cap, the next run must evict the oldest.
    bot.recrawl_history = [
        {"ran_at": f"2026-01-{i + 1:02d}T00:00:00+00:00", "status": "success"}
        for i in range(recrawl_service._MAX_HISTORY_ENTRIES)
    ]
    db.commit()
    monkeypatch.setattr(recrawl_service, "get_session", lambda: _ctx(db))

    asyncio.run(recrawl_service.recrawl_bot(bot.id))  # empty run. Still recorded

    db.refresh(bot)
    assert len(bot.recrawl_history) == recrawl_service._MAX_HISTORY_ENTRIES
    assert bot.recrawl_history[0]["status"] == "empty"  # newest first
    # The pre-fill's last entry fell off the end of the window.
    assert all(h["ran_at"] != "2026-01-20T00:00:00+00:00" for h in bot.recrawl_history)


# ── recrawl_service: removing pages the site confirms gone ───────────────────
#
# The weekly refetch only ever touches URLs the bot already stores, so a page
# the customer deleted was refetched, failed, tallied under ``failed`` and kept
# its chunks for good. These drive ``recrawl_bot`` with every collaborator
# mocked, so they run without Postgres; the last one repeats the core case
# against real rows.


def _ingest_nothing_changed(client_id, pages, **kw):
    return {"chunks": 0, "pages_changed": 0, "pages_charged": 0, "credits_deducted": 0}


def _wire_recrawl(monkeypatch, *, urls, fetched, liveness, ingest=_ingest_nothing_changed):
    """Mock every collaborator of ``recrawl_bot`` and record what it does.

    ``fetched`` is the subset of ``urls`` the provider delivers; ``liveness``
    maps a URL to the probe's answer (missing URLs count as alive).
    """
    bot = SimpleNamespace(id=7, client_id=3)
    session = MagicMock()
    session.get.return_value = bot
    monkeypatch.setattr(recrawl_service, "get_session", lambda: _ctx(session))
    monkeypatch.setattr(recrawl_service, "_load_crawl_urls_for_bot", lambda s, bot_id: list(urls))
    monkeypatch.setattr(recrawl_service, "acquire_crawl_lock", lambda cid, **kw: "recrawl:token")
    monkeypatch.setattr(recrawl_service, "release_crawl_lock", lambda *a, **kw: None)
    monkeypatch.setattr(recrawl_service, "clear_cancellation", lambda cid: None)
    monkeypatch.setattr(recrawl_service, "is_cancellation_requested", lambda cid: False)
    monkeypatch.setattr(recrawl_service, "batch_web_ingestion", ingest)

    async def _fake_fetch(fetch_list, **kw):
        return {"results": [{"url": u, "content": f"body {u}"} for u in fetch_list if u in fetched]}

    monkeypatch.setattr(recrawl_service, "fetch_urls", _fake_fetch)

    calls = SimpleNamespace(probed=[], released=[], deleted=[], order=[], persisted={})

    async def _fake_alive(probe_list, **kw):
        calls.probed.extend(probe_list)
        return {u: liveness.get(u, True) for u in probe_list}

    def _fake_release(s, *, client_id, bot_id, document_names):
        calls.released.extend(document_names)
        calls.order.append("release")
        return 100 * len(document_names)

    def _fake_delete(s, document_name, bot_id=None, client_id=None):
        calls.deleted.append(document_name)
        calls.order.append("delete")
        return 3

    monkeypatch.setattr(recrawl_service, "check_urls_alive", _fake_alive)
    monkeypatch.setattr(recrawl_service, "release_kb_usage_for_sources", _fake_release)
    monkeypatch.setattr(recrawl_service, "delete_chunks_for_url", _fake_delete)
    monkeypatch.setattr(
        recrawl_service,
        "_persist_summary",
        lambda bot_id, summary, status, now: calls.persisted.update(summary=summary, status=status),
    )
    return calls


def test_recrawl_removes_a_page_the_site_confirms_gone(monkeypatch):
    urls = ["https://a.test/home", "https://a.test/pricing", "https://a.test/retired"]
    calls = _wire_recrawl(monkeypatch, urls=urls, fetched=urls[:2], liveness={"https://a.test/retired": False})

    summary = asyncio.run(recrawl_service.recrawl_bot(7))

    # Only the URL the provider failed on was probed, and it alone was removed.
    assert calls.probed == ["https://a.test/retired"]
    assert calls.released == ["https://a.test/retired"]
    assert calls.deleted == ["https://a.test/retired"]
    # Quota is handed back BEFORE the rows carrying the char count are deleted.
    assert calls.order == ["release", "delete"]
    assert summary["removed_pages"] == 1
    assert summary["removed_urls"] == ["https://a.test/retired"]
    assert summary["chunks_removed"] == 3
    # A removed page is a handled outcome, not a failure.
    assert summary["failed"] == 0
    assert summary["failed_urls"] == []
    assert summary["unchanged_pages"] == 2
    assert summary["status"] == "success"
    assert calls.persisted["status"] == "success"


def test_recrawl_keeps_a_page_that_merely_failed_to_fetch(monkeypatch):
    """A timeout, a 5xx or a blocked probe is not a deletion; the page stays
    and is reported as failed, exactly as before."""
    urls = ["https://a.test/home", "https://a.test/flaky"]
    calls = _wire_recrawl(monkeypatch, urls=urls, fetched=urls[:1], liveness={"https://a.test/flaky": True})

    summary = asyncio.run(recrawl_service.recrawl_bot(7))

    assert calls.probed == ["https://a.test/flaky"]
    assert calls.deleted == []
    assert summary["removed_pages"] == 0
    assert summary["failed"] == 1
    assert summary["failed_urls"] == ["https://a.test/flaky"]
    assert summary["status"] == "partial"


def test_recrawl_removal_is_capped_per_run(monkeypatch):
    """A whole site answering 404 (a broken deploy) must not wipe the knowledge
    base in one run: at most ``max(5, 20%)`` of the bot's URLs go, in order,
    and the rest stay listed as failed until the next run."""
    urls = [f"https://a.test/p{i}" for i in range(10)]
    gone = urls[2:]
    calls = _wire_recrawl(monkeypatch, urls=urls, fetched=urls[:2], liveness=dict.fromkeys(gone, False))

    summary = asyncio.run(recrawl_service.recrawl_bot(7))

    assert recrawl_service._removal_cap(10) == 5
    assert calls.deleted == gone[:5]
    assert summary["removed_pages"] == 5
    assert summary["failed"] == 3
    assert summary["failed_urls"] == gone[5:]
    assert summary["status"] == "partial"


def test_removal_cap_is_twenty_percent_with_a_floor_of_five():
    assert recrawl_service._removal_cap(1) == 5
    assert recrawl_service._removal_cap(24) == 5
    assert recrawl_service._removal_cap(25) == 5
    assert recrawl_service._removal_cap(30) == 6
    assert recrawl_service._removal_cap(100) == 20


def test_recrawl_never_removes_when_nothing_was_fetched(monkeypatch):
    """A run that fetched nothing has proven nothing about the site. No probe,
    no deletion, and the run is reported as failed as before."""
    urls = ["https://a.test/a", "https://a.test/b", "https://a.test/c"]
    calls = _wire_recrawl(monkeypatch, urls=urls, fetched=[], liveness=dict.fromkeys(urls, False))

    summary = asyncio.run(recrawl_service.recrawl_bot(7))

    assert calls.probed == []
    assert calls.deleted == []
    assert summary["removed_pages"] == 0
    assert summary["failed"] == 3
    assert summary["status"] == "failed"


def test_recrawl_keeps_every_page_when_the_liveness_probe_fails(monkeypatch):
    urls = ["https://a.test/home", "https://a.test/gone"]
    calls = _wire_recrawl(monkeypatch, urls=urls, fetched=urls[:1], liveness={"https://a.test/gone": False})

    async def _probe_blows_up(probe_list, **kw):
        raise RuntimeError("dns is down")

    monkeypatch.setattr(recrawl_service, "check_urls_alive", _probe_blows_up)

    summary = asyncio.run(recrawl_service.recrawl_bot(7))

    assert calls.deleted == []
    assert summary["removed_pages"] == 0
    assert summary["failed"] == 1
    assert summary["status"] == "partial"


def test_recrawl_skips_removal_when_an_interactive_crawl_preempts_it(monkeypatch):
    """The interactive crawl runs its own orphan sweep with the complete page
    list; nothing may be deleted under its feet. The cancel flag is clear at
    the pre-ingest check and set by the time the removal pass asks."""
    urls = ["https://a.test/home", "https://a.test/gone"]
    calls = _wire_recrawl(monkeypatch, urls=urls, fetched=urls[:1], liveness={"https://a.test/gone": False})
    answers = iter([False, True])
    monkeypatch.setattr(recrawl_service, "is_cancellation_requested", lambda cid: next(answers))

    summary = asyncio.run(recrawl_service.recrawl_bot(7))

    assert calls.probed == []
    assert calls.deleted == []
    assert summary["failed"] == 1
    assert summary["status"] == "partial"


def test_a_failed_removal_leaves_the_summary_honest(monkeypatch):
    """If the delete transaction fails, the page must still be reported as
    failed (its chunks are still there), never as removed."""
    urls = ["https://a.test/home", "https://a.test/gone"]
    calls = _wire_recrawl(monkeypatch, urls=urls, fetched=urls[:1], liveness={"https://a.test/gone": False})

    def _delete_blows_up(s, document_name, bot_id=None, client_id=None):
        raise RuntimeError("deadlock detected")

    monkeypatch.setattr(recrawl_service, "delete_chunks_for_url", _delete_blows_up)

    summary = asyncio.run(recrawl_service.recrawl_bot(7))

    assert calls.released == ["https://a.test/gone"]  # attempted, then rolled back
    assert summary["removed_pages"] == 0
    assert summary["chunks_removed"] == 0
    assert summary["failed"] == 1
    assert summary["failed_urls"] == ["https://a.test/gone"]
    assert summary["status"] == "partial"


def test_persist_summary_records_the_removed_count_in_history(monkeypatch):
    bot = SimpleNamespace(
        last_recrawl_at=None,
        last_recrawl_status=None,
        last_recrawl_summary=None,
        next_recrawl_at=None,
        recrawl_history=None,
    )
    session = MagicMock()
    session.get.return_value = bot
    monkeypatch.setattr(recrawl_service, "get_session", lambda: _ctx(session))
    now = datetime(2026, 9, 5, 12, 0, tzinfo=UTC)
    summary = {
        "total_urls": 6,
        "changed_pages": 1,
        "unchanged_pages": 3,
        "failed": 0,
        "failed_urls": [],
        "chunks_updated": 8,
        "removed_pages": 2,
        "removed_urls": ["https://a.test/x", "https://a.test/y"],
        "chunks_removed": 9,
    }

    recrawl_service._persist_summary(7, summary, "success", now)

    assert bot.recrawl_history == [
        {
            "ran_at": now.isoformat(),
            "status": "success",
            "total": 6,
            "unchanged": 3,
            "changed": 1,
            "failed": 0,
            "removed": 2,
        }
    ]
    assert bot.last_recrawl_summary["removed_pages"] == 2
    session.commit.assert_called_once()


@needs_db
def test_recrawl_bot_removes_a_page_the_site_confirms_gone_from_real_rows(db, monkeypatch):
    """The core case against real rows: the gone page's chunks are deleted, its
    characters are handed back to the account's quota, and the run is recorded
    as a success with the removal in the history entry."""
    c = _mk_client(db, "rc-gone@test.example")
    c.kb_characters_used = 300
    bot = _mk_bot(
        db,
        c.id,
        "bot-rc-gone",
        recrawl_enabled=True,
        next_recrawl_at=datetime.now(UTC) - timedelta(hours=1),
    )
    _mk_doc(db, bot.id, c.id, "https://a.test/kept", chars=100)
    _mk_doc(db, bot.id, c.id, "https://a.test/kept", chars=100)  # second chunk of the same page
    _mk_doc(db, bot.id, c.id, "https://a.test/retired", chars=200)
    db.commit()

    monkeypatch.setattr(recrawl_service, "get_session", lambda: _ctx(db))

    async def _fake_fetch(urls, **kw):
        return {"results": [{"url": "https://a.test/kept", "content": "same as before"}]}

    async def _fake_alive(urls, **kw):
        return {u: u != "https://a.test/retired" for u in urls}

    monkeypatch.setattr(recrawl_service, "fetch_urls", _fake_fetch)
    monkeypatch.setattr(recrawl_service, "check_urls_alive", _fake_alive)
    monkeypatch.setattr(recrawl_service, "batch_web_ingestion", _ingest_nothing_changed)

    summary = asyncio.run(recrawl_service.recrawl_bot(bot.id))

    assert summary["status"] == "success"
    assert summary["removed_pages"] == 1
    assert summary["removed_urls"] == ["https://a.test/retired"]
    assert summary["chunks_removed"] == 1
    assert summary["failed"] == 0
    assert summary["unchanged_pages"] == 1

    remaining = {row[0] for row in db.query(Document.document_name).filter(Document.bot_id == bot.id).all()}
    assert remaining == {"https://a.test/kept"}
    db.refresh(c)
    assert c.kb_characters_used == 100  # 300 - the retired page's 200
    db.refresh(bot)
    assert bot.last_recrawl_summary["removed_pages"] == 1
    assert bot.recrawl_history[0]["removed"] == 1


# ── worker tasks ──────────────────────────────────────────────────────────────


@needs_db
def test_sweep_enqueues_only_due_enabled_active_bots(db, monkeypatch):
    import app.db.session as db_session_mod
    import app.worker.enqueue as enqueue_mod
    from app.worker import tasks as worker_tasks

    c = _mk_client(db, "rc-sweep@test.example")
    past = datetime.now(UTC) - timedelta(minutes=5)
    future = datetime.now(UTC) + timedelta(days=3)
    due = _mk_bot(db, c.id, "bot-sw-due", recrawl_enabled=True, next_recrawl_at=past)
    _mk_bot(db, c.id, "bot-sw-later", recrawl_enabled=True, next_recrawl_at=future)
    _mk_bot(db, c.id, "bot-sw-off", recrawl_enabled=False, next_recrawl_at=past)
    _mk_bot(db, c.id, "bot-sw-dead", recrawl_enabled=True, next_recrawl_at=past, is_active=False)
    _mk_bot(db, c.id, "bot-sw-null", recrawl_enabled=True, next_recrawl_at=None)
    db.commit()

    monkeypatch.setattr(db_session_mod, "get_session", lambda: _ctx(db))

    enqueued: list[tuple[str, tuple, dict]] = []

    async def _fake_enqueue(name, *args, **kwargs):
        enqueued.append((name, args, kwargs))
        return SimpleNamespace(job_id="j1")

    monkeypatch.setattr(enqueue_mod, "enqueue", _fake_enqueue)

    count = asyncio.run(worker_tasks.task_auto_recrawl_sweep({}))

    assert count == 1
    assert enqueued == [
        (
            "task_auto_recrawl_bot",
            (due.id,),
            {"_job_id": f"auto_recrawl:{due.id}:{datetime.now(UTC).strftime('%Y%m%d%H')}"},
        )
    ]


@needs_db
def test_sweep_caps_enqueues_per_tick_and_picks_oldest_first(db, monkeypatch):
    """B, the per-hour cap. Ten bots come due in the same tick; with the
    module-level ``_SWEEP_HOURLY_CAP`` at 3 the sweep enqueues exactly 3,
    and they are the three whose ``next_recrawl_at`` is oldest (fairness).
    The other seven stay past-due and get picked up on subsequent hourly
    ticks."""
    import app.db.session as db_session_mod
    import app.worker.enqueue as enqueue_mod
    from app.worker import tasks as worker_tasks

    monkeypatch.setattr(worker_tasks, "_SWEEP_HOURLY_CAP", 3)

    c = _mk_client(db, "rc-sweep-cap@test.example")
    now = datetime.now(UTC)
    # Ten due bots, each with a distinct next_recrawl_at 1..10 minutes ago.
    # Enumerated in reverse so the oldest-due (10 min ago) is created last
    # . Proves the ordering comes from the SQL, not from insertion order.
    bots = []
    for offset_min in range(1, 11):
        b = _mk_bot(
            db,
            c.id,
            f"bot-cap-{offset_min:02d}",
            recrawl_enabled=True,
            next_recrawl_at=now - timedelta(minutes=offset_min),
        )
        bots.append((offset_min, b))
    db.commit()

    expected_first_three_ids = {b.id for offset_min, b in bots if offset_min in (8, 9, 10)}

    monkeypatch.setattr(db_session_mod, "get_session", lambda: _ctx(db))

    enqueued: list[tuple[str, tuple, dict]] = []

    async def _fake_enqueue(name, *args, **kwargs):
        enqueued.append((name, args, kwargs))
        return SimpleNamespace(job_id="j1")

    monkeypatch.setattr(enqueue_mod, "enqueue", _fake_enqueue)

    count = asyncio.run(worker_tasks.task_auto_recrawl_sweep({}))

    assert count == 3, "cap must clamp the tick's enqueue count"
    actual_ids = {args[0] for _, args, _ in enqueued}
    assert actual_ids == expected_first_three_ids, "sweep must pick the oldest-due bots first"


@needs_db
def test_per_bot_task_force_disables_on_plan_downgrade(db, monkeypatch):
    import app.db.session as db_session_mod
    import app.services.plan_entitlements_service as ents_mod
    import app.services.recrawl_service as recrawl_mod
    from app.worker import tasks as worker_tasks

    c = _mk_client(db, "rc-gate@test.example")
    bot = _mk_bot(
        db,
        c.id,
        "bot-rc-gate",
        recrawl_enabled=True,
        next_recrawl_at=datetime.now(UTC) - timedelta(minutes=1),
    )
    db.commit()

    monkeypatch.setattr(db_session_mod, "get_session", lambda: _ctx(db))
    monkeypatch.setattr(
        ents_mod,
        "get_entitlements",
        lambda client_id, session, **kw: SimpleNamespace(has_feature=lambda f: False, plan_slug="starter"),
    )

    async def _must_not_run(bot_id):
        raise AssertionError("recrawl_bot must not run after a plan downgrade")

    monkeypatch.setattr(recrawl_mod, "recrawl_bot", _must_not_run)

    result = asyncio.run(worker_tasks.task_auto_recrawl_bot({}, bot.id))

    assert result == {"status": "skipped", "reason": "plan_downgraded"}
    db.refresh(bot)
    # Auto-disabled so the sweep stops picking this bot up until re-upgrade.
    assert bot.recrawl_enabled is False
    assert bot.next_recrawl_at is None


@needs_db
def test_per_bot_task_skips_when_toggle_already_off(db, monkeypatch):
    import app.db.session as db_session_mod
    from app.worker import tasks as worker_tasks

    c = _mk_client(db, "rc-off@test.example")
    bot = _mk_bot(db, c.id, "bot-rc-off", recrawl_enabled=False)
    db.commit()
    monkeypatch.setattr(db_session_mod, "get_session", lambda: _ctx(db))

    result = asyncio.run(worker_tasks.task_auto_recrawl_bot({}, bot.id))
    assert result == {"status": "skipped", "reason": "toggle_off"}


# ── API endpoints ─────────────────────────────────────────────────────────────


def _build_app(db, monkeypatch, client_id, *, has_feature):
    import app.services.plan_entitlements_service as ents_mod
    from app.api import bot_routes
    from app.api.auth import get_current_client_or_operator

    monkeypatch.setattr(bot_routes, "get_session", lambda: _ctx(db))
    monkeypatch.setattr(
        ents_mod,
        "get_entitlements",
        lambda cid, session, **kw: SimpleNamespace(
            has_feature=lambda f: has_feature and f == "auto_recrawl",
            plan_slug="standard" if has_feature else "starter",
        ),
    )
    app = FastAPI()
    app.include_router(bot_routes.router)
    app.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client",
        "entity": SimpleNamespace(id=client_id),
        "client_id": client_id,
        "operator_id": None,
    }
    return TestClient(app)


@needs_db
def test_get_recrawl_status_is_tenant_isolated(db, monkeypatch):
    owner = _mk_client(db, "rc-own@test.example")
    intruder = _mk_client(db, "rc-intr@test.example")
    bot = _mk_bot(db, owner.id, "bot-rc-iso")
    db.commit()

    tc = _build_app(db, monkeypatch, intruder.id, has_feature=True)
    assert tc.get(f"/bots/{bot.id}/recrawl").status_code == 404


@needs_db
def test_patch_enable_without_entitlement_is_structured_403(db, monkeypatch):
    c = _mk_client(db, "rc-lock@test.example")
    bot = _mk_bot(db, c.id, "bot-rc-lock")
    db.commit()

    tc = _build_app(db, monkeypatch, c.id, has_feature=False)
    resp = tc.patch(f"/bots/{bot.id}/recrawl", json={"enabled": True})

    assert resp.status_code == 403
    detail = resp.json()["detail"]
    assert detail["error"] == "feature_locked"
    assert detail["feature"] == "auto_recrawl"
    db.refresh(bot)
    assert bot.recrawl_enabled is False  # nothing persisted


@needs_db
def test_patch_toggle_contract(db, monkeypatch):
    c = _mk_client(db, "rc-toggle@test.example")
    bot = _mk_bot(db, c.id, "bot-rc-toggle")
    bot.last_recrawl_status = "success"
    bot.recrawl_history = [{"ran_at": "2026-07-01T00:00:00+00:00", "status": "success"}]
    db.commit()

    tc = _build_app(db, monkeypatch, c.id, has_feature=True)

    on = tc.patch(f"/bots/{bot.id}/recrawl", json={"enabled": True})
    assert on.status_code == 200
    body = on.json()
    assert body["enabled"] is True
    next_at = datetime.fromisoformat(body["next_recrawl_at"])
    assert next_at > datetime.now(UTC) + timedelta(days=6, hours=23)

    off = tc.patch(f"/bots/{bot.id}/recrawl", json={"enabled": False})
    assert off.status_code == 200
    body = off.json()
    assert body["enabled"] is False
    assert body["next_recrawl_at"] is None
    # History and last-run fields survive a disable, the card keeps
    # showing "Last checked" even while the feature is off.
    assert body["last_recrawl_status"] == "success"
    assert body["recrawl_history"] == [{"ran_at": "2026-07-01T00:00:00+00:00", "status": "success"}]


@needs_db
def test_disable_always_allowed_even_without_entitlement(db, monkeypatch):
    # A downgraded customer must always be able to turn the toggle off.
    c = _mk_client(db, "rc-downoff@test.example")
    bot = _mk_bot(db, c.id, "bot-rc-downoff", recrawl_enabled=True, next_recrawl_at=datetime.now(UTC))
    db.commit()

    tc = _build_app(db, monkeypatch, c.id, has_feature=False)
    resp = tc.patch(f"/bots/{bot.id}/recrawl", json={"enabled": False})

    assert resp.status_code == 200
    db.refresh(bot)
    assert bot.recrawl_enabled is False
    assert bot.next_recrawl_at is None
