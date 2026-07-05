"""Regression tests for the FORWARDED_ALLOW_IPS production guard (roadmap §0.3).

The per-IP rate-limit key is only non-spoofable because uvicorn trusts
X-Forwarded-For solely from nginx on loopback. gunicorn.conf.py must refuse an
open FORWARDED_ALLOW_IPS (``*`` / ``0.0.0.0``) in production so the anti-drain
protection can't be silently defeated by a misconfigured deploy.
"""

import os
import runpy

import pytest

_CONF = os.path.join(os.path.dirname(__file__), "..", "gunicorn.conf.py")


def test_open_forwarded_allow_ips_rejected_in_production(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("FORWARDED_ALLOW_IPS", "*")
    with pytest.raises(RuntimeError, match="FORWARDED_ALLOW_IPS"):
        runpy.run_path(_CONF)


def test_zero_host_rejected_in_production(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("FORWARDED_ALLOW_IPS", "127.0.0.1,0.0.0.0")
    with pytest.raises(RuntimeError, match="FORWARDED_ALLOW_IPS"):
        runpy.run_path(_CONF)


def test_loopback_allowed_in_production(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("FORWARDED_ALLOW_IPS", "127.0.0.1")
    runpy.run_path(_CONF)  # must not raise


def test_open_allowed_in_development(monkeypatch):
    # The guard only bites in production; local dev may run without nginx.
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("FORWARDED_ALLOW_IPS", "*")
    runpy.run_path(_CONF)  # must not raise
