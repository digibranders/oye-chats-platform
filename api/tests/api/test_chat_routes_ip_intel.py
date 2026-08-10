from unittest.mock import patch

from app.api.chat_routes import _resolve_and_update_location
from app.db.models import Bot, ChatSession, Client


def test_resolve_and_update_location_writes_visitor_metadata(db):
    client = Client(id=1, email="test@example.com", name="Test Client", api_key="test-key")
    db.add(client)
    db.flush()
    bot = Bot(
        id=1, client_id=1, bot_key="bot-test123abc", name="Test Bot", website="https://example.com", is_active=True
    )
    db.add(bot)
    db.commit()

    session_id = "test-session-ip-intel"
    chat_session = ChatSession(id=session_id, bot_id=bot.id, status="bot")
    db.add(chat_session)
    db.commit()

    # ``fetch_ip_intel`` already flattens ipapi.is's nested objects, so this
    # stub must mirror the FLAT contract its real callers receive.
    fake_intel = {
        "company_name": "Acme Corp",
        "company_domain": "acme.com",
        "company_type": "business",
        "asn": 64500,
        "asn_org": "Acme Corp",
        "is_vpn": False,
        "is_proxy": False,
        "is_tor": False,
        "is_datacenter": False,
        "is_abuser": False,
    }

    class MockSessionManager:
        def __init__(self, db):
            self.db = db

        def __enter__(self):
            return self.db

        def __exit__(self, *args):
            pass

    with (
        patch("app.api.chat_routes.fetch_ip_intel", return_value=fake_intel),
        # Company lookup is now Professional-gated + metered — stub the plan gate
        # and the credit reservation so the lookup path runs.
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        patch("app.api.chat_routes._charge_for_enrichment", return_value=True),
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo for this test")),
        patch("app.api.chat_routes.get_session", return_value=MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", bot.id)

    # IP intel is namespaced under ``ip_intel`` rather than replacing the whole
    # blob — ``visitor_metadata`` is shared with the operator console's
    # user-agent fields.
    updated = db.query(ChatSession).filter(ChatSession.id == session_id).first()
    assert updated.visitor_metadata["ip_intel"]["company_name"] == "Acme Corp"
    assert updated.visitor_metadata["ip_intel"]["is_vpn"] is False


def test_resolve_and_update_location_preserves_existing_visitor_metadata(db):
    """The IP-intel write must MERGE, never clobber. ``visitor_metadata`` is a
    shared column the operator console also writes user-agent data into."""
    client = Client(id=2, email="merge@example.com", name="Merge Client", api_key="merge-key")
    db.add(client)
    db.flush()
    bot = Bot(id=2, client_id=2, bot_key="bot-merge123", name="Merge Bot", is_active=True)
    db.add(bot)
    db.commit()

    session_id = "test-session-merge"
    db.add(
        ChatSession(
            id=session_id,
            bot_id=bot.id,
            status="bot",
            visitor_metadata={"browser": "Chrome", "os": "macOS"},
        )
    )
    db.commit()

    class MockSessionManager:
        def __init__(self, db):
            self.db = db

        def __enter__(self):
            return self.db

        def __exit__(self, *args):
            pass

    with (
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme Corp", "is_vpn": False}),
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        patch("app.api.chat_routes._charge_for_enrichment", return_value=True),
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo for this test")),
        patch("app.api.chat_routes.get_session", return_value=MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", bot.id)

    updated = db.query(ChatSession).filter(ChatSession.id == session_id).first()
    assert updated.visitor_metadata["browser"] == "Chrome"
    assert updated.visitor_metadata["os"] == "macOS"
    assert updated.visitor_metadata["ip_intel"]["company_name"] == "Acme Corp"


def test_company_lookup_skipped_when_not_professional(db):
    """Company lookup is Professional-only + feature-gated: when the plan gate
    denies it, ``fetch_ip_intel`` must not be called and no ``ip_intel`` is
    written (the free geolocation path still runs)."""
    client = Client(id=3, email="skip@example.com", name="Skip Client", api_key="skip-key")
    db.add(client)
    db.flush()
    bot = Bot(id=3, client_id=3, bot_key="bot-skip123", name="Skip Bot", is_active=True)
    db.add(bot)
    db.commit()

    session_id = "test-session-skip"
    db.add(ChatSession(id=session_id, bot_id=bot.id, status="bot", visitor_metadata={"browser": "Chrome"}))
    db.commit()

    class MockSessionManager:
        def __init__(self, db):
            self.db = db

        def __enter__(self):
            return self.db

        def __exit__(self, *args):
            pass

    with (
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme Corp"}) as mock_fetch,
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=False),
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo for this test")),
        patch("app.api.chat_routes.get_session", return_value=MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", bot.id)

    mock_fetch.assert_not_called()
    updated = db.query(ChatSession).filter(ChatSession.id == session_id).first()
    assert "ip_intel" not in (updated.visitor_metadata or {})
