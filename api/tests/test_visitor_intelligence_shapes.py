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
