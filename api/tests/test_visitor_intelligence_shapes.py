"""Shape/contract tests for the visitor-intelligence data path.

These cover the two defects that shipped despite a green unit suite, both
caused by tests asserting an INVENTED payload shape instead of the real one:

1. ``fetch_ip_intel`` returned ipapi.is's nested ``company``/``asn`` objects
   verbatim, while the Leads UI read them as plain strings — so every lead
   rendered "no company signal" even when the data was present.
2. The widget's blur check and the background enrichment used two different
   definitions of "valid email", so a catch-all corporate address could be
   accepted at capture and then be permanently un-emailable.

The fixtures below are VERBATIM ipapi.is / Reoon responses captured from the
live APIs — do not "simplify" them.
"""

import json
from unittest.mock import patch

import pytest

from app.services.ip_intel_service import fetch_ip_intel
from app.services.reoon_service import is_obviously_undeliverable

# Real ipapi.is response for 8.8.8.8 (trimmed to the keys we read).
_REAL_IPAPI_HOSTING = {
    "company": {
        "name": "Google LLC",
        "domain": "google.com",
        "type": "hosting",
        "network": "8.8.8.0 - 8.8.8.255",
    },
    "asn": {"asn": 15169, "org": "Google LLC", "descr": "GOOGLE - Google LLC, US"},
    "is_vpn": True,
    "is_proxy": False,
    "is_tor": False,
    "is_datacenter": True,
    "is_abuser": True,
}

# Residential IPs commonly come back with NO company object at all.
_REAL_IPAPI_RESIDENTIAL = {
    "asn": {"asn": 24560, "descr": "AIRTELBROADBAND-AS-AP Bharti Airtel Ltd."},
    "is_vpn": False,
    "is_datacenter": False,
}


class TestFetchIpIntelFlattening:
    def _fetch(self, payload):
        with (
            patch.dict("os.environ", {"IPAPI_IS_KEY": "test-key"}),
            patch("app.services.ip_intel_service.urllib.request.urlopen") as mock_open,
        ):
            mock_open.return_value.__enter__.return_value.read.return_value = json.dumps(payload).encode()
            return fetch_ip_intel("8.8.8.8")

    def test_nested_company_object_is_flattened_to_primitives(self):
        """Flattening, proved on a `business` payload.

        It used to be proved on the hosting fixture below, asserting
        ``company_name == "Google LLC"``. That expectation is now wrong by
        design — a hosting range is not an employer — but flattening still
        needs a guard, so it moved to a payload where a name is legitimately
        returned.
        """
        result = self._fetch(
            {
                "company": {"name": "Infosys Limited", "domain": "infosys.com", "type": "business"},
                "asn": {"asn": 4755, "org": "Infosys"},
            }
        )
        assert result["company_name"] == "Infosys Limited"
        assert result["company_domain"] == "infosys.com"
        assert result["company_type"] == "business"

    def test_a_hosting_range_is_not_presented_as_an_employer(self):
        """Nobody is employed by a datacenter. The name is still visible as the
        network operator, just not as the visitor's company."""
        result = self._fetch(_REAL_IPAPI_HOSTING)
        assert result["company_name"] is None
        assert result["company_domain"] is None
        assert result["company_type"] == "hosting"
        assert result["asn_org"] == "Google LLC"

    def test_nested_asn_object_is_flattened(self):
        result = self._fetch(_REAL_IPAPI_HOSTING)
        assert result["asn"] == 15169
        assert result["asn_org"] == "Google LLC"

    def test_no_value_is_ever_a_dict(self):
        """The regression guard: the UI reads these as strings/numbers, so a
        nested object anywhere in the payload silently renders as nothing."""
        result = self._fetch(_REAL_IPAPI_HOSTING)
        for key, value in result.items():
            assert not isinstance(value, dict), f"{key} leaked a nested object: {value!r}"

    def test_missing_company_object_does_not_crash(self):
        result = self._fetch(_REAL_IPAPI_RESIDENTIAL)
        assert result["company_name"] is None
        assert result["company_domain"] is None
        # ASN description is the only identity signal a residential IP carries.
        assert result["asn_org"] == "AIRTELBROADBAND-AS-AP Bharti Airtel Ltd."

    def test_risk_flags_are_real_booleans(self):
        result = self._fetch(_REAL_IPAPI_HOSTING)
        assert result["is_vpn"] is True
        assert result["is_datacenter"] is True
        assert result["is_proxy"] is False


class TestSharedValidityPredicate:
    """``is_obviously_undeliverable`` is the ONE definition of junk, shared by
    the widget endpoint and the background enrichment writer."""

    def test_catch_all_corporate_domain_is_deliverable(self):
        """The case that broke follow-up: Reoon can't PROVE deliverability on a
        catch-all, so is_safe_to_send is False — but the address is real and
        must stay contactable."""
        catch_all = {
            "status": "catch_all",
            "is_safe_to_send": False,
            "is_valid_syntax": True,
            "is_disposable": False,
            "is_spamtrap": False,
            "mx_accepts_mail": True,
        }
        assert is_obviously_undeliverable(catch_all) is False

    def test_unknown_status_is_deliverable(self):
        unknown = {
            "status": "unknown",
            "is_safe_to_send": False,
            "is_valid_syntax": True,
            "is_disposable": False,
            "is_spamtrap": False,
            "mx_accepts_mail": True,
        }
        assert is_obviously_undeliverable(unknown) is False

    def test_disposable_is_undeliverable(self):
        assert is_obviously_undeliverable({"status": "disposable", "is_disposable": True}) is True

    def test_spamtrap_is_undeliverable(self):
        assert is_obviously_undeliverable({"status": "safe", "is_spamtrap": True}) is True

    def test_dead_mx_is_undeliverable(self):
        assert is_obviously_undeliverable({"status": "invalid", "mx_accepts_mail": False}) is True

    def test_bad_syntax_is_undeliverable(self):
        assert is_obviously_undeliverable({"status": "invalid", "is_valid_syntax": False}) is True

    def test_none_fails_open(self):
        """Reoon unreachable must never block a real visitor."""
        assert is_obviously_undeliverable(None) is False
        assert is_obviously_undeliverable({}) is False


class TestIpCompanyNameSanityFilter:
    """ipapi.is returns a company object for ISP-owned ranges too, and its
    ``type`` classification is not reliable — production returned
    ``type=business`` for ``TSBB pool2``, a subnet label. Only names that could
    plausibly be an employer may ever reach an operator.

    Measured on real production data: 10 IP resolutions produced 0 usable
    company names (9 consumer ISPs + 1 subnet label). Without this filter that
    is 10 carrier names presented to salespeople as leads' employers.
    """

    @pytest.mark.parametrize(
        "name",
        [
            # Infrastructure labels — the type field called the first of these
            # `business` in production.
            "TSBB pool2",
            "dynamic-pool-42",
            "subnet-allocation-7",
            "IP Pool",
            "DSL Concentrator",
            "CGNAT block 12",
            # Consumer carriers. Their corporate names look plausible, which is
            # why token matching alone is not enough.
            "Bharti Airtel Limited",
            "Reliance Jio Infocomm Limited",
            "Vodafone Idea Ltd. (VIL)",
            "BSNL Broadband",
            "Some Telecom Pvt Ltd",
            "ACT Fibernet",
            # Not a name at all.
            "12345",
            "   ",
            "",
            None,
        ],
    )
    def test_rejects_carriers_and_pool_labels(self, name):
        from app.services.ip_intel_service import is_usable_company_name

        assert is_usable_company_name(name) is False

    @pytest.mark.parametrize(
        "name",
        ["Microsoft Corporation", "Infosys Limited", "Acme Corp", "Zomato"],
    )
    def test_accepts_plausible_employers(self, name):
        from app.services.ip_intel_service import is_usable_company_name

        assert is_usable_company_name(name) is True

    @pytest.mark.parametrize(
        "name",
        [
            # Every one of these is rejected by a naive substring blocklist of
            # network vocabulary, and every one is a real B2B employer — the
            # exact leads this product exists to surface. "network" alone kills
            # four of the best-known names in enterprise infrastructure.
            "Juniper Networks",
            "Palo Alto Networks",
            "Arista Networks",
            "F5 Networks",
            # "mobile", "fibre" and "cable" as substrings.
            "Mobileye",
            "Fibre2Fashion",
            "Cable One",
            # "isp" inside an unrelated word.
            "DispatchTrack",
            "Crisp",
            # "communications" is ordinary company vocabulary.
            "Harris Communications",
        ],
    )
    def test_does_not_reject_real_employers_whose_names_contain_network_words(self, name):
        """Guards the anchoring, not the blocklist.

        This is the same failure the markup extractor already learned once:
        an unanchored substring test rejected "Sparked" for containing
        "parked". Deleting the word-boundary matching here must fail loudly.
        """
        from app.services.ip_intel_service import is_usable_company_name

        assert is_usable_company_name(name) is True

    def test_isp_payload_yields_no_company_name(self):
        """An ``isp`` payload must come back with company_name stripped, so no
        consumer can render a carrier as the visitor's employer."""
        payload = {
            "company": {"name": "Bharti Airtel Limited", "domain": "airtel.in", "type": "isp"},
            "asn": {"asn": 24560, "org": "Bharti Airtel"},
            "is_vpn": False,
        }
        result = TestFetchIpIntelFlattening()._fetch(payload)
        assert result["company_name"] is None
        assert result["company_domain"] is None, "the domain must not survive its name"
        # The network operator is still available, just not as "the company".
        assert result["asn_org"] == "Bharti Airtel"

    def test_business_type_with_a_junk_name_is_still_rejected(self):
        """The case that proves the name filter earns its place: production
        really did return type=business for a subnet label."""
        payload = {
            "company": {"name": "TSBB pool2", "domain": None, "type": "business"},
            "asn": {"asn": 9829, "org": "BSNL"},
        }
        result = TestFetchIpIntelFlattening()._fetch(payload)
        assert result["company_name"] is None

    def test_a_genuine_corporate_ip_survives(self):
        payload = {
            "company": {"name": "Infosys Limited", "domain": "infosys.com", "type": "business"},
            "asn": {"asn": 4755, "org": "Infosys"},
        }
        result = TestFetchIpIntelFlattening()._fetch(payload)
        assert result["company_name"] == "Infosys Limited"
        assert result["company_domain"] == "infosys.com"


class TestIpCompanyNameFilterHardening:
    """Cases from the adversarial review of the first version of the filter.

    Each group below is a defect that shipped and was caught in review, kept as
    a regression guard rather than a description.
    """

    @staticmethod
    def _ok(name):
        from app.services.ip_intel_service import is_usable_company_name

        return is_usable_company_name(name)

    @pytest.mark.parametrize("name", [123, 0, {"name": "x"}, b"Acme", [], 1.5, True])
    def test_a_non_string_name_does_not_raise(self, name):
        """`.strip()` on an int raised AttributeError straight out of
        `fetch_ip_intel`, which sits BEFORE the geolocation lookup inside its
        caller's try block — so one malformed vendor field cost the session its
        city and country as well as its company."""
        assert self._ok(name) is False

    def test_a_malformed_name_does_not_lose_the_rest_of_the_payload(self):
        payload = {
            "company": {"name": 0, "type": "business"},
            "asn": {"asn": 4755, "org": "Some Net"},
            "is_vpn": True,
        }
        result = TestFetchIpIntelFlattening()._fetch(payload)
        assert result is not None, "a non-string company name aborted the whole lookup"
        assert result["company_name"] is None
        assert result["asn_org"] == "Some Net"
        assert result["is_vpn"] is True

    @pytest.mark.parametrize(
        "name",
        [
            "Reliance Jio",
            "Jio",
            "JioFiber",
            "Jio-Fiber",
            "RELIANCEJIO-IN",
        ],
    )
    def test_jio_is_caught_in_every_spelling(self, name):
        """India's largest ISP was matched by the substring `"jio "` — with a
        trailing space. That caught exactly one spelling, the one under test,
        and leaked every other including the real ASN-style org string."""
        assert self._ok(name) is False

    @pytest.mark.parametrize(
        "name",
        ["FTTH Subscribers", "Customer Subnets", "IP Allocations", "Netblocks Ltd", "Telecoms Ltd"],
    )
    def test_plurals_do_not_escape_the_word_set(self, name):
        assert self._ok(name) is False

    @pytest.mark.parametrize(
        "name",
        ["Telecommunication Consultants India Limited", "Telekom Deutschland", "Telco Systems"],
    )
    def test_telecom_variants_are_covered(self, name):
        """The set had `telecom` and `telecommunications` but not the singular
        `telecommunication`, nor the German or shortened forms."""
        assert self._ok(name) is False

    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            # Bare infrastructure vocabulary => a label.
            ("TSBB pool2", False),
            ("BSNL Broadband", False),
            ("subnet-allocation-7", False),
            # The same vocabulary WITH a corporate suffix => a company.
            ("Pool Corporation", True),  # NASDAQ: POOL, ~$5B revenue
            ("Deep Pool Financial Solutions", True),
            ("Broadband Search Ltd", True),
            ("Allocation Network GmbH", True),
            ("Asset Allocation Advisors", True),
        ],
    )
    def test_ambiguous_words_are_decided_by_a_corporate_suffix(self, name, expected):
        """`pool`, `broadband`, `allocation` and `subscriber` are infrastructure
        vocabulary AND ordinary business vocabulary. A registered company says
        so in its name; a subnet label never does."""
        assert self._ok(name) is expected

    @pytest.mark.parametrize(
        "name",
        ["Liverpool Victoria", "Whirlpool Corporation", "Blackpool Council", "Poolside AI"],
    )
    def test_pool_inside_a_longer_word_is_not_a_pool(self, name):
        """The anchoring case that actually matters for the shipped word list —
        the original tests only anchored words that had been removed from it."""
        assert self._ok(name) is True

    @pytest.mark.parametrize(
        "name",
        [
            "Singtel",
            "Swisscom AG",
            "Rostelecom",
            "Turkcell",
            "Telkomsel",
            "Safaricom PLC",
            "CenturyLink",
            "Rogers Communications",
            "BT Group",
            "Virgin Media",
        ],
    )
    def test_carriers_outside_india_are_caught_too(self, name):
        """A review tested 197 realistic carrier names worldwide against the
        first 24-entry list; 126 passed. Traffic is India-heavy but not
        India-only."""
        assert self._ok(name) is False

    @pytest.mark.parametrize("name", ["3M", "GE", "HP", "LG"])
    def test_two_letter_company_names_are_not_junk(self, name):
        assert self._ok(name) is True

    @pytest.mark.parametrize(
        "phrase_name",
        ["Acme Internet Service", "Dynamic IP Ltd", "Static IP Solutions", "Leased Line Co", "Address Pool 4"],
    )
    def test_the_phrase_list_is_load_bearing(self, phrase_name):
        """The phrase list had ZERO coverage — disabling it entirely left the
        suite green, because the only phrase any test touched was also caught
        by the word rule."""
        assert self._ok(phrase_name) is False

    @pytest.mark.parametrize("company_type", ["education", "government"])
    def test_universities_and_government_are_employers(self, company_type):
        """Originally excluded along with hosting and isp, which was an
        oversight: a procurement officer at IIT Bombay is a legitimate — often
        the most valuable — B2B lead, and their range is exactly as
        employer-owned as a company's."""
        payload = {
            "company": {
                "name": "Indian Institute of Technology Bombay",
                "domain": "iitb.ac.in",
                "type": company_type,
            },
            "asn": {"asn": 1234, "org": "ERNET"},
        }
        result = TestFetchIpIntelFlattening()._fetch(payload)
        assert result["company_name"] == "Indian Institute of Technology Bombay"
        assert result["company_domain"] == "iitb.ac.in"

    @pytest.mark.parametrize("company_type", ["hosting", "isp", "unknown-future-value", None])
    def test_every_other_range_type_fails_closed(self, company_type):
        payload = {
            "company": {"name": "Perfectly Normal Corp", "domain": "pnc.com", "type": company_type},
            "asn": {"asn": 1234, "org": "Someone"},
        }
        result = TestFetchIpIntelFlattening()._fetch(payload)
        assert result["company_name"] is None
