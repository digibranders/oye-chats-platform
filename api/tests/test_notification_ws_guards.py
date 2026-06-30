"""Hardening for the /ws/notifications dashboard channel (PR #209 review #5).

Two guards:
* an Origin allowlist (parity with the dashboard CORS policy), so a foreign
  page can't open the socket even with a leaked key, and
* a per-workspace connection cap, so a buggy/malicious client can't exhaust
  fan-out memory by opening unbounded sockets.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock


def test_broadcaster_caps_connections_per_client():
    from app.services.notification_broadcaster import _MAX_CONNECTIONS_PER_CLIENT, NotificationBroadcaster

    b = NotificationBroadcaster()

    async def _run():
        accepted = 0
        for _ in range(_MAX_CONNECTIONS_PER_CLIENT + 5):
            if await b.connect(1, MagicMock()):
                accepted += 1
        return accepted

    accepted = asyncio.run(_run())
    assert accepted == _MAX_CONNECTIONS_PER_CLIENT
    assert b.connection_count(1) == _MAX_CONNECTIONS_PER_CLIENT


def test_disconnect_frees_a_slot():
    from app.services.notification_broadcaster import _MAX_CONNECTIONS_PER_CLIENT, NotificationBroadcaster

    b = NotificationBroadcaster()

    async def _run():
        socks = [MagicMock() for _ in range(_MAX_CONNECTIONS_PER_CLIENT)]
        for ws in socks:
            assert await b.connect(2, ws)
        assert await b.connect(2, MagicMock()) is False  # at cap
        await b.disconnect(2, socks[0])
        return await b.connect(2, MagicMock())  # slot freed

    assert asyncio.run(_run()) is True


def test_dashboard_origin_enforced_when_cors_configured(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("CORS_ORIGINS", "https://app.oyechats.com")
    from app.api import notification_routes as nr

    assert nr._dashboard_origin_allowed("https://app.oyechats.com") is True
    assert nr._dashboard_origin_allowed("https://evil.example") is False
    # A browser always sends Origin; a missing one (non-browser) is rejected in prod.
    assert nr._dashboard_origin_allowed(None) is False


def test_dashboard_origin_not_enforced_without_cors(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    from app.api import notification_routes as nr

    # No CORS configured → don't enforce (parity with the HTTP CORS policy).
    assert nr._dashboard_origin_allowed("https://anything.example") is True
