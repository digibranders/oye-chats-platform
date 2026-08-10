"""Resolve a registrable domain to a company profile, cache-first.

Reuses machinery that already exists: the Spider→Jina crawl stack, the markup
reader in :mod:`company_markup`, and ``llm_service.extract_company_context``
(the same helper that derives a customer's own company name during
onboarding). No new vendor.

## Contract

``resolve_company`` is best-effort and **never raises**. It runs on a
background thread behind lead capture and must never surface to a visitor, so
every failure path returns ``None`` and records a backoff. ``None`` means "no
company could be identified", not "an error occurred".

## Order of work

1. Cache read. A stored name wins immediately — including over a later failure
   flag, so one transient 503 cannot hide a good profile for a whole backoff
   window.
2. Crawl the domain root.
3. Read the site's own declared markup (schema.org, then ``og:site_name``).
   Free, and more accurate than inference because it is a declaration.
4. Only if the site declares nothing, spend an LLM call.
5. Upsert. Never a read-then-insert: two leads from one company arriving
   together is the normal case, and the loser of that race would raise
   ``IntegrityError`` straight through the "never raises" contract.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, literal_column
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.db.models import CompanyProfile
from app.services.company_markup import extract_from_markup
from app.services.llm_service import extract_company_context

logger = logging.getLogger(__name__)

REFRESH_INTERVAL = timedelta(days=90)
FAILURE_BACKOFF = timedelta(days=1)
# Cap the doubling so a domain is still retried eventually, just rarely.
MAX_FAILURE_BACKOFF = timedelta(days=90)

# Longest plausible company name. Past this the model is narrating, not naming.
_MAX_NAME_LEN = 120
# Phrases that mean the model echoed the instructions instead of answering.
_PROMPT_ECHOES = {"company name", "company_name", "name", "unknown", "n/a", "none", "null"}

_OG_IMAGE_RE = re.compile(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)', re.IGNORECASE)


def _fetch_site_html(domain: str) -> str | None:
    """Fetch the domain's root page. Spider first, Jina as fallback.

    Isolated as its own function so tests patch one seam instead of two async
    HTTP clients.
    """
    from app.services import jina_service, spider_service

    url = f"https://{domain}"
    try:
        html = asyncio.run(spider_service.fetch_html(url))
        if html:
            return html
    except Exception:
        logger.debug("spider fetch failed for %s", domain, exc_info=True)

    try:
        result = asyncio.run(jina_service.fetch_urls([url]))
        pages = result.get("results") or []
        if pages:
            return pages[0].get("content")
    except Exception:
        logger.debug("jina fetch failed for %s", domain, exc_info=True)

    return None


def _valid_name(name: object) -> bool:
    if not isinstance(name, str):
        return False
    cleaned = name.strip()
    if not cleaned or len(cleaned) > _MAX_NAME_LEN:
        return False
    return cleaned.lower() not in _PROMPT_ECHOES


def _logo_from_markup(html: str, domain: str) -> str | None:
    """Recover an og:image when the LLM path was used.

    A page can carry a logo even when it declares no identity, so the logo
    should not be lost just because the name needed a model.
    """
    match = _OG_IMAGE_RE.search(html)
    if not match:
        return None
    url = match.group(1).strip()
    if len(url) > 500:
        return None
    if url.startswith("//"):
        return f"https:{url}"
    if url.startswith("/"):
        return f"https://{domain}{url}"
    return url if url.startswith(("http://", "https://")) else None


def _record_failure(session: Session, domain: str) -> None:
    """Mark a domain unresolvable, with backoff that GROWS per attempt.

    Upsert, not read-then-insert — see the module docstring. Flat backoff would
    leave a permanently-dead domain re-crawled on a fixed cadence forever,
    which is the per-domain cost leak this cache exists to prevent.
    """
    now = datetime.now(UTC)
    base = FAILURE_BACKOFF.total_seconds()
    cap = MAX_FAILURE_BACKOFF.total_seconds()
    # Seconds to wait after THIS failure: base * 2^(previous failures), capped.
    # Computed in SQL against the stored counter so it stays correct under a
    # concurrent second failure.
    grown_seconds = func.least(base * func.power(2, CompanyProfile.failure_count), cap)
    # Postgres multiplies an interval by a number; there is no cast involved.
    grown_interval = grown_seconds * literal_column("interval '1 second'")

    session.execute(
        pg_insert(CompanyProfile)
        .values(
            domain=domain,
            resolution_failed=True,
            failure_count=1,
            retry_after=now + FAILURE_BACKOFF,
            updated_at=now,
        )
        .on_conflict_do_update(
            index_elements=["domain"],
            set_={
                "resolution_failed": True,
                "failure_count": CompanyProfile.failure_count + 1,
                "retry_after": func.now() + grown_interval,
                "updated_at": now,
            },
        )
    )
    session.commit()


def _store_success(
    session: Session, domain: str, name: str, description: str | None, logo_url: str | None, source: str
) -> None:
    now = datetime.now(UTC)
    values = {
        "domain": domain,
        "name": name,
        "description": description,
        "logo_url": logo_url,
        "resolution_failed": False,
        "retry_after": None,
        # A success clears the failure streak, so a domain that recovers is not
        # punished by its history the next time it blips.
        "failure_count": 0,
        "refresh_after": now + REFRESH_INTERVAL,
        "source": source,
        "resolved_at": now,
        "updated_at": now,
    }
    session.execute(
        pg_insert(CompanyProfile)
        .values(**values)
        .on_conflict_do_update(
            index_elements=["domain"],
            set_={k: v for k, v in values.items() if k != "domain"},
        )
    )
    session.commit()


def resolve_company(domain: str | None, session: Session) -> CompanyProfile | None:
    """Return a cached or freshly-resolved profile, or None.

    None means "no company could be identified" — never an error the caller
    must handle. This function does not raise.
    """
    if not domain or not domain.strip():
        return None
    domain = domain.strip().lower()

    try:
        now = datetime.now(UTC)
        row = session.get(CompanyProfile, domain)

        if row is not None:
            # A CACHED NAME WINS, including over a failure flag. `_record_failure`
            # leaves identity fields intact, so a domain that resolved once and
            # later hit a transient failure still holds a good profile. Checking
            # `resolution_failed` first would return None for the whole backoff
            # window and throw that away — strictly worse than the "serve stale"
            # rule the spec mandates for the 90-day case.
            if row.name:
                return row
            if row.resolution_failed and row.retry_after and row.retry_after > now:
                return None  # never resolved, still inside backoff — spend nothing

        html = _fetch_site_html(domain)
        if not html:
            _record_failure(session, domain)
            return None

        # Markup first: a site that declares its own identity gives a more
        # accurate answer than an LLM inference AND costs nothing, so the model
        # is only worth spending on sites that declare nothing.
        source = "markup"
        extracted = extract_from_markup(html, domain)
        logo_url = extracted.get("logo_url") if extracted else None

        if not extracted or not _valid_name(extracted.get("name")):
            source = "llm"
            extracted = extract_company_context(html)
            if not extracted or not _valid_name(extracted.get("name")):
                _record_failure(session, domain)
                return None
            logo_url = logo_url or _logo_from_markup(html, domain)

        name = extracted["name"].strip()
        description = (extracted.get("description") or "").strip() or None
        _store_success(session, domain, name, description, logo_url, source)

        logger.info("company resolved | domain=%s | name=%s | via=%s", domain, name, source)
        session.expire_all()
        return session.get(CompanyProfile, domain)

    except Exception:
        # Best-effort by contract. Roll back so a poisoned session does not
        # leak into the caller's next statement, then report "no company".
        logger.warning("company resolution failed for %s", domain, exc_info=True)
        try:
            session.rollback()
        except Exception:
            logger.debug("rollback after resolution failure also failed", exc_info=True)
        return None
