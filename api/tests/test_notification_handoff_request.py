"""notify_handoff_request marks an urgent incident in the title and the payload."""

import app.services.notification_service as ns


def test_the_default_title_is_a_request_for_a_human(monkeypatch):
    captured = {}
    monkeypatch.setattr(ns, "create_notification", lambda session, **kw: captured.update(kw) or {})

    ns.notify_handoff_request(object(), client_id=1, session_id="s-1", visitor_name="Eva", bot_name="Acme Bot")

    assert captured["type_"] == ns.TYPE_HANDOFF_REQUEST
    assert captured["title"] == "Eva wants to talk to a human"
    assert captured["link"] == "/support?session=s-1"
    assert captured["data"]["urgent"] is False


def test_an_urgent_incident_says_so_in_the_title(monkeypatch):
    captured = {}
    monkeypatch.setattr(ns, "create_notification", lambda session, **kw: captured.update(kw) or {})

    ns.notify_handoff_request(object(), client_id=1, session_id="s-2", visitor_name=None, urgent=True)

    assert captured["title"] == "URGENT: A visitor reported an active incident"
    assert captured["data"]["urgent"] is True
