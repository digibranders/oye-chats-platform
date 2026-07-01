import ipaddress
import socket
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator


class ClientSettingsUpdate(BaseModel):
    bot_name: str | None = None
    bot_logo: str | None = None
    launcher_name: str | None = None
    launcher_logo: str | None = None
    primary_color: str | None = None
    background_color: str | None = None
    header_color: str | None = None


def _is_public_hostname(hostname: str) -> bool:
    """Return True only if *hostname* resolves exclusively to public (non-internal) IPs."""
    try:
        infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        # DNS resolution failed — reject to be safe
        return False

    if not infos:
        return False

    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local:
            return False
    return True


class DocumentPageItem(BaseModel):
    url: str
    title: str | None
    chunk_count: int
    ingested_at: str | None


class DocumentPagesResponse(BaseModel):
    domain: str
    total_pages: int
    total_chunks: int
    pages: list[DocumentPageItem]


class CrawlDiscoverRequest(BaseModel):
    """Request body for POST /crawl/discover — URL-only pre-crawl page count."""

    url: str

    @field_validator("url")
    @classmethod
    def validate_url(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("URL must not be empty")
        if not v.startswith(("http://", "https://")):
            raise ValueError("URL must start with http:// or https://")
        parsed = urlparse(v)
        hostname = parsed.hostname
        if not hostname:
            raise ValueError("URL must contain a valid hostname")
        try:
            ip = ipaddress.ip_address(hostname)
            if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local:
                raise ValueError("Crawling internal or private network addresses is not allowed")
        except ValueError as exc:
            if "not allowed" in str(exc):
                raise
            if not _is_public_hostname(hostname):
                raise ValueError("URL resolves to a private/internal address and cannot be crawled") from None
        return v


class CrawlDiffRequest(CrawlDiscoverRequest):
    """Request body for POST /crawl/diff — diff a recrawl against existing pages."""

    replace_source: str = Field(
        ...,
        min_length=1,
        description="Root domain whose existing pages should be diffed against the live sitemap (e.g. 'oyechats.com').",
    )


class CrawlRequest(BaseModel):
    url: str
    # Upper bound is enforced by the route layer against the caller's plan
    # tier (free 75 / starter 300 / standard 750 / enterprise 5000) — the
    # schema only keeps the absolute floor so a malicious zero or negative
    # value is rejected at parse time. ``le`` is intentionally absent so an
    # Enterprise customer can request 5000 without a 422.
    max_pages: int | None = Field(default=None, ge=1)
    use_js: bool = Field(
        default=False,
        description="Enable JavaScript (browser) mode for all pages. Required for Next.js, React, and other SPA sites.",
    )
    replace_source: str | None = Field(
        default=None,
        description="Root domain to atomically replace after a successful crawl (e.g. 'fynix.digital'). "
        "Old chunks for this source are deleted only after new ingestion succeeds — "
        "so the bot always has knowledge during the recrawl.",
    )
    expected_new_pages: int | None = Field(
        default=None,
        ge=0,
        description="Optional client-supplied page count from a prior /crawl/diff call, used "
        "to right-size the credit pre-flight on a recrawl (only honored when "
        "``replace_source`` is set). Per-page atomic deduction inside the ingestion "
        "pipeline remains authoritative — this only loosens the upfront ceiling so a "
        "9-new-page recrawl isn't blocked by a 1200-page worst-case reservation.",
    )
    ordered_urls: list[str] | None = Field(
        default=None,
        description="Explicit, pre-ordered list of URLs to crawl (from a prior "
        "/crawl/discover, sorted client-side by the user's chosen order and truncated "
        "to the affordable count). When set, the recursive crawl is skipped and exactly "
        "these URLs are fetched in order. Validated same-origin and capped server-side.",
    )

    @field_validator("url")
    @classmethod
    def validate_url(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("URL must not be empty")
        if not v.startswith(("http://", "https://")):
            raise ValueError("URL must start with http:// or https://")

        parsed = urlparse(v)
        hostname = parsed.hostname
        if not hostname:
            raise ValueError("URL must contain a valid hostname")

        # Block SSRF: reject internal / private / reserved IP ranges
        # (e.g. 127.0.0.1, 10.x, 172.16-31.x, 192.168.x, 169.254.169.254 cloud metadata)
        try:
            ip = ipaddress.ip_address(hostname)
            if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local:
                raise ValueError("Crawling internal or private network addresses is not allowed")
        except ValueError as exc:
            if "not allowed" in str(exc):
                raise
            # hostname is not a literal IP — resolve DNS and verify all results are public
            if not _is_public_hostname(hostname):
                raise ValueError("URL resolves to a private/internal address and cannot be crawled") from None

        return v
