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
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo for this test")),
        patch("app.api.chat_routes.get_session", return_value=MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8")

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
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo for this test")),
        patch("app.api.chat_routes.get_session", return_value=MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8")

    updated = db.query(ChatSession).filter(ChatSession.id == session_id).first()
    assert updated.visitor_metadata["browser"] == "Chrome"
    assert updated.visitor_metadata["os"] == "macOS"
    assert updated.visitor_metadata["ip_intel"]["company_name"] == "Acme Corp"


class _MockSessionManager:
    def __init__(self, db):
        self.db = db

    def __enter__(self):
        return self.db

    def __exit__(self, *args):
        pass


def _seed(db, *, client_id, bot_key, session_id, visitor_metadata=None, location=None):
    db.add(Client(id=client_id, email=f"c{client_id}@example.com", name="C", api_key=f"k{client_id}"))
    db.flush()
    db.add(Bot(id=client_id, client_id=client_id, bot_key=bot_key, name="B", is_active=True))
    db.commit()
    db.add(
        ChatSession(
            id=session_id,
            bot_id=client_id,
            status="bot",
            visitor_metadata=visitor_metadata,
            location=location,
        )
    )
    db.commit()
    return session_id


def test_a_second_message_does_not_pay_for_the_same_lookups_again(db):
    """Both /chat and /chat/stream fire this resolver on EVERY message, and it
    makes up to three metered vendor calls. A ten-turn conversation spent ten
    sets of them on one unchanging IP; the answer cannot change between turns.
    """
    session_id = _seed(db, client_id=10, bot_key="bot-repeat1", session_id="s-repeat")

    with (
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme Corp"}) as intel,
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8")
        assert intel.call_count == 1

        # Turns 2 and 3 of the same conversation.
        _resolve_and_update_location(session_id, "8.8.8.8")
        _resolve_and_update_location(session_id, "8.8.8.8")

    assert intel.call_count == 1, "the IP lookup was repeated for an unchanged session IP"


def test_a_changed_ip_is_resolved_again(db):
    """Keyed on the IP, not on mere presence — a visitor who moves from wifi to
    mobile data mid-conversation is genuinely somewhere new."""
    session_id = _seed(db, client_id=11, bot_key="bot-moved1", session_id="s-moved")

    with (
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme Corp"}) as intel,
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8")
        _resolve_and_update_location(session_id, "1.1.1.1")

    assert intel.call_count == 2


def test_a_missing_session_row_is_not_mistaken_for_already_done(db):
    """The row is INSERTed by rag_pipeline on the very request that spawned
    this thread, so "no row yet" is the normal first-turn state. Reading it as
    "already resolved" would disable the feature entirely."""
    with (
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme Corp"}) as intel,
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location("session-that-does-not-exist-yet", "8.8.8.8")

    assert intel.call_count == 1


def test_intel_still_resolves_when_only_the_location_is_known(db):
    """Partial state must resolve the missing half, not skip both."""
    session_id = _seed(
        db,
        client_id=12,
        bot_key="bot-partial",
        session_id="s-partial",
        location="Mumbai, India | 8.8.8.8",
    )

    with (
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme Corp"}) as intel,
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8")

    assert intel.call_count == 1


def test_the_bare_ip_stamp_does_not_count_as_a_resolved_location(db):
    """The request handler writes "IP: x.x.x.x" synchronously before this runs.
    Treating that as resolved would mean geolocation never ran at all."""
    from app.api.chat_routes import _already_resolved

    session_id = _seed(
        db,
        client_id=13,
        bot_key="bot-stamp1",
        session_id="s-stamp",
        location="IP: 8.8.8.8",
    )
    with patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)):
        _, has_location = _already_resolved(session_id, "8.8.8.8")
    assert has_location is False


def test_a_failed_state_read_resolves_rather_than_skipping(db):
    """The guard is an optimisation. If it cannot read the prior state it must
    fall through and do the work — never silently suppress the feature."""
    from app.api.chat_routes import _already_resolved

    with patch("app.api.chat_routes.get_session", side_effect=RuntimeError("db down")):
        assert _already_resolved("any-session", "8.8.8.8") == (False, False)
