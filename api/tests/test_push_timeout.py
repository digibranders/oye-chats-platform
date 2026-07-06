"""Web push delivery must carry an HTTP timeout (audit F44).

pywebpush.webpush() delegates to requests.post; without a timeout, one
unresponsive push endpoint hangs the whole fan-out to other subscribers.
"""

from types import SimpleNamespace

from app.services import push_service


def test_send_push_passes_a_positive_timeout(monkeypatch):
    captured: dict = {}

    def fake_webpush(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(status_code=201)

    monkeypatch.setattr(push_service, "PUSH_ENABLED", True)
    monkeypatch.setattr(push_service, "_get_vapid", lambda: "vapid-key")
    monkeypatch.setattr(push_service, "webpush", fake_webpush)

    ok, status = push_service.send_push_to_subscription(
        "https://push.example.com/sub", "p256dh", "auth", {"title": "hi"}
    )

    assert ok is True
    assert "timeout" in captured, "webpush must be called with a timeout"
    assert captured["timeout"] > 0
