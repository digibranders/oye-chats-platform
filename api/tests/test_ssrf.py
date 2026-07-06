"""Unit tests for the shared SSRF guard (audit F07/F11/F24/F25).

``app.core.ssrf.validate_public_url`` is the single chokepoint every
server-side fetch (crawler sitemap discovery, iframe preview HEAD, webhook
delivery) must pass a URL through before connecting. It rejects non-http(s)
schemes and any host that resolves to a non-public address (loopback, private,
link-local cloud-metadata, reserved, multicast).
"""

import pytest

from app.core.ssrf import SSRFError, ip_is_public, validate_public_url


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
