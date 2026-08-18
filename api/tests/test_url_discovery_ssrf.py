"""SSRF guard on the crawl liveness/link-discovery fetches (code-review RV3/RV4).

`check_urls_alive` (recrawl-diff) and `discover_via_links` fetch caller/stored
URLs server-side. They must refuse non-public targets and must not blindly
follow a redirect to an internal address, the same guard the sitemap path got.
"""

import asyncio

from app.services.url_discovery import check_urls_alive


def test_check_urls_alive_rejects_internal_targets_without_probing():
    urls = [
        "http://127.0.0.1/status",  # loopback
        "http://169.254.169.254/latest/meta-data/",  # cloud metadata
        "http://10.1.2.3/internal",  # private
    ]
    results = asyncio.run(check_urls_alive(urls))
    for u in urls:
        assert results[u] is False, f"{u} must be rejected, not reported alive"
