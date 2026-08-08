from unittest.mock import patch

from app.api.chat_routes import _resolve_and_update_location
from app.db.models import ChatSession
from app.db.session import get_session


def test_resolve_and_update_location_writes_visitor_metadata(db, mock_bot):
    db.add(mock_bot)
    db.commit()

    session_id = "test-session-ip-intel"
    chat_session = ChatSession(id=session_id, bot_id=mock_bot.id, status="bot")
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

    with (
        patch("app.api.chat_routes.fetch_ip_intel", return_value=fake_intel),
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo for this test")),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8")

    with get_session() as session:
        updated = session.query(ChatSession).filter(ChatSession.id == session_id).first()
        assert updated.visitor_metadata["company"]["name"] == "Acme Corp"
        assert updated.visitor_metadata["is_vpn"] is False
