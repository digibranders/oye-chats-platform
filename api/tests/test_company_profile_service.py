"""Cache-first company resolution.

The expensive path (crawl + LLM) must run at most once per domain. A fresh
hit, a previously-failed domain inside its backoff window, and a domain that
already resolved must all return without touching the network.

Two properties here came out of adversarial review of the schema and are not
merely nice-to-have:

* **Concurrent resolution must not raise.** Two leads from one company
  arriving together is the motivating case in the spec, and a read-then-insert
  loses that race with an IntegrityError out of a function whose docstring
  promises it never raises.
* **A cached name outranks a failure flag.** A domain that resolved once and
  later hit a transient failure still holds a good profile; returning None for
  the whole backoff window would throw it away.
"""

from __future__ import annotations

import os
import threading
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest

from app.db.models import CompanyProfile
from app.services import company_profile_service as svc

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")

MARKED_UP = (
    '<html><head><meta property="og:site_name" content="Acme Corp">'
    '<meta property="og:description" content="Acme Corp does logistics."></head></html>'
)
# No og:site_name and no schema.org — the markup pass gives up, forcing the LLM.
NO_MARKUP = "<html><head><title>Best logistics software in India for growing teams</title></head></html>"


def _crawled(html=MARKED_UP, *, is_html=True):
    return patch.object(
        svc,
        "_fetch_site_html",
        return_value=svc._Fetched(content=html, is_html=is_html, infrastructure_ok=True),
    )


def _crawl_failed(*, infrastructure_ok=True):
    """The site gave us nothing.

    ``infrastructure_ok=False`` means OUR crawler could not run, which says
    nothing about the domain and must NOT be cached against it.
    """
    return patch.object(
        svc,
        "_fetch_site_html",
        return_value=svc._Fetched(content=None, is_html=False, infrastructure_ok=infrastructure_ok),
    )


def _extracted(result=None):
    if result is None:
        result = {"name": "Acme Corp", "description": "Acme Corp does logistics."}
    return patch.object(svc, "extract_company_context", return_value=result)


# ── Cache behaviour ──────────────────────────────────────────────────────────


def test_miss_crawls_and_stores(db):
    with _crawled() as crawl, _extracted():
        profile = svc.resolve_company("acme.com")
    assert profile.name == "Acme Corp"
    assert crawl.call_count == 1
    db.expire_all()
    assert db.get(CompanyProfile, "acme.com") is not None


def test_second_lead_on_same_domain_does_not_crawl(db):
    with _crawled(), _extracted():
        svc.resolve_company("acme.com")
    with _crawled() as crawl2, _extracted():
        svc.resolve_company("acme.com")
    assert crawl2.call_count == 0, "cache hit must not re-crawl"


def test_case_differing_domains_share_one_row(db):
    """CITEXT key — Acme.COM and acme.com are one company, one crawl."""
    with _crawled(), _extracted():
        svc.resolve_company("acme.com")
    with _crawled() as crawl2, _extracted():
        profile = svc.resolve_company("ACME.com")
    assert crawl2.call_count == 0
    assert profile.name == "Acme Corp"


# ── Markup before LLM ────────────────────────────────────────────────────────


def test_markup_is_used_and_the_llm_is_never_called(db):
    """The point of the markup pass: a site that declares its own name must not
    cost an LLM round-trip."""
    with _crawled(MARKED_UP), _extracted() as llm:
        profile = svc.resolve_company("marked.com")
    assert profile.name == "Acme Corp"
    assert profile.source == "markup"
    assert llm.call_count == 0


def test_llm_is_the_fallback_when_markup_is_absent(db):
    with _crawled(NO_MARKUP), _extracted() as llm:
        profile = svc.resolve_company("bare.com")
    assert profile.name == "Acme Corp"
    assert profile.source == "llm"
    assert llm.call_count == 1


# ── Failure caching and backoff ──────────────────────────────────────────────


def test_crawl_failure_records_backoff_rather_than_raising(db):
    with _crawl_failed():
        profile = svc.resolve_company("parked.com")
    assert profile is None
    db.expire_all()
    row = db.get(CompanyProfile, "parked.com")
    assert row.resolution_failed is True
    assert row.retry_after is not None
    assert row.failure_count == 1


def test_failed_domain_is_not_recrawled_during_backoff(db):
    db.add(
        CompanyProfile(
            domain="dead.com",
            resolution_failed=True,
            failure_count=1,
            retry_after=datetime.now(UTC) + timedelta(hours=6),
        )
    )
    db.commit()
    with _crawled() as crawl, _extracted():
        profile = svc.resolve_company("dead.com")
    assert profile is None
    assert crawl.call_count == 0


def test_failed_domain_is_retried_after_backoff_expires(db):
    db.add(
        CompanyProfile(
            domain="revived.com",
            resolution_failed=True,
            failure_count=1,
            retry_after=datetime.now(UTC) - timedelta(hours=1),
        )
    )
    db.commit()
    with _crawled(), _extracted():
        profile = svc.resolve_company("revived.com")
    assert profile is not None and profile.name == "Acme Corp"
    # resolve_company returns a detached snapshot; persisted state is read
    # from the row, which is also the honest thing to assert.
    db.expire_all()
    row = db.get(CompanyProfile, "revived.com")
    assert row.resolution_failed is False
    assert row.failure_count == 0, "a success must clear the failure streak"


def test_backoff_grows_with_consecutive_failures(db):
    """Flat backoff means a permanently-dead domain is re-crawled at a fixed
    rate forever — the per-domain cost leak this cache exists to prevent.

    Calls the writer directly: going through ``resolve_company`` cannot produce
    consecutive failures, because after the first one the backoff guard
    correctly short-circuits before any crawl is attempted.
    """
    waits = []
    for _ in range(3):
        svc._record_failure(db, "always-dead.com")
        db.expire_all()
        row = db.get(CompanyProfile, "always-dead.com")
        waits.append(row.retry_after)

    assert row.failure_count == 3
    assert waits[0] < waits[1] < waits[2], f"backoff did not grow: {waits}"
    # Roughly doubling, not merely increasing by a second.
    first = (waits[1] - waits[0]).total_seconds()
    second = (waits[2] - waits[1]).total_seconds()
    assert second > first * 1.5, f"growth is not exponential: {first}s then {second}s"


def test_backoff_is_capped(db):
    """A domain dead for years must still be retried eventually, just rarely."""
    db.add(CompanyProfile(domain="ancient.com", resolution_failed=True, failure_count=40))
    db.commit()
    svc._record_failure(db, "ancient.com")
    db.expire_all()
    row = db.get(CompanyProfile, "ancient.com")
    wait = row.retry_after - datetime.now(UTC)
    assert wait <= svc.MAX_FAILURE_BACKOFF + timedelta(minutes=1), wait


@pytest.mark.parametrize(
    "bad",
    [
        None,
        {"name": "", "description": "x"},
        {"name": "   ", "description": "x"},
        {"name": "A" * 200, "description": "x"},
        {"name": "COMPANY NAME", "description": "x"},
    ],
)
def test_junk_llm_output_is_rejected_and_cached_as_failure(db, bad):
    with _crawled(NO_MARKUP), patch.object(svc, "extract_company_context", return_value=bad):
        profile = svc.resolve_company("junk.com")
    assert profile is None
    db.expire_all()
    assert db.get(CompanyProfile, "junk.com").resolution_failed is True


# ── Read precedence ──────────────────────────────────────────────────────────


def test_a_cached_name_outranks_a_later_transient_failure(db):
    """One bad crawl (503, bot wall) must not hide a good cached profile for
    the whole backoff window."""
    db.add(
        CompanyProfile(
            domain="flaky.com",
            name="Flaky Corp",
            resolution_failed=True,
            failure_count=1,
            retry_after=datetime.now(UTC) + timedelta(days=1),
        )
    )
    db.commit()
    with _crawled() as crawl, _extracted():
        profile = svc.resolve_company("flaky.com")
    assert profile is not None and profile.name == "Flaky Corp"
    assert crawl.call_count == 0


def test_stale_profile_is_refreshed(db):
    """`refresh_after` must actually be READ. It was write-only before, which
    meant a company that rebrands was served wrong to every tenant forever."""
    db.add(
        CompanyProfile(
            domain="stale.com",
            name="Old Name",
            refresh_after=datetime.now(UTC) - timedelta(days=1),
        )
    )
    db.commit()
    with _crawled() as crawl, _extracted():
        profile = svc.resolve_company("stale.com")
    assert crawl.call_count == 1, "a stale profile must be re-resolved"
    assert profile.name == "Acme Corp"


def test_a_fresh_profile_is_not_refreshed(db):
    db.add(
        CompanyProfile(
            domain="fresh.com",
            name="Fresh Corp",
            refresh_after=datetime.now(UTC) + timedelta(days=30),
        )
    )
    db.commit()
    with _crawled() as crawl, _extracted():
        profile = svc.resolve_company("fresh.com")
    assert crawl.call_count == 0
    assert profile.name == "Fresh Corp"


def test_stale_profile_survives_a_failed_refresh(db):
    """Losing a good cached name because today's re-crawl 503'd would be a
    strict regression on serving it stale."""
    db.add(
        CompanyProfile(
            domain="stale2.com",
            name="Still Good",
            refresh_after=datetime.now(UTC) - timedelta(days=1),
        )
    )
    db.commit()
    with _crawl_failed():
        profile = svc.resolve_company("stale2.com")
    assert profile is not None and profile.name == "Still Good"


# ── Contract ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("domain", [None, "", "   "])
def test_empty_domain_returns_none(db, domain):
    assert svc.resolve_company(domain) is None


def test_never_raises_when_the_crawl_blows_up(db):
    """Best-effort: this runs on a background thread behind lead capture and
    must never surface to a visitor."""
    with patch.object(svc, "_fetch_site_html", side_effect=RuntimeError("network on fire")):
        assert svc.resolve_company("explode.com") is None


def test_never_raises_when_the_llm_blows_up(db):
    with _crawled(NO_MARKUP), patch.object(svc, "extract_company_context", side_effect=RuntimeError("llm down")):
        assert svc.resolve_company("llm-down.com") is None


def test_concurrent_resolution_of_a_new_domain_does_not_raise(db):
    """Two leads from one company arriving together is the spec's motivating
    case. A read-then-insert loses this race with IntegrityError; the writer
    must upsert.

    The barrier inside the (patched) crawl holds both threads past their cache
    read until the other has got there too, so both are guaranteed to believe
    the row does not exist and to race on the write. Each thread opens its own
    session, exactly as the two background threads would in production.
    """
    barrier = threading.Barrier(2)
    results: dict[int, str] = {}

    def gated_fetch(_domain: str):
        barrier.wait(timeout=15)
        return svc._Fetched(content=MARKED_UP, is_html=True, infrastructure_ok=True)

    def worker(idx: int) -> None:
        try:
            with (
                patch.object(svc, "_fetch_site_html", side_effect=gated_fetch),
                _extracted(),
            ):
                svc.resolve_company("race.com")
            results[idx] = "OK"
        except Exception as exc:  # noqa: BLE001 — an empty result set IS the assertion
            results[idx] = f"{type(exc).__name__}: {exc}"

    threads = [threading.Thread(target=worker, args=(i,)) for i in (1, 2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    assert set(results.values()) == {"OK"}, results
    # And exactly one row, not two.
    db.expire_all()
    assert db.get(CompanyProfile, "race.com") is not None


# ── Transaction ownership (review blocker H1) ────────────────────────────────


def test_resolution_does_not_commit_the_callers_pending_work(db):
    """Enrichment must not decide someone else's transaction boundary.

    This ran behind lead capture and committed the session it was handed, so a
    half-built ``LeadInfo`` became durable and the caller's own ``rollback()``
    silently did nothing. The service now opens its own session; the caller's
    uncommitted work must still be discardable afterwards.
    """
    db.add(CompanyProfile(domain="callers-pending.com", name="Should Never Persist"))
    db.flush()  # in the caller's transaction, deliberately NOT committed

    with _crawled(), _extracted():
        assert svc.resolve_company("unrelated.com") is not None

    db.rollback()
    db.expire_all()
    assert db.get(CompanyProfile, "callers-pending.com") is None, (
        "resolve_company committed work belonging to the caller"
    )
    # Its own write, in its own session, did commit.
    db.expire_all()
    assert db.get(CompanyProfile, "unrelated.com") is not None


def test_resolve_company_cannot_be_handed_a_session(db):
    """The structural half of the guard above.

    The test before this one proves the CURRENT call path is clean; this one
    proves a future call site cannot reopen the hole. If a ``session``
    parameter comes back, someone will pass their request-scoped session into
    it and this function will commit their transaction again.
    """
    import inspect

    params = inspect.signature(svc.resolve_company).parameters
    assert list(params) == ["domain"], f"resolve_company must take only a domain; got {list(params)}"


def test_the_fetch_timeout_is_a_page_timeout_not_a_site_crawl_timeout(db):
    """SPIDER_TIMEOUT is tuned for a whole-site crawl (~1600s).

    Inheriting it here let a single black-holing domain hold one of the three
    shared background workers for half an hour, starving geolocation and BANT
    extraction behind it. This fetches ONE root page.
    """
    from app import config

    assert svc.FETCH_TIMEOUT_SECONDS <= 30
    assert svc.FETCH_TIMEOUT_SECONDS < config.SPIDER_TIMEOUT / 10


# ── Failure attribution (review finding M2) ──────────────────────────────────


def test_our_own_outage_is_not_cached_against_the_domain(db):
    """A crawler that cannot run says nothing about the domain.

    Caching it would poison a table every tenant reads, and the exponential
    backoff would compound one expired API key into a 90-day blackout.
    """
    with _crawl_failed(infrastructure_ok=False):
        assert svc.resolve_company("innocent.com") is None

    db.expire_all()
    assert db.get(CompanyProfile, "innocent.com") is None, (
        "an infrastructure failure was cached as a property of the domain"
    )


def test_the_sites_own_failure_is_cached(db):
    """The contrast case: we reached the network, the site had nothing."""
    with _crawl_failed(infrastructure_ok=True):
        assert svc.resolve_company("parked.com") is None

    db.expire_all()
    row = db.get(CompanyProfile, "parked.com")
    assert row is not None and row.resolution_failed is True


# ── Normalisation at the boundary ────────────────────────────────────────────


def test_a_www_host_and_its_apex_share_one_row(db):
    """The cache key is the registrable domain, so a caller may pass any host."""
    with _crawled(), _extracted():
        first = svc.resolve_company("www.acme.com")
    with _crawled() as crawl, _extracted():
        second = svc.resolve_company("acme.com")

    assert first is not None and second is not None
    assert first.domain == second.domain == "acme.com"
    assert crawl.call_count == 0, "the www. host should already have populated the cache"


def test_jina_markdown_skips_the_markup_reader(db):
    """Jina returns MARKDOWN. Running the HTML markup reader over it can only
    ever miss, so the LLM is the correct — and only — path for that content."""
    markdown = "# Acme Corp\n\nAcme Corp does logistics."
    with (
        _crawled(markdown, is_html=False),
        patch.object(svc, "extract_from_markup") as markup,
        _extracted() as llm,
    ):
        profile = svc.resolve_company("jina-served.com")

    assert markup.call_count == 0
    assert llm.call_count == 1
    assert profile is not None and profile.source == "llm"


def test_a_stale_profile_whose_refresh_fails_backs_off(db):
    """A permanently-unreachable domain that already has a name must not
    re-crawl on every lead.

    Only a SUCCESS moves ``refresh_after``, so a stale row stays stale. The
    cached-name branch returns before the backoff check, which meant the
    failure's ``retry_after`` was recorded and then ignored — one dead domain
    with steady traffic re-crawling forever, which is precisely the per-domain
    cost leak this cache exists to prevent.
    """
    db.add(
        CompanyProfile(
            domain="gone-dark.com",
            name="Gone Dark Ltd",
            refresh_after=datetime.now(UTC) - timedelta(days=1),
        )
    )
    db.commit()

    with _crawl_failed() as first:
        assert svc.resolve_company("gone-dark.com").name == "Gone Dark Ltd"
    assert first.call_count == 1, "the first attempt past the horizon should re-crawl"

    db.expire_all()
    assert db.get(CompanyProfile, "gone-dark.com").retry_after is not None

    with _crawl_failed() as second:
        assert svc.resolve_company("gone-dark.com").name == "Gone Dark Ltd"
    assert second.call_count == 0, "the recorded backoff was ignored — every lead re-crawls"
