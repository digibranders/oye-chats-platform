"""A customer's webhook URL is a credential and must not reach the logs.

For the integrations customers actually wire up (Zapier ``hooks.zapier.com/
hooks/catch/<id>/<token>/``, Make, n8n) the URL path IS the secret: anyone
holding it can post events straight into the customer's automation. The SSRF
guard logged the whole thing at WARNING, which lands in the journal and rides
into Sentry as a breadcrumb on the worker's next event. ``scrub_event`` strips
request headers, not log-message arguments.

Logging the host is enough to triage a blocked URL. The path never is.
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from app.services import webhook_service

ZAPIER = "https://hooks.zapier.com/hooks/catch/1234567/abcdefTOKENxyz/"
SECRET_PATH = "/hooks/catch/1234567/abcdefTOKENxyz/"


def test_loggable_form_keeps_the_host_and_drops_everything_else():
    assert webhook_service._loggable_url(ZAPIER) == "https://hooks.zapier.com"


@pytest.mark.parametrize(
    "url",
    [
        "https://user:pass@customer.example/hook?key=abc#frag",
        "http://10.0.0.5:8080/internal/path",
        "not a url at all",
    ],
)
def test_loggable_form_never_carries_path_query_or_userinfo(url):
    out = webhook_service._loggable_url(url)
    for part in ("/hook", "key=abc", "pass", "/internal", "frag"):
        assert part not in out


def test_a_blocked_delivery_logs_the_host_and_not_the_token(monkeypatch, caplog):
    hook = SimpleNamespace(id=42, url=ZAPIER, secret="s", events=["lead.created"], bot_id=1)
    session = MagicMock()
    session.execute.return_value.scalar_one_or_none.return_value = hook

    @contextmanager
    def _cm():
        yield session

    monkeypatch.setattr(webhook_service, "get_session", _cm)
    monkeypatch.setattr(webhook_service, "_is_safe_webhook_url", lambda url: False)

    with caplog.at_level(logging.DEBUG, logger=webhook_service.logger.name):
        webhook_service._deliver_webhook(42, "lead.created", {"k": "v"})

    joined = "\n".join(r.getMessage() for r in caplog.records)
    assert "hooks.zapier.com" in joined
    assert SECRET_PATH not in joined
    assert "abcdefTOKENxyz" not in joined
