"""AWS SES HTTPS API transport (``email_service._send_ses_email``) and the
``EMAIL_PROVIDER`` dispatch in ``_send_raw_email``.

Pure-function tests, no DB, no network — ``boto3.client`` is stubbed, matching
the existing Brevo tests' pattern of stubbing ``urlopen`` rather than hitting
the network. See ``test_invoice_email_attachment.py`` for the sibling suite on
the Brevo side.

Deliberately NOT SMTP: DigitalOcean (and most hosts) block outbound SMTP ports
25/465/587 by default, so this transport uses the SES HTTPS API instead — see
the EMAIL_PROVIDER comment in config.py.
"""

import base64
import logging
from unittest.mock import MagicMock, patch

from botocore.exceptions import ClientError

from app.services import email_service

TO = "customer@example.com"


class _FakeSesClient:
    """Stand-in for the boto3 SES client."""

    instances: list["_FakeSesClient"] = []

    def __init__(self, error: Exception | None = None):
        self.sent = None
        self._error = error
        _FakeSesClient.instances.append(self)

    def send_raw_email(self, *, Source, Destinations, RawMessage):
        if self._error:
            raise self._error
        self.sent = (Source, Destinations, RawMessage["Data"])


class TestSendSesEmail:
    def setup_method(self):
        _FakeSesClient.instances.clear()

    def test_sends_via_the_ses_api_with_credentials(self, monkeypatch):
        monkeypatch.setattr(email_service, "EMAIL_ENABLED", True)
        monkeypatch.setattr(email_service, "SES_AWS_REGION", "ap-south-1")
        monkeypatch.setattr(email_service, "SES_AWS_ACCESS_KEY_ID", "AKIAFAKEUSER")
        monkeypatch.setattr(email_service, "SES_AWS_SECRET_ACCESS_KEY", "fake-secret-key")

        captured_kwargs = {}

        def _fake_boto3_client(service, **kwargs):
            captured_kwargs.update(kwargs)
            return _FakeSesClient()

        monkeypatch.setattr(email_service.boto3, "client", _fake_boto3_client)

        ok = email_service._send_ses_email(TO, "Your invoice", "<p>hi</p>")

        assert ok is True
        assert captured_kwargs == {
            "region_name": "ap-south-1",
            "aws_access_key_id": "AKIAFAKEUSER",
            "aws_secret_access_key": "fake-secret-key",
        }
        source, destinations, raw_bytes = _FakeSesClient.instances[0].sent
        assert destinations == [TO]
        message = raw_bytes.decode()
        assert "Your invoice" in message
        assert base64.b64encode(b"<p>hi</p>").decode() in message, "HTML body rides base64-encoded in the MIME part"

    def test_attachment_rides_through_as_a_mime_part(self, monkeypatch):
        monkeypatch.setattr(email_service, "EMAIL_ENABLED", True)
        monkeypatch.setattr(email_service, "SES_AWS_ACCESS_KEY_ID", "AKIAFAKEUSER")
        monkeypatch.setattr(email_service, "SES_AWS_SECRET_ACCESS_KEY", "fake-secret-key")
        monkeypatch.setattr(email_service.boto3, "client", lambda *a, **k: _FakeSesClient())

        pdf_b64 = base64.b64encode(b"%PDF-1.4 fake").decode()
        ok = email_service._send_ses_email(
            TO, "Invoice", "<p>hi</p>", attachments=[{"content": pdf_b64, "name": "invoice.pdf"}]
        )

        assert ok is True
        _, _, raw_bytes = _FakeSesClient.instances[0].sent
        assert "invoice.pdf" in raw_bytes.decode()

    def test_skips_send_when_ses_not_configured(self, monkeypatch, caplog):
        monkeypatch.setattr(email_service, "EMAIL_ENABLED", False)
        monkeypatch.setattr(email_service.boto3, "client", lambda *a, **k: _FakeSesClient())

        with caplog.at_level(logging.WARNING):
            ok = email_service._send_ses_email(TO, "Subject", "<p>hi</p>")

        assert ok is False
        assert _FakeSesClient.instances == [], "must not touch the network when EMAIL_ENABLED is False"
        assert "Email skipped" in caplog.text

    def test_api_failure_returns_false_and_redacts_the_recipient(self, monkeypatch, caplog):
        monkeypatch.setattr(email_service, "EMAIL_ENABLED", True)
        monkeypatch.setattr(email_service, "SES_AWS_ACCESS_KEY_ID", "AKIAFAKEUSER")
        monkeypatch.setattr(email_service, "SES_AWS_SECRET_ACCESS_KEY", "fake-secret-key")
        monkeypatch.setattr(email_service, "_capture_email_failure", lambda *_a, **_k: None)

        error = ClientError(
            {"Error": {"Code": "MessageRejected", "Message": "Email address not verified"}}, "SendRawEmail"
        )
        monkeypatch.setattr(email_service.boto3, "client", lambda *a, **k: _FakeSesClient(error=error))

        with caplog.at_level(logging.WARNING):
            ok = email_service._send_ses_email(TO, "Subject", "<p>hi</p>")

        assert ok is False
        assert "SES email failed" in caplog.text
        assert TO not in caplog.text
        assert "c***@example.com" in caplog.text


class TestExtractSesError:
    def test_client_error_includes_code_and_message(self):
        error = ClientError({"Error": {"Code": "Throttling", "Message": "Rate exceeded"}}, "SendRawEmail")
        reason = email_service._extract_ses_error(error)
        assert "Throttling" in reason
        assert "Rate exceeded" in reason

    def test_generic_exception(self):
        reason = email_service._extract_ses_error(OSError("timed out"))
        assert "OSError" in reason
        assert "timed out" in reason


class TestSendRawEmailDispatch:
    """``_send_raw_email`` is the one seam every sender crosses (directly or via
    ``send_email_async``); it must route on ``EMAIL_PROVIDER`` and nothing else."""

    def test_defaults_to_brevo(self, monkeypatch):
        monkeypatch.setattr(email_service, "EMAIL_PROVIDER", "brevo")
        with (
            patch.object(email_service, "_send_brevo_email", MagicMock(return_value=True)) as brevo,
            patch.object(email_service, "_send_ses_email", MagicMock(return_value=True)) as ses,
        ):
            result = email_service._send_raw_email(TO, "Subject", "<p>hi</p>")

        assert result is True
        brevo.assert_called_once()
        ses.assert_not_called()

    def test_routes_to_ses_when_selected(self, monkeypatch):
        monkeypatch.setattr(email_service, "EMAIL_PROVIDER", "ses")
        with (
            patch.object(email_service, "_send_brevo_email", MagicMock(return_value=True)) as brevo,
            patch.object(email_service, "_send_ses_email", MagicMock(return_value=True)) as ses,
        ):
            result = email_service._send_raw_email(
                TO, "Subject", "<p>hi</p>", reply_to="support@oyechats.com", attachments=[{"content": "x", "name": "a"}]
            )

        assert result is True
        ses.assert_called_once_with(
            TO,
            "Subject",
            "<p>hi</p>",
            reply_to="support@oyechats.com",
            sender_name=None,
            attachments=[{"content": "x", "name": "a"}],
        )
        brevo.assert_not_called()
