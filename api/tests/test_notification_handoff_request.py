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


def test_an_urgent_incident_without_contact_details_says_to_reply_in_the_conversation(monkeypatch):
    """The owner's alert of 2026-09-28 had no way to reach the visitor. The inbox says so, like the email."""
    captured = {}
    monkeypatch.setattr(ns, "create_notification", lambda session, **kw: captured.update(kw) or {})

    ns.notify_handoff_request(
        object(), client_id=1, session_id="s-3", visitor_name="Eva", bot_name="Acme Bot", urgent=True, no_contact=True
    )

    assert captured["title"] == "URGENT: Eva reported an active incident"
    assert captured["body"] == (
        "No email or phone yet. Reply in the conversation now: they were on the page when this was sent."
    )
    assert captured["data"]["no_contact"] is True


def test_an_urgent_incident_with_contact_details_keeps_the_usual_body(monkeypatch):
    captured = {}
    monkeypatch.setattr(ns, "create_notification", lambda session, **kw: captured.update(kw) or {})

    ns.notify_handoff_request(
        object(), client_id=1, session_id="s-4", visitor_name="Eva", bot_name="Acme Bot", urgent=True
    )

    assert captured["body"] == "Live chat request via Acme Bot."
    assert captured["data"]["no_contact"] is False


def test_an_urgent_follow_up_opens_the_conversation(monkeypatch):
    captured = {}
    monkeypatch.setattr(ns, "create_notification", lambda session, **kw: captured.update(kw) or {})

    ns.notify_urgent_follow_up(
        object(),
        client_id=1,
        session_id="s-5",
        title="Contact details for Eva: +91 98765 43210",
        body="Shared in the chat on Acme Bot.",
        kind="contact",
    )

    assert captured["type_"] == ns.TYPE_HANDOFF_REQUEST
    assert captured["title"] == "Contact details for Eva: +91 98765 43210"
    assert captured["body"] == "Shared in the chat on Acme Bot."
    assert captured["link"] == "/support?session=s-5"
    assert captured["data"] == {"session_id": "s-5", "urgent": True, "follow_up": "contact"}
