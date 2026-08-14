"""Unit tests for the visitor-IP redactor.

Pinned against the REAL stored formats, not invented ones: every ``location``
string below is a shape ``chat_routes`` actually writes (see
``_resolve_and_update_location`` for the two resolved forms and the request
handlers for the ``"IP: <addr>"`` stamp). A test that redacts a made-up format
proves nothing about the column it is supposed to protect.
"""

import ipaddress
import re

import pytest

from app.core.visitor_privacy import (
    UNKNOWN_LOCATION,
    format_visitor_location,
    redact_visitor_ip,
    redact_visitor_metadata,
)

# The two vendors behind the geo lookup return IPv4 and IPv6 alike, so both
# stored shapes have to redact. The IPv6 case is the one a naive "strip the
# last dotted quad" implementation would sail straight past.
_IPV4 = "103.21.244.12"
_IPV6 = "2401:4900:88b1:7265:cdd1:3f28:b37:8f91"


class TestRedactVisitorIp:
    @pytest.mark.parametrize(
        ("stored", "expected"),
        [
            # "<City>, <Country> | <IP>" — what the resolver writes on success.
            (f"Mumbai, India | {_IPV4}", "Mumbai, India"),
            (f"Mumbai, India | {_IPV6}", "Mumbai, India"),
            # "<Country> | <IP>" — same resolver, vendor had no city.
            (f"India | {_IPV4}", "India"),
            # A city containing the separator's neighbours must survive whole.
            (f"Washington, D.C., United States | {_IPV4}", "Washington, D.C., United States"),
        ],
    )
    def test_a_resolved_location_keeps_its_geography_and_loses_its_ip(self, stored, expected):
        assert redact_visitor_ip(stored) == expected

    def test_the_pre_resolution_stamp_yields_nothing_rather_than_a_bare_address(self):
        """``"IP: 1.2.3.4"`` holds no geography at all — it must not print.

        This is the shape a session carries for the first few hundred
        milliseconds of its life, and for the whole of it if both geo vendors
        fail. Returning the string unchanged would put a raw address in a table
        cell, which is the loudest possible version of this bug.
        """
        assert redact_visitor_ip(f"IP: {_IPV4}") is None
        assert redact_visitor_ip(f"ip: {_IPV6}") is None

    @pytest.mark.parametrize("stored", [None, "", "   "])
    def test_absence_is_none_so_each_caller_can_spell_it_its_own_way(self, stored):
        """A file wants an empty cell, a table wants a word. Neither is decided here."""
        assert redact_visitor_ip(stored) is None

    def test_a_location_with_no_ip_component_round_trips(self):
        """Not every stored value came from the resolver.

        ``_is_resolver_owned_location`` deliberately leaves manually-set values
        alone, so a plain place name can sit in this column indefinitely. It has
        no IP to strip and must come back byte-identical.
        """
        assert redact_visitor_ip("Mumbai, India") == "Mumbai, India"
        assert redact_visitor_ip("Bengaluru") == "Bengaluru"

    def test_it_is_idempotent(self):
        """The TypeScript twin runs over the same value in the browser.

        Both passes have to be safe, or the server's redaction and the
        dashboard's would corrupt each other's output.
        """
        once = redact_visitor_ip(f"Mumbai, India | {_IPV4}")
        assert redact_visitor_ip(once) == once

    def test_a_pipe_it_cannot_vouch_for_is_still_cut(self):
        """The deliberate over-redaction, pinned so nobody "fixes" it.

        This function decides what to EMIT, so an unrecognised tail is dropped
        rather than trusted. The narrower "only cut a tail that parses as an
        IP" rule belongs to ``_is_resolver_owned_location``, which decides what
        to OVERWRITE and is cautious in the opposite direction.
        """
        assert redact_visitor_ip("Head office | Mumbai") == "Head office"

    def test_no_output_can_contain_an_ip_for_any_shape_the_writer_produces(self):
        """The property the whole module exists for, swept over every writer.

        Enumerates the three f-strings in ``chat_routes`` rather than a fixed
        list of examples, so a fourth shape added there without a redaction rule
        has a chance of being caught here.
        """
        for address in (_IPV4, _IPV6):
            for stored in (
                f"Mumbai, India | {address}",
                f"India | {address}",
                f"IP: {address}",
            ):
                out = redact_visitor_ip(stored) or ""
                assert address not in out, stored
                # And nothing that merely *looks* like an address survives.
                for token in re.split(r"[\s,]+", out):
                    with pytest.raises(ValueError):
                        ipaddress.ip_address(token)


class TestFormatVisitorLocation:
    def test_it_names_absence_with_the_shared_word(self):
        assert format_visitor_location(None) == UNKNOWN_LOCATION
        assert format_visitor_location("") == UNKNOWN_LOCATION
        assert format_visitor_location(f"IP: {_IPV4}") == UNKNOWN_LOCATION

    def test_it_is_the_redactor_plus_that_word(self):
        assert format_visitor_location(f"Mumbai, India | {_IPV4}") == "Mumbai, India"


class TestRedactVisitorMetadata:
    def test_it_drops_the_dedup_marker_and_keeps_the_paid_enrichment(self):
        """``resolved_for_ip`` is the visitor's address, verbatim, in a JSON blob.

        The customer paid for the company/ASN/threat signal beside it and keeps
        every bit of that; the marker is our own bookkeeping and has no reader
        outside ``chat_routes._already_resolved``.
        """
        stored = {
            "browser": "Chrome",
            "ip_intel": {
                "company_name": "Infosys",
                "asn": "AS15169",
                "is_vpn": False,
                "resolved_for_ip": _IPV4,
            },
        }

        out = redact_visitor_metadata(stored)

        assert out is not None
        assert "resolved_for_ip" not in out["ip_intel"]
        assert out["ip_intel"] == {"company_name": "Infosys", "asn": "AS15169", "is_vpn": False}
        assert out["browser"] == "Chrome"

    def test_it_does_not_mutate_the_stored_column(self):
        """The input is a live SQLAlchemy JSON value.

        Popping the key in place would delete the marker from the row on the
        next flush, and every later message in that conversation would re-run —
        and re-bill — the ipapi.is lookup the marker exists to prevent.
        """
        stored = {"ip_intel": {"company_name": "Infosys", "resolved_for_ip": _IPV4}}

        redact_visitor_metadata(stored)

        assert stored["ip_intel"]["resolved_for_ip"] == _IPV4

    @pytest.mark.parametrize(
        "stored",
        [
            None,
            {},
            {"browser": "Chrome"},
            {"ip_intel": None},
            {"ip_intel": {"company_name": "Infosys"}},
        ],
    )
    def test_a_blob_with_no_marker_is_passed_straight_through(self, stored):
        """``visitor_metadata`` predates this feature and holds user-agent keys too."""
        assert redact_visitor_metadata(stored) == stored
