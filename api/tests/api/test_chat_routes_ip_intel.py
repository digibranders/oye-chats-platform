from unittest.mock import patch

from app.db.models import ChatSession, Bot, Client
from app.api.chat_routes import _resolve_and_update_location
from app.db.session import get_session

def test_resolve_and_update_location_writes_visitor_metadata(db):
    client = Client(id=1, email="test@example.com", name="Test Client", api_key="test-key")
    db.add(client)
    db.flush()
    bot = Bot(id=1, client_id=1, bot_key="bot-test123abc", name="Test Bot", website="https://example.com", is_active=True)
    db.add(bot)
    db.commit()

    session_id = "test-session-ip-intel"
    chat_session = ChatSession(id=session_id, bot_id=bot.id, status="bot")
    db.add(chat_session)
    db.commit()

    fake_intel = {
        "company": {"name": "Acme Corp", "domain": "acme.com", "type": "business"},
        "asn": {"org": "Acme Corp"},
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
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo for this test")),
        patch("app.api.chat_routes.get_session", return_value=MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8")

    updated = db.query(ChatSession).filter(ChatSession.id == session_id).first()
    assert updated.visitor_metadata["company"]["name"] == "Acme Corp"
    assert updated.visitor_metadata["is_vpn"] is False
