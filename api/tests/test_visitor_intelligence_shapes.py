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
        result = self._fetch(_REAL_IPAPI_HOSTING)
        assert result["company_name"] == "Google LLC"
        assert result["company_domain"] == "google.com"
        assert result["company_type"] == "hosting"

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
