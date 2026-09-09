"""A probe that cannot reach the origin is not the same as a live page.

`probe_url_alive` returned True for "confirmed 200" and for "the origin never
answered" alike, and it never raises. So the recrawl-diff endpoint could probe
400 URLs, fail on every one of them, and report 400 pages alive with
``head_partial`` false: a confident, wrong answer, and the reason a knowledge
base accumulates dead pages without anyone noticing.

The probe is tri-state now. Callers that DELETE still collapse "unknown" to
alive, because a blip must never remove a customer's page. The endpoint that
reports to a human says how many it could not determine.
"""

from __future__ import annotations

import asyncio

import pytest

from app.core import ssrf
from app.services import url_discovery


class _Resp:
    def __init__(self, status: int) -> None:
        self.status = status

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


class _Session:
    """Stands in for the pinned aiohttp session inside the probe."""

    headers: dict = {}
    timeout = None

    def __init__(self, head, get) -> None:
        self._head, self._get = head, get

    def head(self, *_a, **_k):
        return self._head()

    def get(self, *_a, **_k):
        return self._get()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False


def _pin(monkeypatch, head, get) -> None:
    """The probe imports aiohttp inside the function body, so the patch has to
    land on the real module rather than on an attribute of ``ssrf``."""
    import aiohttp

    monkeypatch.setattr(ssrf, "validate_public_url", lambda _u: None)
    monkeypatch.setattr(ssrf, "_resolve_pinned_public_ip", lambda _h: "93.184.216.34")
    monkeypatch.setattr(aiohttp, "TCPConnector", lambda **_k: None)
    monkeypatch.setattr(aiohttp, "ClientSession", lambda **_k: _Session(head, get))


def _boom():
    raise OSError("origin refused the connection")


class TestTheProbeReportsWhatItActuallyLearned:
    def test_a_200_is_alive(self, monkeypatch):
        _pin(monkeypatch, lambda: _Resp(200), lambda: _Resp(200))
        assert asyncio.run(ssrf.probe_url_liveness(_Session(None, None), "https://x.test/")) == "alive"

    def test_a_404_is_gone(self, monkeypatch):
        _pin(monkeypatch, lambda: _Resp(404), lambda: _Resp(404))
        assert asyncio.run(ssrf.probe_url_liveness(_Session(None, None), "https://x.test/")) == "gone"

    def test_an_origin_that_never_answers_is_unknown(self, monkeypatch):
        _pin(monkeypatch, _boom, _boom)
        assert asyncio.run(ssrf.probe_url_liveness(_Session(None, None), "https://x.test/")) == "unknown"

    def test_a_url_the_ssrf_guard_refuses_is_gone(self, monkeypatch):
        def _reject(_url):
            raise ssrf.SSRFError("private range")

        monkeypatch.setattr(ssrf, "validate_public_url", _reject)
        assert asyncio.run(ssrf.probe_url_liveness(_Session(None, None), "http://169.254.169.254/")) == "gone"


class TestTheDeletingCallersAreUnchanged:
    """The whole point of keeping a bool view: no behaviour change where it
    would cost a customer their content."""

    @pytest.mark.parametrize("state,expected", [("alive", True), ("unknown", True), ("gone", False)])
    def test_probe_url_alive_only_reports_confirmed_gone(self, monkeypatch, state, expected):
        async def _fake(_session, _url):
            return state

        monkeypatch.setattr(ssrf, "probe_url_liveness", _fake)
        assert asyncio.run(ssrf.probe_url_alive(_Session(None, None), "https://x.test/")) is expected

    def test_check_urls_alive_collapses_unknown_to_alive(self, monkeypatch):
        async def _states(urls, **_k):
            return {"https://a.test/": "unknown", "https://b.test/": "gone", "https://c.test/": "alive"}

        monkeypatch.setattr(url_discovery, "check_urls_liveness", _states)
        result = asyncio.run(url_discovery.check_urls_alive(["https://a.test/"]))
        assert result == {"https://a.test/": True, "https://b.test/": False, "https://c.test/": True}
