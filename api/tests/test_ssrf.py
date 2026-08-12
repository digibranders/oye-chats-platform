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


# ── TLS verification on the pinned fetches ──────────────────────────────────
#
# Every fetch in this module used to pass `ssl=False`, so an https:// URL was
# retrieved with no certificate check at all. Pinning the resolved IP never
# required that — `_PinnedResolver` reports the real hostname, so SNI and
# hostname verification still work against the name in the URL. Pinning decides
# WHERE we connect; TLS decides WHETHER the thing that answered is who the URL
# said it would be. Without the second one, an on-path attacker substitutes the
# sitemap that decides which pages get ingested, or the icon that becomes the
# agent's avatar, and we serve it back to the customer as their own content.


def _self_signed(hostname: str, tmp_path):
    """A certificate for ``hostname``, signed by nobody the system trusts.

    Stands in for the real-world cases that make this worth a kill switch: an
    expired certificate, or one issued for a different name.
    """
    import datetime

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, hostname)])
    # Fixed window around a fixed instant: the test must not depend on the
    # wall clock beyond "this cert is not the problem, the signer is".
    not_before = datetime.datetime(2020, 1, 1, tzinfo=datetime.UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(not_before)
        .not_valid_after(not_before + datetime.timedelta(days=36500))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName(hostname)]), critical=False)
        .sign(key, hashes.SHA256())
    )
    cert_path = tmp_path / "cert.pem"
    key_path = tmp_path / "key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    return cert_path, key_path


class TestTlsVerificationOnPinnedFetches:
    HOST = "pinned-tls-host.test"

    async def _serve_https(self, tmp_path):
        import ssl as ssl_mod

        from aiohttp import web
        from aiohttp.test_utils import TestServer

        async def handler(request):
            return web.Response(text="secret content")

        cert_path, key_path = _self_signed(self.HOST, tmp_path)
        ctx = ssl_mod.SSLContext(ssl_mod.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(cert_path), str(key_path))

        app = web.Application()
        app.router.add_get("/", handler)
        server = TestServer(app)
        # `ssl` is consumed by start_server, not by the constructor — passing
        # it to TestServer(...) silently yields a PLAIN HTTP server, and then
        # every assertion below passes for the wrong reason.
        await server.start_server(ssl=ctx)
        return server

    @pytest.mark.asyncio
    async def test_an_untrusted_certificate_is_refused(self, monkeypatch, tmp_path):
        import aiohttp

        server = await self._serve_https(tmp_path)
        try:
            monkeypatch.setattr("app.core.ssrf.validate_public_url", lambda u: u)
            monkeypatch.setattr("app.core.ssrf._resolve_pinned_public_ip", lambda host: server.host)
            monkeypatch.setattr("app.core.ssrf.SSRF_TLS_VERIFY_ENABLED", True)

            async with aiohttp.ClientSession() as session:
                result = await fetch_text_safely(session, f"https://{self.HOST}:{server.port}/")

            assert result is None, "an unverifiable certificate must not yield content"
        finally:
            await server.close()

    @pytest.mark.asyncio
    async def test_the_body_is_reachable_once_verification_is_switched_off(self, monkeypatch, tmp_path):
        """Proves the previous test failed on the CERTIFICATE and not on the
        harness — same server, same pinning, only the flag differs. Also pins
        the kill switch itself: it has to actually restore service, or it is
        not the stopgap it is documented as."""
        import aiohttp

        server = await self._serve_https(tmp_path)
        try:
            monkeypatch.setattr("app.core.ssrf.validate_public_url", lambda u: u)
            monkeypatch.setattr("app.core.ssrf._resolve_pinned_public_ip", lambda host: server.host)
            monkeypatch.setattr("app.core.ssrf.SSRF_TLS_VERIFY_ENABLED", False)

            async with aiohttp.ClientSession() as session:
                result = await fetch_text_safely(session, f"https://{self.HOST}:{server.port}/")

            assert result == (200, "secret content")
        finally:
            await server.close()

    @pytest.mark.asyncio
    async def test_the_icon_fetch_is_verified_too_not_just_the_page_fetch(self, monkeypatch, tmp_path):
        """`fetch_bytes_safely` is a separate code path with its own connector,
        and it is the one that pulls the image used as the agent's avatar."""
        import aiohttp

        from app.core.ssrf import fetch_bytes_safely

        server = await self._serve_https(tmp_path)
        try:
            monkeypatch.setattr("app.core.ssrf.validate_public_url", lambda u: u)
            monkeypatch.setattr("app.core.ssrf._resolve_pinned_public_ip", lambda host: server.host)
            monkeypatch.setattr("app.core.ssrf.SSRF_TLS_VERIFY_ENABLED", True)

            async with aiohttp.ClientSession() as session:
                result = await fetch_bytes_safely(session, f"https://{self.HOST}:{server.port}/", max_bytes=1024)

            assert result is None
        finally:
            await server.close()

    @pytest.mark.asyncio
    async def test_a_rejected_certificate_is_logged_by_host(self, monkeypatch, tmp_path, caplog):
        """The failure is otherwise indistinguishable from a timeout, and
        identifying the affected host is the whole diagnosis before anyone
        reaches for the kill switch."""
        import logging

        import aiohttp

        server = await self._serve_https(tmp_path)
        try:
            monkeypatch.setattr("app.core.ssrf.validate_public_url", lambda u: u)
            monkeypatch.setattr("app.core.ssrf._resolve_pinned_public_ip", lambda host: server.host)
            monkeypatch.setattr("app.core.ssrf.SSRF_TLS_VERIFY_ENABLED", True)

            with caplog.at_level(logging.WARNING, logger="app.core.ssrf"):
                async with aiohttp.ClientSession() as session:
                    await fetch_text_safely(session, f"https://{self.HOST}:{server.port}/")

            messages = [r.getMessage() for r in caplog.records]
            assert any("TLS verification failed" in m for m in messages), messages
            assert any(self.HOST in m for m in messages), messages
        finally:
            await server.close()

    def test_the_verifying_context_actually_verifies(self):
        """`create_default_context` is only the right choice if it is checking
        both the chain and the hostname — a context with either turned off
        would satisfy every test above that asserts a refusal, for the wrong
        reason."""
        import ssl as ssl_mod

        from app.core import ssrf as ssrf_mod

        ctx = ssrf_mod._VERIFYING_SSL_CONTEXT
        assert ctx.verify_mode == ssl_mod.CERT_REQUIRED
        assert ctx.check_hostname is True

    @pytest.mark.asyncio
    async def test_a_tls_failure_never_confirms_a_url_as_dead(self, monkeypatch, tmp_path):
        """`probe_url_alive` feeds the orphan sweep, which DELETES a
        customer's ingested pages for URLs it reports gone. Turning
        verification on must not turn a certificate problem into data loss:
        only a confirmed 404/410 means gone, and everything else — including a
        refused certificate — stays conservatively alive."""
        import aiohttp

        from app.core.ssrf import probe_url_alive

        server = await self._serve_https(tmp_path)
        try:
            monkeypatch.setattr("app.core.ssrf.validate_public_url", lambda u: u)
            monkeypatch.setattr("app.core.ssrf._resolve_pinned_public_ip", lambda host: server.host)
            monkeypatch.setattr("app.core.ssrf.SSRF_TLS_VERIFY_ENABLED", True)

            async with aiohttp.ClientSession() as session:
                alive = await probe_url_alive(session, f"https://{self.HOST}:{server.port}/")

            assert alive is True
        finally:
            await server.close()
