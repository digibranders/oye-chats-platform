"""notify_crawl_completed builds the right notification payload."""

import app.services.notification_service as ns


def test_notify_crawl_completed_formats(monkeypatch):
    captured = {}
    monkeypatch.setattr(ns, "create_notification", lambda session, **kw: captured.update(kw) or {})

    ns.notify_crawl_completed(
        object(), client_id=1, source="https://a.com", pages=507, chunks=10087, duration_seconds=122, bot_id=5
    )
    assert captured["type_"] == ns.TYPE_CRAWL_COMPLETED
    assert captured["title"] == "Website crawl complete"
    assert "507 pages" in captured["body"]
    assert "10087 chunks" in captured["body"]
    assert "2m 2s" in captured["body"]  # 122s → "2m 2s"
    assert captured["link"] == "/knowledge?tab=list"
    assert captured["data"]["pages"] == 507 and captured["data"]["bot_id"] == 5


def test_notify_crawl_completed_singular_and_no_duration(monkeypatch):
    captured = {}
    monkeypatch.setattr(ns, "create_notification", lambda session, **kw: captured.update(kw) or {})

    ns.notify_crawl_completed(object(), client_id=1, source="x", pages=1, chunks=3)
    assert "1 page," in captured["body"]  # singular
    assert " in " not in captured["body"]  # no duration segment when unknown


def test_crawl_completed_type_is_known():
    assert ns.TYPE_CRAWL_COMPLETED in ns.KNOWN_TYPES
