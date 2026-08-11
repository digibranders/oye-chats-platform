from contextlib import contextmanager
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
        # Company lookup is now Professional-gated + metered — stub the plan gate,
        # the per-agent toggle (defaults OFF), and the credit reservation so the
        # lookup path runs. This test cares about the write, not the gates.
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        patch("app.api.chat_routes._agent_enrichment_opt_in", return_value=True),
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
        patch("app.api.chat_routes._agent_enrichment_opt_in", return_value=True),
        patch("app.api.chat_routes._charge_for_enrichment", return_value=True),
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo for this test")),
        patch("app.api.chat_routes.get_session", return_value=MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", bot.id)

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


@contextmanager
def _metering_allowed():
    """Plan gate open and the charge accepted, so the dedup tests exercise the
    real path. The charge mock is ASSERTED ON, not just installed — "charged
    once per session, not once per message" is the billing property these
    tests exist to protect."""
    with (
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        # The third gate: the per-agent customer toggle. Patched because most
        # of these tests seed a bot row directly and care about dedup/metering
        # order, not about the toggle — the toggle has its own tests.
        patch("app.api.chat_routes._agent_enrichment_opt_in", return_value=True),
        patch("app.api.chat_routes._charge_for_enrichment", return_value=True) as charge,
    ):
        yield charge


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
        _metering_allowed(),
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme Corp"}) as intel,
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", 10)
        assert intel.call_count == 1

        # Turns 2 and 3 of the same conversation.
        _resolve_and_update_location(session_id, "8.8.8.8", 10)
        _resolve_and_update_location(session_id, "8.8.8.8", 10)

    assert intel.call_count == 1, "the IP lookup was repeated for an unchanged session IP"


def test_the_company_lookup_is_charged_once_per_session_not_once_per_message(db):
    """The billing property, asserted at the charge rather than the lookup.

    `fetch_ip_intel` is metered at `credit_cost.company_name` (10). It is
    submitted from /chat and /chat/stream on EVERY message, so charging before
    the dedup check bills a 15-turn conversation 150 credits of enrichment
    against 15 credits of actual AI replies — roughly 67 conversations would
    exhaust a Professional plan's whole monthly allowance.

    The two halves of this — the metering and the dedup — were written
    independently and git merges them with no conflict in either order, so
    nothing but this test holds the order in place.
    """
    session_id = _seed(db, client_id=30, bot_key="bot-charge1", session_id="s-charge")

    with (
        _metering_allowed() as charge,
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme Corp"}),
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        for _ in range(5):
            _resolve_and_update_location(session_id, "8.8.8.8", 30)

    assert charge.call_count == 1, (
        f"charged {charge.call_count}x for one visitor's company lookup — "
        "the charge must sit behind the per-session dedup"
    )
    # And it must carry an idempotency key, so two overlapping background
    # threads cannot both succeed even when both pass the best-effort dedup.
    assert charge.call_args.kwargs.get("idempotency_key"), "the enrichment charge has no idempotency key"


def test_a_changed_ip_is_resolved_again(db):
    """Keyed on the IP, not on mere presence — a visitor who moves from wifi to
    mobile data mid-conversation is genuinely somewhere new."""
    session_id = _seed(db, client_id=11, bot_key="bot-moved1", session_id="s-moved")

    with (
        _metering_allowed(),
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme Corp"}) as intel,
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", 11)
        _resolve_and_update_location(session_id, "1.1.1.1", 11)

    assert intel.call_count == 2


def test_a_missing_session_row_is_not_mistaken_for_already_done(db):
    """The row is INSERTed by rag_pipeline on the very request that spawned
    this thread, so "no row yet" is the normal first-turn state. Reading it as
    "already resolved" would disable the feature entirely."""
    with (
        _metering_allowed(),
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme Corp"}) as intel,
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location("session-that-does-not-exist-yet", "8.8.8.8", 999)

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
        _metering_allowed(),
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme Corp"}) as intel,
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", 12)

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


def _geo_response(city="Delhi", country="India"):
    """A successful ipwho.is body, as urlopen would deliver it."""
    import json as _json
    from unittest.mock import MagicMock

    payload = _json.dumps({"success": True, "city": city, "country": country}).encode()
    response = MagicMock()
    response.__enter__.return_value.read.return_value = payload
    return response


def test_the_geolocation_vendors_are_skipped_once_the_location_is_known(db):
    """The headline saving, and it had no test.

    Every other test in this file patches urlopen to raise, so none of them
    could tell whether the geo half was skipped or merely failing. Deleting
    the `or has_location` guard passed the whole suite.
    """
    session_id = _seed(db, client_id=20, bot_key="bot-geo1", session_id="s-geo")

    with (
        _metering_allowed(),
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme Corp"}),
        patch("app.api.chat_routes.urllib.request.urlopen", return_value=_geo_response()) as geo,
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", 20)
        assert geo.call_count == 1, "the first turn must resolve the location"

        _resolve_and_update_location(session_id, "8.8.8.8", 20)
        _resolve_and_update_location(session_id, "8.8.8.8", 20)

    assert geo.call_count == 1, "the geolocation vendors were re-hit for a known location"
    assert db.query(ChatSession).filter(ChatSession.id == session_id).first().location == "Delhi, India | 8.8.8.8"


def test_a_new_ip_replaces_a_stale_resolved_location(db):
    """The writer only overwrote an empty or "IP:"-prefixed value, so a visitor
    who changed network kept their first city forever — and because the guard
    then never saw a location matching the new IP, BOTH geo vendors were re-hit
    on every subsequent message and the answer thrown away each time."""
    session_id = _seed(db, client_id=21, bot_key="bot-geo2", session_id="s-geo-move")

    with (
        _metering_allowed(),
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme Corp"}),
        patch("app.api.chat_routes.urllib.request.urlopen", return_value=_geo_response("Delhi", "India")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", 21)

    with (
        _metering_allowed(),
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme Corp"}),
        patch("app.api.chat_routes.urllib.request.urlopen", return_value=_geo_response("Mumbai", "India")) as geo,
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "1.1.1.1", 21)
        # ...and the new value must now latch, so a third message is free.
        _resolve_and_update_location(session_id, "1.1.1.1", 21)

    assert db.query(ChatSession).filter(ChatSession.id == session_id).first().location == "Mumbai, India | 1.1.1.1"
    assert geo.call_count == 1, "the re-resolved location did not latch; every message re-hits the vendors"


def test_a_hand_written_location_is_never_clobbered(db):
    """The other half of the same rule. Widening the overwrite to "anything
    with a pipe in it" would eat a human's note."""
    from app.api.chat_routes import _is_resolver_owned_location

    assert _is_resolver_owned_location("") is True
    assert _is_resolver_owned_location("IP: 8.8.8.8") is True
    assert _is_resolver_owned_location("Delhi, India | 8.8.8.8") is True
    # Not ours: the trailing segment has to parse as a real IP.
    assert _is_resolver_owned_location("Head office | Mumbai") is False
    assert _is_resolver_owned_location("Verified on-site") is False


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


# ── Charge only for an answer ────────────────────────────────────────────────
#
# An IP names a company only when that company owns its range. Measured on
# production traffic, 10 resolutions produced ZERO usable company names — 9
# consumer ISPs and a subnet label. Charging before the lookup therefore billed
# the full 10 credits for "not identified" nearly every time.


def test_no_charge_when_the_visitor_cannot_be_resolved_to_a_company(db):
    """The COMMON case, and the one that decides whether this feature is
    honest: a home or mobile visitor resolves to a carrier, `ip_intel_service`
    nulls the company name, and the customer must pay nothing."""
    session_id = _seed(db, client_id=40, bot_key="bot-nocharge", session_id="s-nocharge")
    isp_only = {"company_name": None, "company_domain": None, "asn_org": "Bharti Airtel Limited"}

    with (
        _metering_allowed() as charge,
        patch("app.api.chat_routes.fetch_ip_intel", return_value=isp_only) as intel,
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", 40)

    assert intel.call_count == 1, "the lookup still runs — we eat the vendor call"
    assert charge.call_count == 0, "charged 10 credits for 'no company identified'"

    # The free network signal is still stored, so the operator sees who routed
    # the visitor and the dedup latches (no re-lookup next message).
    db.expire_all()
    stored = db.query(ChatSession).filter(ChatSession.id == session_id).first().visitor_metadata["ip_intel"]
    assert stored["asn_org"] == "Bharti Airtel Limited"
    assert stored["company_name"] is None


def test_charged_when_a_company_is_actually_identified(db):
    session_id = _seed(db, client_id=41, bot_key="bot-charged", session_id="s-charged")

    with (
        _metering_allowed() as charge,
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Infosys Limited"}),
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", 41)

    assert charge.call_count == 1


def test_the_feature_switch_stops_the_vendor_call_entirely(db):
    """Off must mean no lookup, not merely no charge — otherwise a disabled
    feature still spends OyeChats' own ipapi.is quota on every session."""
    from app.services import credit_service

    session_id = _seed(db, client_id=42, bot_key="bot-switchoff", session_id="s-switchoff")

    with (
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        patch.object(credit_service, "is_feature_enabled", return_value=False),
        patch("app.api.chat_routes._charge_for_enrichment", return_value=True) as charge,
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme"}) as intel,
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", 42)

    assert intel.call_count == 0, "the switch is off but the paid vendor call still fired"
    assert charge.call_count == 0


def test_an_identified_company_is_withheld_when_the_charge_fails(db):
    """Out of credits: keep the free network signal, withhold the paid answer.
    Storing the company anyway would give it away; storing nothing would
    re-run the vendor call on every subsequent message."""
    session_id = _seed(db, client_id=43, bot_key="bot-broke", session_id="s-broke")

    with (
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        patch("app.api.chat_routes._agent_enrichment_opt_in", return_value=True),
        patch("app.api.chat_routes._charge_for_enrichment", return_value=False),
        patch(
            "app.api.chat_routes.fetch_ip_intel",
            return_value={"company_name": "Infosys Limited", "company_domain": "infosys.com", "asn_org": "Infosys"},
        ),
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", 43)

    db.expire_all()
    stored = db.query(ChatSession).filter(ChatSession.id == session_id).first().visitor_metadata["ip_intel"]
    assert stored["company_name"] is None, "an unpaid company identification was given away"
    assert stored["company_domain"] is None
    assert stored["asn_org"] == "Infosys", "the free network signal should survive"


def test_the_customer_toggle_stops_the_company_lookup(db):
    """The third gate, end-to-end and NOT patched.

    The helper has its own unit tests, but those pass whether or not the gate
    is actually wired into the resolution path — `_metering_allowed` patches
    the helper open. This one drives the real column: a Professional agent with
    `company_lookup_enabled = False` must make no vendor call and no charge.

    Verified by mutation: removing `customer_wants_it` from the gate leaves
    every other test in this file green.
    """
    from app.services import credit_service

    session_id = _seed(db, client_id=50, bot_key="bot-optout", session_id="s-optout")
    bot = db.query(Bot).filter(Bot.id == 50).first()
    bot.company_lookup_enabled = False
    db.commit()

    with (
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        patch.object(credit_service, "is_feature_enabled", return_value=True),
        patch("app.api.chat_routes._charge_for_enrichment", return_value=True) as charge,
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme"}) as intel,
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", 50)

    assert intel.call_count == 0, "the customer switched it off but the paid vendor call still fired"
    assert charge.call_count == 0, "charged for an enrichment the customer disabled"


def test_the_customer_toggle_left_on_permits_the_lookup(db):
    """The contrast case: the customer has switched the toggle ON, with the gate
    NOT patched open, so the real ``company_lookup_enabled`` column drives the
    lookup. Enrichment now defaults OFF (migration ``b3d9f1a7c2e5``), so the
    opt-in is set explicitly here rather than relied on as a default."""
    from app.services import credit_service

    session_id = _seed(db, client_id=51, bot_key="bot-optin", session_id="s-optin")
    bot = db.query(Bot).filter(Bot.id == 51).first()
    bot.company_lookup_enabled = True
    db.commit()

    with (
        patch("app.api.chat_routes.is_visitor_intelligence_enabled_for_bot", return_value=True),
        patch.object(credit_service, "is_feature_enabled", return_value=True),
        patch("app.api.chat_routes._charge_for_enrichment", return_value=True) as charge,
        patch("app.api.chat_routes.fetch_ip_intel", return_value={"company_name": "Acme"}) as intel,
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=_MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8", 51)

    assert intel.call_count == 1
    assert charge.call_count == 1
