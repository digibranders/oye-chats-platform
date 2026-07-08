"""Unit tests for the shared SSRF guard (audit F07/F11/F24/F25).

``app.core.ssrf.validate_public_url`` is the single chokepoint every
server-side fetch (crawler sitemap discovery, iframe preview HEAD, webhook
delivery) must pass a URL through before connecting. It rejects non-http(s)
schemes and any host that resolves to a non-public address (loopback, private,
link-local cloud-metadata, reserved, multicast).
"""

import socket

import pytest

from app.core.ssrf import (
    SSRFError,
    _PinnedResolver,
    _resolve_pinned_public_ip,
    fetch_text_safely,
    ip_is_public,
    validate_public_url,
)


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",  # AWS/GCP link-local metadata
        "http://127.0.0.1/",  # loopback literal
        "https://localhost/admin",  # resolves to loopback
        "http://10.0.0.5/internal",  # private A
        "http://192.168.1.1/",  # private C
        "http://172.16.0.1/",  # private B
        "http://[::1]/",  # IPv6 loopback literal
        "http://0.0.0.0/",  # unspecified
        "file:///etc/passwd",  # non-http scheme
        "ftp://example.com/",  # non-http scheme
        "http:///nohost",  # missing host
    ],
)
def test_validate_public_url_rejects_internal_and_bad_scheme(url):
    with pytest.raises(SSRFError):
        validate_public_url(url)


@pytest.mark.parametrize(
    "url",
    [
        "http://8.8.8.8/",  # public IP literal
        "https://93.184.216.34/page",  # public IP literal (no DNS needed)
    ],
)
def test_validate_public_url_allows_public_ip_literals(url):
    assert validate_public_url(url) == url


def test_ip_is_public_classification():
    import ipaddress

    assert ip_is_public(ipaddress.ip_address("8.8.8.8")) is True
    assert ip_is_public(ipaddress.ip_address("127.0.0.1")) is False
    assert ip_is_public(ipaddress.ip_address("169.254.169.254")) is False
    assert ip_is_public(ipaddress.ip_address("10.1.2.3")) is False
    assert ip_is_public(ipaddress.ip_address("::1")) is False


# ── DNS-rebinding TOCTOU fix (AR-42) ─────────────────────────────────────────


class TestResolvePinnedPublicIp:
    def test_returns_the_resolved_public_ip(self, monkeypatch):
        monkeypatch.setattr(
            "app.core.ssrf.socket.getaddrinfo",
            lambda *a, **k: [(socket.AF_INET, None, None, "", ("93.184.216.34", 0))],
        )
        assert _resolve_pinned_public_ip("example.test") == "93.184.216.34"

    def test_fails_closed_when_any_resolved_address_is_private(self, monkeypatch):
        """This is the exact rebinding scenario: a hostname that resolves to
        BOTH a public and a private address must be rejected entirely, not
        silently pinned to the public one — a DNS response ordering quirk
        or a genuinely multi-homed rebinding attacker could put the private
        address anywhere in the list."""
        monkeypatch.setattr(
            "app.core.ssrf.socket.getaddrinfo",
            lambda *a, **k: [
                (socket.AF_INET, None, None, "", ("93.184.216.34", 0)),
                (socket.AF_INET, None, None, "", ("169.254.169.254", 0)),
            ],
        )
        assert _resolve_pinned_public_ip("evil.test") is None

    def test_returns_none_on_dns_resolution_failure(self, monkeypatch):
        def _raise(*a, **k):
            raise socket.gaierror("name resolution failed")

        monkeypatch.setattr("app.core.ssrf.socket.getaddrinfo", _raise)
        assert _resolve_pinned_public_ip("nowhere.test") is None


class TestPinnedResolver:
    @pytest.mark.asyncio
    async def test_resolve_returns_the_pinned_ip_for_the_pinned_host(self):
        resolver = _PinnedResolver({"example.test": "93.184.216.34"})
        result = await resolver.resolve("example.test", port=443)

        assert result == [
            {
                "hostname": "example.test",
                "host": "93.184.216.34",
                "port": 443,
                "family": socket.AF_INET,
                "proto": 0,
                "flags": 0,
            }
        ]

    @pytest.mark.asyncio
    async def test_resolve_raises_for_a_host_it_was_not_pinned_for(self):
        """Fail closed: asking this resolver to resolve a hostname it wasn't
        constructed for must never fall through to a real DNS lookup."""
        resolver = _PinnedResolver({"example.test": "93.184.216.34"})
        with pytest.raises(OSError):
            await resolver.resolve("other-host.test")


class TestFetchTextSafelyUsesPinnedConnection:
    @pytest.mark.asyncio
    async def test_end_to_end_fetch_through_pinned_resolver(self, monkeypatch):
        """Real local aiohttp server + real TCPConnector/resolver wiring —
        not just unit-testing the pieces in isolation. Bypasses the
        public-IP requirement (the test server is on loopback) purely to
        exercise the CONNECTION mechanism; validate_public_url's own
        public-vs-private classification is covered separately above."""
        from aiohttp import web
        from aiohttp.test_utils import TestServer

        async def handler(request):
            return web.Response(text="hello from pinned connection", headers={"X-Test": "ok"})

        app = web.Application()
        app.router.add_get("/", handler)
        server = TestServer(app)
        await server.start_server()
        try:
            monkeypatch.setattr("app.core.ssrf.validate_public_url", lambda u: u)
            monkeypatch.setattr("app.core.ssrf._resolve_pinned_public_ip", lambda host: server.host)

            import aiohttp

            async with aiohttp.ClientSession() as session:
                url = f"http://pinned-fake-host.test:{server.port}/"
                result = await fetch_text_safely(session, url)

            assert result == (200, "hello from pinned connection")
        finally:
            await server.close()

    @pytest.mark.asyncio
    async def test_returns_none_when_hostname_does_not_resolve_to_a_public_ip(self, monkeypatch):
        monkeypatch.setattr("app.core.ssrf.validate_public_url", lambda u: u)
        monkeypatch.setattr("app.core.ssrf._resolve_pinned_public_ip", lambda host: None)

        import aiohttp

        async with aiohttp.ClientSession() as session:
            result = await fetch_text_safely(session, "http://rebinding-attempt.test/")

        assert result is None
