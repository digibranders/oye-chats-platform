"""Regression tests for the widget rate-limit key (roadmap §0.3).

``key_from_bot_key`` must bucket by ``<bot-key>:<client-ip>``, not by the public
bot key alone. Otherwise one copied key monopolises a bot's shared limit and
starves every other visitor (and helps drain the owner's credits). These are
pure-function tests: a lightweight fake Request carries headers + client host.
"""

from types import SimpleNamespace

from app.core.rate_limit import key_from_bot_key


def _request(headers: dict, client_host: str | None = "203.0.113.7"):
    # SlowAPI's get_remote_address reads request.client.host (or falls back to
    # the X-Forwarded-For header when present).
    client = SimpleNamespace(host=client_host) if client_host is not None else None
    return SimpleNamespace(headers={k.lower(): v for k, v in headers.items()}, client=client)


def test_key_combines_bot_key_and_ip():
    key = key_from_bot_key(_request({"x-bot-key": "bot-abc"}, client_host="203.0.113.7"))
    assert key == "bot-abc:203.0.113.7"


def test_same_bot_key_different_ips_get_separate_buckets():
    a = key_from_bot_key(_request({"x-bot-key": "bot-abc"}, client_host="203.0.113.7"))
    b = key_from_bot_key(_request({"x-bot-key": "bot-abc"}, client_host="198.51.100.9"))
    assert a != b, "distinct source IPs must not share a rate-limit bucket"


def test_falls_back_to_ip_when_bot_key_absent():
    key = key_from_bot_key(_request({}, client_host="203.0.113.7"))
    assert key == "203.0.113.7"
