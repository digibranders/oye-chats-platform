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


class CrawlRequest(BaseModel):
    url: str
    max_pages: int | None = Field(default=None, ge=1, le=100)
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
