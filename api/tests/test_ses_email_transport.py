"""AWS SES SMTP transport (``email_service._send_ses_email``) and the
``EMAIL_PROVIDER`` dispatch in ``_send_raw_email``.

Pure-function tests, no DB, no network — ``smtplib.SMTP`` is stubbed, matching
the existing Brevo tests' pattern of stubbing ``urlopen`` rather than hitting
the network. See ``test_invoice_email_attachment.py`` for the sibling suite on
the Brevo side.
"""

import base64
import logging
from unittest.mock import MagicMock, patch

from app.services import email_service

TO = "customer@example.com"


class _FakeSMTP:
    """Stand-in for ``smtplib.SMTP`` used as a context manager."""

    instances: list["_FakeSMTP"] = []

    def __init__(self, host, port, timeout=None):
        self.host = host
        self.port = port
        self.starttls_called = False
        self.login_args = None
        self.sent = None
        _FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self):
        self.starttls_called = True

    def login(self, user, password):
        self.login_args = (user, password)

    def sendmail(self, from_addr, to_addrs, message):
        self.sent = (from_addr, to_addrs, message)


class TestSendSesEmail:
    def setup_method(self):
        _FakeSMTP.instances.clear()

    def test_sends_over_smtp_with_ses_credentials(self, monkeypatch):
        monkeypatch.setattr(email_service, "EMAIL_ENABLED", True)
        monkeypatch.setattr(email_service, "SES_SMTP_HOST", "email-smtp.ap-south-1.amazonaws.com")
        monkeypatch.setattr(email_service, "SES_SMTP_PORT", 587)
        monkeypatch.setattr(email_service, "SES_SMTP_USERNAME", "AKIAFAKEUSER")
        monkeypatch.setattr(email_service, "SES_SMTP_PASSWORD", "fake-smtp-password")
        monkeypatch.setattr(email_service.smtplib, "SMTP", _FakeSMTP)

        ok = email_service._send_ses_email(TO, "Your invoice", "<p>hi</p>")

        assert ok is True
        smtp = _FakeSMTP.instances[0]
        assert smtp.host == "email-smtp.ap-south-1.amazonaws.com"
        assert smtp.port == 587
        assert smtp.starttls_called is True
        assert smtp.login_args == ("AKIAFAKEUSER", "fake-smtp-password")
        from_addr, to_addrs, message = smtp.sent
        assert to_addrs == [TO]
        assert "Your invoice" in message
        assert base64.b64encode(b"<p>hi</p>").decode() in message, "HTML body rides base64-encoded in the MIME part"

    def test_attachment_rides_through_as_a_mime_part(self, monkeypatch):
        monkeypatch.setattr(email_service, "EMAIL_ENABLED", True)
        monkeypatch.setattr(email_service, "SES_SMTP_USERNAME", "AKIAFAKEUSER")
        monkeypatch.setattr(email_service, "SES_SMTP_PASSWORD", "fake-smtp-password")
        monkeypatch.setattr(email_service.smtplib, "SMTP", _FakeSMTP)

        pdf_b64 = base64.b64encode(b"%PDF-1.4 fake").decode()
        ok = email_service._send_ses_email(
            TO, "Invoice", "<p>hi</p>", attachments=[{"content": pdf_b64, "name": "invoice.pdf"}]
        )

        assert ok is True
        _, _, message = _FakeSMTP.instances[0].sent
        assert "invoice.pdf" in message

    def test_skips_send_when_ses_not_configured(self, monkeypatch, caplog):
        monkeypatch.setattr(email_service, "EMAIL_ENABLED", False)
        monkeypatch.setattr(email_service.smtplib, "SMTP", _FakeSMTP)

        with caplog.at_level(logging.WARNING):
            ok = email_service._send_ses_email(TO, "Subject", "<p>hi</p>")

        assert ok is False
        assert _FakeSMTP.instances == [], "must not touch the network when EMAIL_ENABLED is False"
        assert "Email skipped" in caplog.text

    def test_smtp_failure_returns_false_and_redacts_the_recipient(self, monkeypatch, caplog):
        monkeypatch.setattr(email_service, "EMAIL_ENABLED", True)
        monkeypatch.setattr(email_service, "SES_SMTP_USERNAME", "AKIAFAKEUSER")
        monkeypatch.setattr(email_service, "SES_SMTP_PASSWORD", "fake-smtp-password")
        monkeypatch.setattr(email_service, "_capture_email_failure", lambda *_a, **_k: None)

        def _boom(*_a, **_k):
            raise OSError("connection reset by peer")

        monkeypatch.setattr(email_service.smtplib, "SMTP", _boom)

        with caplog.at_level(logging.WARNING):
            ok = email_service._send_ses_email(TO, "Subject", "<p>hi</p>")

        assert ok is False
        assert "SES email failed" in caplog.text
        assert TO not in caplog.text
        assert "c***@example.com" in caplog.text


class TestExtractSmtpError:
    def test_generic_smtp_exception(self):
        import smtplib

        # SMTPServerDisconnected has no response code (unlike SMTPHeloError, which
        # is an SMTPResponseException and goes through the branch above instead).
        reason = email_service._extract_smtp_error(smtplib.SMTPServerDisconnected("Connection unexpectedly closed"))
        assert "SMTPServerDisconnected" in reason

    def test_response_exception_includes_code(self):
        import smtplib

        exc = smtplib.SMTPSenderRefused(550, "not verified", "noreply@oyechats.com")
        reason = email_service._extract_smtp_error(exc)
        assert "550" in reason

    def test_os_error(self):
        reason = email_service._extract_smtp_error(OSError("timed out"))
        assert "network error" in reason


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
