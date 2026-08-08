import json
from unittest.mock import MagicMock, patch

from app.services.reoon_service import verify_email


def _mock_response(payload: dict):
    mock_resp = MagicMock()
    mock_resp.read.return_value = json.dumps(payload).encode()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = False
    return mock_resp


def test_verify_email_safe_to_send(monkeypatch):
    monkeypatch.setenv("REOON_API_KEY", "test-key")
    payload = {
        "status": "safe",
        "overall_score": 98,
        "is_safe_to_send": True,
        "is_disposable": False,
        "is_deliverable": True,
    }
    with patch("app.services.reoon_service.urllib.request.urlopen", return_value=_mock_response(payload)):
        result = verify_email("gaurav@fynix.digital")

    assert result["is_safe_to_send"] is True
    assert result["status"] == "safe"


def test_verify_email_not_safe_to_send(monkeypatch):
    monkeypatch.setenv("REOON_API_KEY", "test-key")
    payload = {
        "status": "invalid",
        "overall_score": 3,
        "is_safe_to_send": False,
        "is_disposable": False,
        "is_deliverable": False,
    }
    with patch("app.services.reoon_service.urllib.request.urlopen", return_value=_mock_response(payload)):
        result = verify_email("gaurav@cleanstart.com")

    assert result["is_safe_to_send"] is False


def test_verify_email_returns_none_on_error(monkeypatch):
    monkeypatch.setenv("REOON_API_KEY", "test-key")
    with patch("app.services.reoon_service.urllib.request.urlopen", side_effect=OSError("timeout")):
        result = verify_email("test@example.com")

    assert result is None


def test_verify_email_returns_none_without_api_key(monkeypatch):
    monkeypatch.delenv("REOON_API_KEY", raising=False)
    assert verify_email("test@example.com") is None
