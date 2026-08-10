"""Resolve a registrable domain to a company profile, cache-first.

Reuses machinery that already exists: the Spider→Jina crawl stack, the markup
reader in :mod:`company_markup`, and ``llm_service.extract_company_context``
(the same helper that derives a customer's own company name during
onboarding). No new vendor.

## Contract

``resolve_company`` is best-effort and **never raises**. It runs on a
background thread behind lead capture and must never surface to a visitor, so
every failure path returns ``None``. ``None`` means "no company identified",
not "an error occurred".

It returns a plain :class:`ResolvedCompany`, not an ORM row, and **owns its own
database session**. Both matter: an earlier version accepted the caller's
session and committed it, which made a half-built ``LeadInfo`` durable and
turned the caller's own ``rollback()`` into a no-op. Enrichment must never
decide someone else's transaction boundary. Returning a detached snapshot also
frees the caller from this session's lifetime.

## Order of work

1. Cache read. A stored name wins immediately — including over a later failure
   flag, so one transient 503 cannot hide a good profile for a whole backoff
   window. A profile past ``refresh_after`` is re-resolved, falling back to the
   stale value if the re-crawl fails.
2. Crawl the domain root, under a short timeout.
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
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import func, literal_column
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.orm import Session

from app.db.models import CompanyProfile
from app.db.session import get_session
from app.services.company_markup import extract_from_markup, extract_logo
from app.services.domain_normalizer import registrable_domain
from app.services.llm_service import extract_company_context

logger = logging.getLogger(__name__)

REFRESH_INTERVAL = timedelta(days=90)
FAILURE_BACKOFF = timedelta(days=1)
# Cap the doubling so a domain is still retried eventually, just rarely.
MAX_FAILURE_BACKOFF = timedelta(days=90)

# One root page, not a crawl. ``SPIDER_TIMEOUT`` is ~1600s because it is tuned
# for a full multi-page site crawl; inheriting it here let a single
# black-holing domain occupy one of the three shared background workers for
# almost half an hour, starving geolocation and BANT extraction alongside it.
FETCH_TIMEOUT_SECONDS = 15.0

# Longest plausible company name. Past this the model is narrating, not naming.
_MAX_NAME_LEN = 120
# Phrases that mean the model echoed the instructions instead of answering.
_PROMPT_ECHOES = {"company name", "company_name", "name", "unknown", "n/a", "none", "null"}


@dataclass(frozen=True)
class ResolvedCompany:
    """A detached snapshot — safe to read after this module's session closes."""

    domain: str
    name: str
    description: str | None
    logo_url: str | None
    source: str


@dataclass(frozen=True)
class _Fetched:
    """Crawl outcome.

    ``infrastructure_ok`` separates "the site had nothing for us" from "OUR
    crawler could not run". Only the former is a property of the domain, and
    only the former may be cached as a failure — otherwise an expired API key
    or a wiring mistake silently poisons a cache every tenant reads, and the
    backoff compounds it to 90 days.
    """

    content: str | None
    is_html: bool
    infrastructure_ok: bool


def _fetch_site_html(domain: str) -> _Fetched:
    """Fetch the domain's root page. Spider (HTML) first, Jina (markdown) after.

    Isolated as its own function so tests patch one seam instead of two async
    HTTP clients.
    """
    from app.services import jina_service, spider_service

    url = f"https://{domain}"
    reachable = False

    async def _spider() -> str | None:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_SECONDS) as client:
            return await asyncio.wait_for(spider_service.fetch_html(url, _client=client), timeout=FETCH_TIMEOUT_SECONDS)

    async def _jina() -> dict:
        return await asyncio.wait_for(jina_service.fetch_urls([url]), timeout=FETCH_TIMEOUT_SECONDS)

    try:
        html = asyncio.run(_spider())
        reachable = True
        if html:
            return _Fetched(content=html, is_html=True, infrastructure_ok=True)
    except TimeoutError:
        reachable = True  # we reached the network; the SITE was too slow
        logger.debug("spider fetch timed out for %s", domain)
    except Exception:
        logger.debug("spider fetch failed for %s", domain, exc_info=True)

    try:
        result = asyncio.run(_jina())
        reachable = True
        pages = result.get("results") or []
        if pages and pages[0].get("content"):
            # Jina returns MARKDOWN, not HTML. Flagged so the markup reader is
            # skipped rather than run against content it can never match —
            # which previously meant every Jina-served domain silently took the
            # LLM path and never got a logo.
            return _Fetched(content=pages[0]["content"], is_html=False, infrastructure_ok=True)
    except TimeoutError:
        reachable = True
        logger.debug("jina fetch timed out for %s", domain)
    except Exception:
        logger.debug("jina fetch failed for %s", domain, exc_info=True)

    return _Fetched(content=None, is_html=False, infrastructure_ok=reachable)


def _valid_name(name: object) -> bool:
    if not isinstance(name, str):
        return False
    cleaned = name.strip()
    if not cleaned or len(cleaned) > _MAX_NAME_LEN:
        return False
    return cleaned.lower() not in _PROMPT_ECHOES


def _record_failure(session: Session, domain: str) -> None:
    """Mark a domain unresolvable, with backoff that GROWS per attempt.

    Upsert, not read-then-insert — see the module docstring. Flat backoff would
    leave a permanently-dead domain re-crawled on a fixed cadence forever,
    which is the per-domain cost leak this cache exists to prevent.
    """
    base = FAILURE_BACKOFF.total_seconds()
    cap = MAX_FAILURE_BACKOFF.total_seconds()
    # Seconds to wait after THIS failure: base * 2^(previous failures), capped.
    # Computed in SQL against the stored counter so it stays correct under a
    # concurrent second failure. The EXPONENT is clamped before the power, so a
    # pathological counter cannot overflow numeric on the way to the cap.
    exponent = func.least(CompanyProfile.failure_count, 32)
    grown_seconds = func.least(base * func.power(2, exponent), cap)
    grown_interval = grown_seconds * literal_column("interval '1 second'")

    session.execute(
        pg_insert(CompanyProfile)
        .values(
            domain=domain,
            resolution_failed=True,
            failure_count=1,
            retry_after=func.now() + FAILURE_BACKOFF,
            updated_at=func.now(),
        )
        .on_conflict_do_update(
            index_elements=["domain"],
            set_={
                "resolution_failed": True,
                "failure_count": CompanyProfile.failure_count + 1,
                "retry_after": func.now() + grown_interval,
                "updated_at": func.now(),
            },
        )
    )
    session.commit()


def _store_success(
    session: Session,
    domain: str,
    name: str,
    description: str | None,
    logo_url: str | None,
    source: str,
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


def _snapshot(row: CompanyProfile | None) -> ResolvedCompany | None:
    if row is None or not row.name:
        return None
    return ResolvedCompany(
        domain=row.domain,
        name=row.name,
        description=row.description,
        logo_url=row.logo_url,
        source=row.source or "unknown",
    )


def _resolve(domain: str, session: Session) -> ResolvedCompany | None:
    now = datetime.now(UTC)
    row = session.get(CompanyProfile, domain)
    stale_fallback: ResolvedCompany | None = None

    if row is not None:
        # A CACHED NAME WINS, including over a failure flag. `_record_failure`
        # leaves identity fields intact, so a domain that resolved once and
        # later hit a transient failure still holds a good profile. Checking
        # `resolution_failed` first would return None for the whole backoff
        # window and throw that away.
        if row.name:
            if not row.refresh_after or row.refresh_after > now:
                return _snapshot(row)
            # Past its refresh horizon. Re-resolve — this already runs on a
            # background thread, so nothing user-facing is waiting — but keep
            # the old value to serve if the re-crawl fails. Without this the
            # column is write-only and a company that rebrands is served wrong
            # to every tenant forever.
            #
            # A failed refresh still sets `retry_after`, and it must be honoured
            # HERE as well: a stale domain that has gone permanently unreachable
            # would otherwise re-crawl on every single lead, since
            # `refresh_after` stays in the past and only a success moves it.
            if row.retry_after and row.retry_after > now:
                return _snapshot(row)
            stale_fallback = _snapshot(row)
        elif row.resolution_failed and row.retry_after and row.retry_after > now:
            return None  # never resolved, still inside backoff — spend nothing

    fetched = _fetch_site_html(domain)
    if not fetched.content:
        if fetched.infrastructure_ok:
            _record_failure(session, domain)
        else:
            # Our crawler could not run. That says nothing about the domain, so
            # it must not be cached as "this company does not exist".
            logger.warning("crawl infrastructure unavailable; not caching a failure for %s", domain)
        return stale_fallback

    # Markup first: a site that declares its own identity gives a more accurate
    # answer than an LLM inference AND costs nothing, so the model is only
    # worth spending on sites that declare nothing. Skipped for Jina content,
    # which is markdown and carries no meta tags to read.
    source = "markup"
    extracted = extract_from_markup(fetched.content, domain) if fetched.is_html else None
    logo_url = extracted.get("logo_url") if extracted else None

    if not extracted or not _valid_name(extracted.get("name")):
        source = "llm"
        extracted = extract_company_context(fetched.content)
        if not extracted or not _valid_name(extracted.get("name")):
            _record_failure(session, domain)
            return stale_fallback
        if logo_url is None and fetched.is_html:
            logo_url = extract_logo(fetched.content, domain)

    name = extracted["name"].strip()
    description = (extracted.get("description") or "").strip() or None
    _store_success(session, domain, name, description, logo_url, source)

    logger.info("company resolved | domain=%s | name=%s | via=%s", domain, name, source)
    return ResolvedCompany(
        domain=domain,
        name=name,
        description=description,
        logo_url=logo_url,
        source=source,
    )


def resolve_company(domain: str | None) -> ResolvedCompany | None:
    """Return a cached or freshly-resolved company, or None.

    ``None`` means "no company could be identified" — never an error the caller
    must handle. This function does not raise.

    ``domain`` is normalised through
    :func:`domain_normalizer.registrable_domain` before anything else, so a raw
    host, a ``www.`` prefix, or a trailing dot all collapse to the one cache
    key this cross-tenant table depends on.

    **There is deliberately no ``session`` parameter.** An earlier version took
    one, and wiring it into lead capture meant this function committed the
    caller's transaction: a half-built ``LeadInfo`` became durable and the
    caller's own ``rollback()`` turned into a no-op. Opening its own session is
    not merely the default — it is the only option, so that regression cannot
    be reintroduced by a call site. Tests reach ``_resolve`` directly.
    """
    try:
        key = registrable_domain(domain)
        if not key:
            return None
        with get_session() as own_session:
            return _resolve(key, own_session)
    except Exception:
        logger.warning("company resolution failed for %r", domain, exc_info=True)
        return None
