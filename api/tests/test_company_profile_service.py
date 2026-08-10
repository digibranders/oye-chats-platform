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


def _crawled(html=MARKED_UP):
    return patch.object(svc, "_fetch_site_html", return_value=html)


def _extracted(result=None):
    if result is None:
        result = {"name": "Acme Corp", "description": "Acme Corp does logistics."}
    return patch.object(svc, "extract_company_context", return_value=result)


# ── Cache behaviour ──────────────────────────────────────────────────────────


def test_miss_crawls_and_stores(db):
    with _crawled() as crawl, _extracted():
        profile = svc.resolve_company("acme.com", db)
    assert profile.name == "Acme Corp"
    assert crawl.call_count == 1
    assert db.get(CompanyProfile, "acme.com") is not None


def test_second_lead_on_same_domain_does_not_crawl(db):
    with _crawled(), _extracted():
        svc.resolve_company("acme.com", db)
    with _crawled() as crawl2, _extracted():
        svc.resolve_company("acme.com", db)
    assert crawl2.call_count == 0, "cache hit must not re-crawl"


def test_case_differing_domains_share_one_row(db):
    """CITEXT key — Acme.COM and acme.com are one company, one crawl."""
    with _crawled(), _extracted():
        svc.resolve_company("acme.com", db)
    with _crawled() as crawl2, _extracted():
        profile = svc.resolve_company("ACME.com", db)
    assert crawl2.call_count == 0
    assert profile.name == "Acme Corp"


# ── Markup before LLM ────────────────────────────────────────────────────────


def test_markup_is_used_and_the_llm_is_never_called(db):
    """The point of the markup pass: a site that declares its own name must not
    cost an LLM round-trip."""
    with _crawled(MARKED_UP), _extracted() as llm:
        profile = svc.resolve_company("marked.com", db)
    assert profile.name == "Acme Corp"
    assert profile.source == "markup"
    assert llm.call_count == 0


def test_llm_is_the_fallback_when_markup_is_absent(db):
    with _crawled(NO_MARKUP), _extracted() as llm:
        profile = svc.resolve_company("bare.com", db)
    assert profile.name == "Acme Corp"
    assert profile.source == "llm"
    assert llm.call_count == 1


# ── Failure caching and backoff ──────────────────────────────────────────────


def test_crawl_failure_records_backoff_rather_than_raising(db):
    with patch.object(svc, "_fetch_site_html", return_value=None):
        profile = svc.resolve_company("parked.com", db)
    assert profile is None
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
        profile = svc.resolve_company("dead.com", db)
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
        profile = svc.resolve_company("revived.com", db)
    assert profile is not None and profile.name == "Acme Corp"
    assert profile.resolution_failed is False
    assert profile.failure_count == 0, "a success must clear the failure streak"


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
        profile = svc.resolve_company("junk.com", db)
    assert profile is None
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
        profile = svc.resolve_company("flaky.com", db)
    assert profile is not None and profile.name == "Flaky Corp"
    assert crawl.call_count == 0


def test_stale_profile_is_served_without_blocking(db):
    db.add(
        CompanyProfile(
            domain="stale.com",
            name="Old Name",
            refresh_after=datetime.now(UTC) - timedelta(days=1),
        )
    )
    db.commit()
    with _crawled() as crawl, _extracted():
        profile = svc.resolve_company("stale.com", db)
    assert profile.name == "Old Name"
    assert crawl.call_count == 0, "serving stale must not block on a re-crawl"


# ── Contract ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("domain", [None, "", "   "])
def test_empty_domain_returns_none(db, domain):
    assert svc.resolve_company(domain, db) is None


def test_never_raises_when_the_crawl_blows_up(db):
    """Best-effort: this runs on a background thread behind lead capture and
    must never surface to a visitor."""
    with patch.object(svc, "_fetch_site_html", side_effect=RuntimeError("network on fire")):
        assert svc.resolve_company("explode.com", db) is None


def test_never_raises_when_the_llm_blows_up(db):
    with _crawled(NO_MARKUP), patch.object(svc, "extract_company_context", side_effect=RuntimeError("llm down")):
        assert svc.resolve_company("llm-down.com", db) is None


def test_concurrent_resolution_of_a_new_domain_does_not_raise(pg_engine, db):
    """Two leads from one company arriving together is the spec's motivating
    case. A read-then-insert loses this race with IntegrityError; the writer
    must upsert.

    The barrier inside the (patched) crawl holds both threads past their cache
    read until the other has got there too, so both are guaranteed to believe
    the row does not exist and to race on the write.
    """
    from sqlalchemy.orm import Session

    barrier = threading.Barrier(2)
    results: dict[int, str] = {}

    def gated_fetch(_domain: str) -> str:
        barrier.wait(timeout=15)
        return MARKED_UP

    def worker(idx: int) -> None:
        try:
            with (
                Session(pg_engine) as session,
                patch.object(svc, "_fetch_site_html", side_effect=gated_fetch),
                _extracted(),
            ):
                svc.resolve_company("race.com", session)
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
