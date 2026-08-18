import json
from unittest.mock import MagicMock, patch

from app.services.ip_intel_service import fetch_ip_intel


def _mock_response(payload: dict):
    mock_resp = MagicMock()
    mock_resp.read.return_value = json.dumps(payload).encode()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = False
    return mock_resp


def test_fetch_ip_intel_parses_business_company(monkeypatch):
    """ipapi.is nests company/asn as OBJECTS; this service must flatten them.

    Previously this asserted the nested dict was passed through verbatim,
    which is exactly what broke the Leads UI, it reads these as strings, so
    a dict rendered as nothing. Assert primitives, not the vendor's shape.
    """
    monkeypatch.setenv("IPAPI_IS_KEY", "test-key")
    payload = {
        "company": {"name": "Acme Corp", "domain": "acme.com", "type": "business"},
        "asn": {"asn": 64500, "org": "Acme Corp", "domain": "acme.com"},
        "is_vpn": False,
        "is_proxy": False,
        "is_datacenter": False,
        "is_abuser": False,
    }
    with patch("app.services.ip_intel_service.urllib.request.urlopen", return_value=_mock_response(payload)):
        result = fetch_ip_intel("1.2.3.4")

    assert result["company_name"] == "Acme Corp"
    assert result["company_domain"] == "acme.com"
    assert result["company_type"] == "business"
    assert result["asn"] == 64500
    assert result["asn_org"] == "Acme Corp"
    assert result["is_vpn"] is False
    assert result["is_datacenter"] is False
    # Regression guard: a nested object anywhere means the UI shows nothing.
    assert not any(isinstance(v, dict) for v in result.values())


def test_fetch_ip_intel_returns_none_on_error(monkeypatch):
    monkeypatch.setenv("IPAPI_IS_KEY", "test-key")
    with patch("app.services.ip_intel_service.urllib.request.urlopen", side_effect=OSError("timeout")):
        result = fetch_ip_intel("1.2.3.4")

    assert result is None


def test_fetch_ip_intel_returns_none_without_api_key(monkeypatch):
    monkeypatch.delenv("IPAPI_IS_KEY", raising=False)
    result = fetch_ip_intel("1.2.3.4")
    assert result is None
