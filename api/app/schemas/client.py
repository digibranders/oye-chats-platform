import ipaddress
import socket
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator

from app.schemas.validators import MAX_URL, HexColor, Name


class ClientSettingsUpdate(BaseModel):
    """Legacy client-scoped widget settings (``PATCH /client/settings``).

    Superseded by the bot-scoped ``PATCH /bots/{id}`` for workspaces that have
    a bot, but still reachable, so it is held to the same constraints.
    Otherwise it is simply the unvalidated way in to the same columns.
    """

    bot_name: Name | None = None
    bot_logo: str | None = Field(default=None, max_length=MAX_URL)
    launcher_name: Name | None = None
    launcher_logo: str | None = Field(default=None, max_length=MAX_URL)
    primary_color: HexColor | None = None
    background_color: HexColor | None = None
    header_color: HexColor | None = None


def _is_public_hostname(hostname: str) -> bool:
    """Return True only if *hostname* resolves exclusively to public (non-internal) IPs."""
    try:
        infos = socket.getaddrinfo(hostname, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        # DNS resolution failed. Reject to be safe
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
    """Request body for POST /crawl/discover. URL-only pre-crawl page count."""

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
    """Request body for POST /crawl/diff. Diff a recrawl against existing pages."""

    replace_source: str = Field(
        ...,
        min_length=1,
        description="Root domain whose existing pages should be diffed against the live sitemap (e.g. 'oyechats.com').",
    )
    mode: str = Field(
        default="delta",
        description="Recrawl preview mode. ``full`` shows the totals for a re-scrape "
        "of every URL (charged per page regardless of content change). ``delta`` "
        "shows the URL-level diff and defers content-change detection to the "
        "ingestion pipeline's SHA-256 dedup. Only new or changed pages are billed. "
        "``delta`` is gated to Standard+; Free/Starter callers get 403.",
    )

    @field_validator("mode")
    @classmethod
    def validate_mode(cls, v: str) -> str:
        v = (v or "delta").strip().lower()
        if v not in {"full", "delta"}:
            raise ValueError("mode must be 'full' or 'delta'")
        return v


class CrawlRequest(BaseModel):
    url: str
    # Upper bound is enforced by the route layer against the caller's plan tier
    # , the authoritative per-tier ceilings live in the plan config (DB) and are
    # resolved via ``plan_service.get_crawl_limits`` in the crawl route, not
    # hard-coded here (paid tiers use a credit-derived budget rather than a fixed
    # page cap). This schema keeps only the absolute floor so a malicious zero or
    # negative value is rejected at parse time. ``le`` is intentionally absent so
    # a high-tier caller can request a large page count without a 422.
    max_pages: int | None = Field(default=None, ge=1)
    use_js: bool = Field(
        default=False,
        description="Enable JavaScript (browser) mode for all pages. Required for Next.js, React, and other SPA sites.",
    )
    replace_source: str | None = Field(
        default=None,
        description="Root domain to atomically replace after a successful crawl (e.g. 'fynix.digital'). "
        "Old chunks for this source are deleted only after new ingestion succeeds. "
        "so the bot always has knowledge during the recrawl.",
    )
    expected_new_pages: int | None = Field(
        default=None,
        ge=0,
        description="Optional client-supplied page count from a prior /crawl/diff call, used "
        "to right-size the credit pre-flight on a recrawl (only honored when "
        "``replace_source`` is set). Per-page atomic deduction inside the ingestion "
        "pipeline remains authoritative. This only loosens the upfront ceiling so a "
        "9-new-page recrawl isn't blocked by a 1200-page worst-case reservation.",
    )
    discovered_pages: int | None = Field(
        default=None,
        ge=0,
        description="Optional client-supplied sitemap page count from a prior "
        "/crawl/discover call. Used to right-size the credit pre-flight on an "
        "INITIAL crawl (honored only when ``replace_source`` is NOT set) so a small "
        "site isn't gated at the plan's full max-pages ceiling. E.g. a 13-page site "
        "reserves 13×cost, not plan_max×cost. Per-page atomic deduction inside the "
        "ingestion pipeline stays authoritative. This only tightens the upfront "
        "reservation to the discovered count.",
    )
    ordered_urls: list[str] | None = Field(
        default=None,
        description="Explicit, pre-ordered list of URLs to crawl (from a prior "
        "/crawl/discover, sorted client-side by the user's chosen order and truncated "
        "to the affordable count). When set, the recursive crawl is skipped and exactly "
        "these URLs are fetched in order. Validated same-origin and capped server-side.",
    )
    mode: str = Field(
        default="delta",
        description="Recrawl mode. ``full`` forces re-embed + charge for every "
        "discovered URL (Free/Starter's only option), the ingestion pipeline's "
        "SHA-256 dedup is bypassed so unchanged pages still bill. ``delta`` uses "
        "the existing dedup so only new or content-changed pages bill. ``delta`` "
        "is gated to Standard+; Free/Starter callers get 403. First-time crawls "
        "(no ``replace_source``) always run as full, the mode field is ignored.",
    )

    @field_validator("mode")
    @classmethod
    def validate_mode(cls, v: str) -> str:
        v = (v or "delta").strip().lower()
        if v not in {"full", "delta"}:
            raise ValueError("mode must be 'full' or 'delta'")
        return v

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
            # hostname is not a literal IP. Resolve DNS and verify all results are public
            if not _is_public_hostname(hostname):
                raise ValueError("URL resolves to a private/internal address and cannot be crawled") from None

        return v
