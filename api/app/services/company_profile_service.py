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

It returns a plain :class:`ResolvedCompany`, not an ORM row, and **owns its
database sessions**. Both matter: an earlier version accepted the caller's
session and committed it, which made a half-built ``LeadInfo`` durable and
turned the caller's own ``rollback()`` into a no-op. Enrichment must never
decide someone else's transaction boundary. Returning a detached snapshot also
frees the caller from those sessions' lifetimes.

## Whose fault was it?

The table is a CROSS-TENANT cache — one row per domain, read by every
customer. So the single most damaging thing this module can do is write "no
company here" against a domain that is fine, because *we* were broken. An
expired Spider key would otherwise blacklist every domain it saw, and the
exponential backoff would compound that to 90 days.

Every failure is therefore classified before it is stored:

* **The target's fault** — the target itself answered 404/410, or a page we
  genuinely read describes no company. Cached with compounding backoff, which
  is the point of the cache.
* **Ours, or nobody's** — *everything else*. No API key, an expired key, quota
  exhausted, Spider down, its endpoint moved, our request malformed, a proxy
  error page, the target 5xx'ing today, the model unreachable. Never
  attributed to the domain. It gets a short :data:`INDETERMINATE_COOLDOWN`
  instead, which bounds the retry storm during an outage without poisoning
  anything: the cache self-heals within minutes of the outage ending.

The classification is **fail-closed** — a lasting verdict requires positive
evidence, and anything unrecognised lands in the second bucket. That asymmetry
is deliberate, because the two mistakes do not cost the same: wrongly blaming
ourselves costs one repeated crawl, while wrongly blaming a real company
hides it from every tenant for up to 90 days.

This is why the module calls ``spider_service.fetch_html_outcome`` rather than
``fetch_html``, and passes ``strict=True`` to the extractor. Both plain
variants collapse every failure to ``None``, which makes the distinction above
impossible to recover.

## Order of work

1. Cache read, in its own short transaction. A stored name wins immediately —
   including over a later failure flag, so one transient 503 cannot hide a good
   profile for a whole backoff window. A profile past ``refresh_after`` is
   re-resolved, falling back to the stale value if the re-crawl fails.
2. Crawl the domain root, under a short timeout, holding NO database
   connection. The pool is shared with request handling.
3. Read the site's own declared markup (schema.org, then ``og:site_name``).
   Free, and more accurate than inference because it is a declaration.
4. Only if the site declares nothing, spend an LLM call.
5. Upsert, in a second short transaction. Never a read-then-insert: two leads
   from one company arriving together is the normal case, and the loser of that
   race would raise ``IntegrityError`` straight through the "never raises"
   contract.
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
# Applied when WE failed, not the domain. Short and flat: long enough that an
# outage cannot turn every arriving lead into a crawl, short enough that the
# cache recovers on its own once the outage ends. Deliberately does not set
# `resolution_failed` and does not touch `failure_count`.
INDETERMINATE_COOLDOWN = timedelta(minutes=15)

# One root page, not a crawl. ``SPIDER_TIMEOUT`` is ~1600s because it is tuned
# for a full multi-page site crawl; inheriting it here let a single
# black-holing domain occupy one of the three shared background workers for
# almost half an hour, starving geolocation and BANT extraction alongside it.
# This bounds EACH leg, so the crawl phase is at most 2× this.
FETCH_TIMEOUT_SECONDS = 15.0

# The LLM leg needs its own bound for the same reason. The module defaults
# (60s × 3 attempts ≈ 180s) are sized for the request path, where one user is
# waiting on their own request; here three threads are shared platform-wide.
LLM_TIMEOUT_SECONDS = 20.0
LLM_NUM_RETRIES = 1

# Cap on what we RETAIN and parse. A visitor can name any domain they like,
# and BeautifulSoup costs several times the string in RSS. Matches the size
# used by ``brand_color_extractor``.
#
# Honest about its limit: the vendor clients have already downloaded and
# decoded the whole body by the time this runs, so this bounds the parse and
# the LLM input, NOT peak download memory. Capping at the transport would mean
# a byte limit inside spider_service/jina_service, which is a wider change than
# this feature should make to a shared crawl path.
MAX_CONTENT_BYTES = 2 * 1024 * 1024

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
    # None for rows written before `source` existed, or by a bulk backfill.
    source: str | None


@dataclass(frozen=True)
class _Fetched:
    """Crawl outcome.

    ``infrastructure_ok`` separates "the site had nothing for us" from "OUR
    crawler could not run" — see the module docstring. It is derived from what
    Spider actually reported, not inferred from a bare ``None``.
    """

    content: str | None
    is_html: bool
    infrastructure_ok: bool


class _ProviderUnavailable(Exception):
    """Our side failed. Never attributable to the domain."""


def _fetch_site_html(domain: str) -> _Fetched:
    """Fetch the domain's root page. Spider (HTML) first, Jina (markdown) after.

    Isolated as its own function so tests patch one seam instead of two async
    HTTP clients.
    """
    from app.services import jina_service, spider_service

    url = f"https://{domain}"
    # Starts False: absent positive evidence that a provider answered ABOUT
    # this domain, we have no standing to record anything against it.
    answered = False

    async def _spider() -> spider_service.ScrapeOutcome:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_SECONDS) as client:
            return await asyncio.wait_for(
                spider_service.fetch_html_outcome(url, _client=client), timeout=FETCH_TIMEOUT_SECONDS
            )

    async def _jina() -> dict:
        return await asyncio.wait_for(jina_service.fetch_urls([url]), timeout=FETCH_TIMEOUT_SECONDS)

    try:
        outcome = asyncio.run(_spider())
        answered = outcome.answered
        if outcome.content:
            return _Fetched(content=_capped(outcome.content), is_html=True, infrastructure_ok=True)
    except TimeoutError:
        # We could not get an answer in time. That is OUR failure to observe,
        # not a fact about the domain — Spider's own API may be the thing
        # hanging, and we cannot tell from here.
        logger.warning("spider fetch timed out for %s", domain)
    except Exception:
        logger.warning("spider fetch failed for %s", domain, exc_info=True)

    # Jina is a bonus leg: it can only ever UPGRADE the outcome to a success.
    # Its client also collapses every failure to an empty result list, so a
    # miss here is never taken as evidence about the domain.
    try:
        result = asyncio.run(_jina())
        pages = result.get("results") or []
        if pages and pages[0].get("content"):
            # Jina returns MARKDOWN, not HTML. Flagged so the markup reader is
            # skipped rather than run against content it can never match —
            # which previously meant every Jina-served domain silently took the
            # LLM path and never got a logo.
            return _Fetched(content=_capped(pages[0]["content"]), is_html=False, infrastructure_ok=True)
    except TimeoutError:
        logger.warning("jina fetch timed out for %s", domain)
    except Exception:
        logger.warning("jina fetch failed for %s", domain, exc_info=True)

    return _Fetched(content=None, is_html=False, infrastructure_ok=answered)


def _capped(content: str) -> str:
    """Truncate a fetched body before we parse or retain it.

    Measured in BYTES, not characters. ``len()`` on a ``str`` counts code
    points, so a page carrying astral-plane characters is held at 4 bytes each
    internally — a "2 MB" character cap would admit up to 8 MB of RSS.
    """
    encoded = content.encode("utf-8", errors="ignore")
    if len(encoded) <= MAX_CONTENT_BYTES:
        return content
    logger.info("fetched body truncated from %d to %d bytes", len(encoded), MAX_CONTENT_BYTES)
    # Decode back with errors="ignore" so a cut through a multi-byte sequence
    # drops that character rather than raising.
    return encoded[:MAX_CONTENT_BYTES].decode("utf-8", errors="ignore")


def _valid_name(name: object) -> bool:
    if not isinstance(name, str):
        return False
    cleaned = name.strip()
    if not cleaned or len(cleaned) > _MAX_NAME_LEN:
        return False
    return cleaned.lower() not in _PROMPT_ECHOES


def _record_failure(session: Session, domain: str) -> None:
    """Mark a domain unresolvable, with backoff that GROWS per attempt.

    Only for failures attributable to the TARGET — see the module docstring.
    Upsert, not read-then-insert. Flat backoff would leave a permanently-dead
    domain re-crawled on a fixed cadence forever, which is the per-domain cost
    leak this cache exists to prevent.
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


def _record_cooldown(session: Session, domain: str) -> None:
    """Back off briefly after OUR failure, without blaming the domain.

    Writes ``retry_after`` only. ``resolution_failed`` and ``failure_count``
    are deliberately untouched, so an outage leaves no lasting verdict and
    contributes nothing to the exponential backoff.

    It EXTENDS rather than assigns. A plain assignment would let our own
    outage *shorten* a backoff the domain had legitimately earned: 500 dead
    domains sitting on 30-90 day retries, knocked back to 15 minutes each by
    one Spider outage, then re-crawled every quarter hour for its duration.
    A cooldown may only ever push the next attempt further out.
    """
    extended = func.greatest(
        func.coalesce(CompanyProfile.retry_after, func.now()),
        func.now() + INDETERMINATE_COOLDOWN,
    )
    session.execute(
        pg_insert(CompanyProfile)
        .values(
            domain=domain,
            retry_after=func.now() + INDETERMINATE_COOLDOWN,
            updated_at=func.now(),
        )
        .on_conflict_do_update(
            index_elements=["domain"],
            set_={
                "retry_after": extended,
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
        source=row.source,
    )


@dataclass(frozen=True)
class _CacheRead:
    """What the cache had to say. Exactly one of these is acted on."""

    # Serve this and stop — either fresh, or backing off a failed refresh.
    hit: ResolvedCompany | None
    # Nothing to serve and we are inside a backoff window: spend nothing.
    blocked: bool
    # Serve this only if the re-resolve below fails.
    stale_fallback: ResolvedCompany | None


def _read_cache(domain: str) -> _CacheRead:
    """Read the cache in its OWN short transaction.

    Deliberately not folded into the write session. ``session.get`` autobegins
    a transaction, so holding one session across the crawl and the LLM pinned a
    pooled connection ``idle in transaction`` for the whole window — measured
    at one connection per in-flight resolution, against a pool of 5 shared with
    request handling. Three concurrent resolutions could starve the API.
    """
    now = datetime.now(UTC)
    with get_session() as session:
        row = session.get(CompanyProfile, domain)
        if row is None:
            return _CacheRead(hit=None, blocked=False, stale_fallback=None)

        # A CACHED NAME WINS, including over a failure flag. The failure writers
        # leave identity fields intact, so a domain that resolved once and later
        # hit a transient failure still holds a good profile. Checking the
        # failure state first would return None for the whole backoff window and
        # throw that away.
        if row.name:
            # A NULL `refresh_after` means "never refreshed" (a backfilled or
            # hand-inserted row), which is stale, not fresh-forever.
            if row.refresh_after and row.refresh_after > now:
                return _CacheRead(hit=_snapshot(row), blocked=False, stale_fallback=None)
            # Past its refresh horizon. Re-resolve — this already runs on a
            # background thread, so nothing user-facing is waiting — but keep
            # the old value to serve if the re-crawl fails.
            #
            # A failed refresh sets `retry_after`, and it must be honoured HERE
            # as well: only a SUCCESS moves `refresh_after`, so a stale domain
            # gone permanently dark would otherwise re-crawl on every lead.
            if row.retry_after and row.retry_after > now:
                return _CacheRead(hit=_snapshot(row), blocked=False, stale_fallback=None)
            return _CacheRead(hit=None, blocked=False, stale_fallback=_snapshot(row))

        # No name yet. `retry_after` alone gates the retry, whether it was set
        # by the domain's own failure or by our cooldown.
        if row.retry_after and row.retry_after > now:
            return _CacheRead(hit=None, blocked=True, stale_fallback=None)
        return _CacheRead(hit=None, blocked=False, stale_fallback=None)


def _extract(fetched: _Fetched, domain: str) -> tuple[dict, str, str | None]:
    """Turn fetched content into ``(extracted, source, logo_url)``.

    Raises :class:`_ProviderUnavailable` if the MODEL was the thing that
    failed, so the caller does not record that against the domain. Returns an
    empty dict when the content genuinely describes no company.
    """
    # Markup first: a site that declares its own identity gives a more accurate
    # answer than an LLM inference AND costs nothing, so the model is only
    # worth spending on sites that declare nothing. Skipped for Jina content,
    # which is markdown and carries no meta tags to read.
    extracted = extract_from_markup(fetched.content, domain) if fetched.is_html else None
    if extracted and _valid_name(extracted.get("name")):
        return extracted, "markup", extracted.get("logo_url")

    logo_url = extracted.get("logo_url") if extracted else None
    try:
        llm_result = extract_company_context(
            fetched.content,
            timeout=LLM_TIMEOUT_SECONDS,
            num_retries=LLM_NUM_RETRIES,
            strict=True,
        )
    except Exception as exc:
        # The model was unreachable / out of quota / erroring. That says
        # nothing about the content, so it must not be cached against the
        # domain — the same rule as the crawl leg.
        raise _ProviderUnavailable(f"company-context extraction failed: {exc}") from exc

    if not llm_result or not _valid_name(llm_result.get("name")):
        return {}, "llm", logo_url
    if logo_url is None and fetched.is_html:
        logo_url = extract_logo(fetched.content, domain)
    return llm_result, "llm", logo_url


def _resolve(domain: str) -> ResolvedCompany | None:
    cached = _read_cache(domain)
    if cached.hit is not None:
        return cached.hit
    if cached.blocked:
        return None
    stale_fallback = cached.stale_fallback

    # Everything below is wrapped, and every exit returns `stale_fallback`
    # rather than None. A good cached name must survive ANY failure here, not
    # just the ones we anticipated: the write blocks can raise too (a pool
    # timeout on the connection pool this very module contends for), and
    # losing a perfectly good profile to a transient DB blip is a strictly
    # worse outcome than serving it a day stale.
    try:
        # No database connection is held across the network calls below.
        fetched = _fetch_site_html(domain)
        if not fetched.content:
            if fetched.infrastructure_ok:
                with get_session() as session:
                    _record_failure(session, domain)
            else:
                logger.warning("crawl unavailable; cooling down rather than blaming %s", domain)
                with get_session() as session:
                    _record_cooldown(session, domain)
            return stale_fallback

        extracted, source, logo_url = _extract(fetched, domain)

        if not extracted:
            with get_session() as session:
                _record_failure(session, domain)
            return stale_fallback

        name = extracted["name"].strip()
        description = (extracted.get("description") or "").strip() or None
        with get_session() as session:
            _store_success(session, domain, name, description, logo_url, source)
    except _ProviderUnavailable as exc:
        logger.warning("provider unavailable while resolving %s: %s", domain, exc)
        try:
            with get_session() as session:
                _record_cooldown(session, domain)
        except Exception:
            logger.warning("could not record cooldown for %s", domain, exc_info=True)
        return stale_fallback
    except Exception:
        logger.warning("resolution of %s failed; serving cached value if any", domain, exc_info=True)
        return stale_fallback

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

    **Call this from a worker thread, not from async code.** It is synchronous
    and drives the async crawl clients with ``asyncio.run``, which raises
    inside a running event loop. That is checked explicitly below rather than
    left to fail as an unattributable ``None``.

    ``domain`` is normalised through
    :func:`domain_normalizer.registrable_domain` before anything else, so a raw
    host, a ``www.`` prefix, or a trailing dot all collapse to the one cache
    key this cross-tenant table depends on.

    **There is deliberately no ``session`` parameter.** An earlier version took
    one, and wiring it into lead capture meant this function committed the
    caller's transaction: a half-built ``LeadInfo`` became durable and the
    caller's own ``rollback()`` turned into a no-op. Opening its own sessions is
    not merely the default — it is the only option, so that regression cannot
    be reintroduced by a call site.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass  # the expected case: a plain worker thread
    else:
        logger.error(
            "resolve_company called from an event loop; it is synchronous and would "
            "deadlock. Dispatch it with submit_background / run_in_executor instead."
        )
        return None

    try:
        key = registrable_domain(domain)
        if not key:
            return None
        return _resolve(key)
    except Exception:
        logger.warning("company resolution failed for %r", domain, exc_info=True)
        return None
