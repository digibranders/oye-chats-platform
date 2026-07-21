"""SSRF DNS-rebinding regression test for the ``check_urls_alive`` liveness
probe (AR-42-style TOCTOU).

Before this fix, ``check_urls_alive`` (recrawl-diff liveness check) opened a
*raw* ``aiohttp.ClientSession`` and issued ``session.head()``/``session.get()``
directly: ``validate_public_url`` resolved DNS once to check the host was
public, then aiohttp's own connector performed a *second*, independent DNS
resolution when actually connecting. An attacker-controlled DNS server can
answer differently between those two lookups — a public IP the moment
``validate_public_url`` asks, then a private/cloud-metadata address
(127.0.0.1, 169.254.169.254) microseconds later when aiohttp connects — and
reach an internal address despite the URL having "passed" validation.

``app.core.ssrf.probe_url_alive`` closes this window the same way
``fetch_text_safely`` already does: it resolves once, pins the actual
connection to that single validated IP via ``_PinnedResolver``, and never
lets aiohttp re-resolve the hostname at connect time. ``check_urls_alive``
now calls this helper instead of issuing raw session requests.
"""

import socket

import pytest

from app.core.ssrf import probe_url_alive
from app.services.url_discovery import check_urls_alive


class _FakeSession:
    """Stand-in for the outer ``aiohttp.ClientSession`` — ``probe_url_alive``
    only reads ``.headers``/``.timeout`` off it (to build the short-lived
    pinned inner session), exactly like ``fetch_text_safely`` does."""

    headers = {"User-Agent": "test"}
    timeout = None


@pytest.mark.asyncio
class TestProbeUrlAliveBlocksRebinding:
    async def test_blocks_when_dns_answers_public_then_private(self, monkeypatch):
        """Most literal simulation of the attack: the hostname resolves to a
        PUBLIC address the first time DNS is asked (validation lookup) and a
        PRIVATE/cloud-metadata address the second time (what a raw
        validate-then-connect implementation would then connect to). The
        pinned probe must never open a connection — it must come back
        not-alive instead.
        """
        answers = iter(
            [
                [(socket.AF_INET, None, None, "", ("93.184.216.34", 0))],  # validation-time: public
                [(socket.AF_INET, None, None, "", ("169.254.169.254", 0))],  # "connect-time": private
            ]
        )

        def _fake_getaddrinfo(*_args, **_kwargs):
            return next(answers)

        monkeypatch.setattr("app.core.ssrf.socket.getaddrinfo", _fake_getaddrinfo)

        def _boom(*_args, **_kwargs):
            raise AssertionError("must not open a real connection to a rebound host")

        monkeypatch.setattr("aiohttp.ClientSession.__init__", _boom)

        alive = await probe_url_alive(_FakeSession(), "http://rebinding-attack.test/")

        assert alive is False

    async def test_blocks_when_pinning_step_fails_closed(self, monkeypatch):
        """Even when the initial validation lookup is satisfied, the
        independent pinning re-resolution failing closed (its own
        public-address check, matching ``_resolve_pinned_public_ip``'s real
        behavior) must still block the probe outright rather than falling
        back to an unvalidated/raw connection."""
        monkeypatch.setattr("app.core.ssrf.validate_public_url", lambda u: u)
        monkeypatch.setattr("app.core.ssrf._resolve_pinned_public_ip", lambda host: None)

        def _boom(*_args, **_kwargs):
            raise AssertionError("must not open a real connection when pinning fails closed")

        monkeypatch.setattr("aiohttp.ClientSession.__init__", _boom)

        alive = await probe_url_alive(_FakeSession(), "http://rebinding-attempt.test/")

        assert alive is False

    async def test_check_urls_alive_reports_rebinding_target_as_not_alive(self, monkeypatch):
        """End-to-end through the public ``check_urls_alive`` entry point
        used by the recrawl-diff endpoint — a URL whose validation-time and
        connect-time DNS answers disagree (public → private) must come back
        ``False``, not silently probed against the private address.

        (No canary patch on ``aiohttp.ClientSession.__init__`` here —
        ``check_urls_alive`` legitimately constructs one outer session to
        carry headers/timeout config; the no-real-connection guarantee for
        the *pinned* inner session is asserted directly against
        ``probe_url_alive`` above.)
        """
        answers = iter(
            [
                [(socket.AF_INET, None, None, "", ("93.184.216.34", 0))],
                [(socket.AF_INET, None, None, "", ("169.254.169.254", 0))],
            ]
        )

        def _fake_getaddrinfo(*_args, **_kwargs):
            return next(answers)

        monkeypatch.setattr("app.core.ssrf.socket.getaddrinfo", _fake_getaddrinfo)

        results = await check_urls_alive(["http://rebinding-attack.test/"])

        assert results == {"http://rebinding-attack.test/": False}


@pytest.mark.asyncio
class TestProbeUrlAliveHappyPath:
    async def test_normal_public_url_probes_alive_through_pinned_connection(self, monkeypatch):
        """A normal URL that resolves consistently and answers 200 to HEAD
        must probe alive — end-to-end through the real pinned
        TCPConnector/resolver wiring against a local aiohttp test server
        (bypassing the public-IP requirement purely because the test server
        is on loopback; public-vs-private classification itself is covered
        by ``tests/test_ssrf.py``)."""
        from aiohttp import web
        from aiohttp.test_utils import TestServer

        async def handler(request):
            return web.Response(text="ok")

        app = web.Application()
        app.router.add_get("/", handler)
        server = TestServer(app)
        await server.start_server()
        try:
            monkeypatch.setattr("app.core.ssrf.validate_public_url", lambda u: u)
            monkeypatch.setattr("app.core.ssrf._resolve_pinned_public_ip", lambda host: server.host)

            import aiohttp

            async with aiohttp.ClientSession() as session:
                alive = await probe_url_alive(session, f"http://pinned-fake-host.test:{server.port}/")

            assert alive is True
        finally:
            await server.close()

    async def test_gone_url_probes_not_alive(self, monkeypatch):
        """404/410 responses are a confirmed-gone signal, not just "unreachable" —
        the pinned probe must preserve this distinction from the pre-fix
        liveness policy."""
        from aiohttp import web
        from aiohttp.test_utils import TestServer

        async def handler(request):
            return web.Response(status=404)

        app = web.Application()
        app.router.add_get("/", handler)
        server = TestServer(app)
        await server.start_server()
        try:
            monkeypatch.setattr("app.core.ssrf.validate_public_url", lambda u: u)
            monkeypatch.setattr("app.core.ssrf._resolve_pinned_public_ip", lambda host: server.host)

            import aiohttp

            async with aiohttp.ClientSession() as session:
                alive = await probe_url_alive(session, f"http://pinned-fake-host.test:{server.port}/")

            assert alive is False
        finally:
            await server.close()
