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

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db.models import Bot, Client, Document
from app.services import recrawl_service

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


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


def _mk_doc(db, bot_id, client_id, name, source="crawl"):
    db.add(
        Document(
            client_id=client_id,
            bot_id=bot_id,
            document_name=name,
            source=source,
            file_hash=f"h-{name}",
            content="x",
            embedding=[0.0] * 768,
        )
    )


# ── recrawl_service ───────────────────────────────────────────────────────────


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

    before = datetime.now(UTC)
    summary = asyncio.run(recrawl_service.recrawl_bot(bot.id))

    assert summary["status"] == "partial"  # one fetched, one failed
    assert summary["total_urls"] == 2
    assert summary["changed_pages"] == 1
    assert summary["failed"] == 1
    assert summary["failed_urls"] == ["https://a.test/broken"]
    assert summary["chunks_updated"] == 4

    db.refresh(bot)
    assert bot.last_recrawl_status == "partial"
    assert bot.last_recrawl_summary["failed"] == 1
    assert bot.last_recrawl_at is not None
    # The schedule MUST advance ~7 days or the hourly sweep re-matches forever.
    assert bot.next_recrawl_at >= before + timedelta(days=7) - timedelta(minutes=1)
    assert bot.recrawl_history[0]["status"] == "partial"


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


# ── worker tasks ──────────────────────────────────────────────────────────────


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


def test_get_recrawl_status_is_tenant_isolated(db, monkeypatch):
    owner = _mk_client(db, "rc-own@test.example")
    intruder = _mk_client(db, "rc-intr@test.example")
    bot = _mk_bot(db, owner.id, "bot-rc-iso")
    db.commit()

    tc = _build_app(db, monkeypatch, intruder.id, has_feature=True)
    assert tc.get(f"/bots/{bot.id}/recrawl").status_code == 404


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
