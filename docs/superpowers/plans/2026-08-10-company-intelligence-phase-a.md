# Company Intelligence — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the company-resolution engine and stop the IP signal from ever presenting a carrier or subnet label as a lead's employer.

**Architecture:** A new `company_profile` table caches one resolved company per registrable domain, shared across all tenants (public web data). A new resolver service turns a domain into a name/description/logo by reusing the existing Spider→Jina crawl and the existing `extract_company_context` LLM helper, caching both successes and failures. A pure sanity filter in `ip_intel_service` rejects ISP and pool labels so tier-4 data can never masquerade as an employer. Everything runs in the background; nothing blocks a visitor request.

**Tech Stack:** FastAPI · SQLAlchemy 2.0 · Alembic · httpx (via existing crawl services) · pytest · React 19 + TypeScript · Vitest

**Spec:** `docs/superpowers/specs/2026-08-10-company-intelligence-design.md`

---

## Scope boundary

Phase A deliberately touches **no file a second developer is currently editing** (visitor-name capture / handoff inputs, unpushed). Excluded from this plan and deferred to Phase B: `lead_info` column additions, `chat_routes.lead_capture_endpoint` wiring, tier 2, and tier 3.

**Migration rule:** if another migration lands before this one merges, rebase this migration's `down_revision` onto the new head. Never allow two alembic heads — this repo has already suffered one fork (`7cb7db6`).

## File Structure

| File | Responsibility |
|---|---|
| Create: `api/app/services/domain_normalizer.py` | Email/URL → registrable domain. Pure, no I/O. |
| Create: `api/tests/test_domain_normalizer.py` | Public-suffix edge cases. |
| Modify: `api/app/db/models.py` | Add `CompanyProfile`. |
| Create: `api/alembic/versions/<rev>_company_profile.py` | Create the table. |
| Create: `api/app/services/company_profile_service.py` | Cache-first resolve: lookup → crawl → LLM → validate → store. |
| Create: `api/tests/test_company_profile_service.py` | Cache hit/miss/stale/failure-backoff, output validation. |
| Modify: `api/app/services/ip_intel_service.py` | Add `is_usable_company_name()`; apply it in `fetch_ip_intel`. |
| Modify: `api/tests/test_visitor_intelligence_shapes.py` | Cover the sanity filter. |
| Modify: `api/app/api/chat_routes.py` | Guard `_resolve_and_update_location` to one lookup per session. |
| Modify: `app/src/features/leads/VisitorIntelligenceSection.tsx` | Present tier 4 as a network signal, never as the company. |

---

## Task 1: Registrable-domain normaliser

**Files:**
- Create: `api/app/services/domain_normalizer.py`
- Test: `api/tests/test_domain_normalizer.py`

- [ ] **Step 1: Write the failing test**

```python
"""Registrable-domain extraction.

`user@mail.acme.co.uk` must resolve to `acme.co.uk`, not `co.uk` and not
`mail.acme.co.uk`. A naive rsplit on "." breaks every multi-part TLD, and
getting it wrong silently mis-attributes a lead to the wrong company — or
creates a cache entry keyed on a public suffix that then serves the wrong
profile to every lead under it.
"""

import pytest

from app.services.domain_normalizer import registrable_domain


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("acme.com", "acme.com"),
        ("www.acme.com", "acme.com"),
        ("mail.acme.com", "acme.com"),
        ("deep.sub.acme.com", "acme.com"),
        # Multi-part suffixes — the case a naive split gets wrong.
        ("acme.co.uk", "acme.co.uk"),
        ("mail.acme.co.uk", "acme.co.uk"),
        ("acme.co.in", "acme.co.in"),
        ("acme.com.au", "acme.com.au"),
        ("acme.gov.uk", "acme.gov.uk"),
        # Case and whitespace.
        ("  ACME.COM  ", "acme.com"),
        # Trailing dot (fully-qualified form).
        ("acme.com.", "acme.com"),
    ],
)
def test_registrable_domain(raw, expected):
    assert registrable_domain(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "",
        "   ",
        "acme",          # no dot
        "co.uk",         # a public suffix alone is not a company
        "com",
        ".com",
        "acme..com",
        "-.com",
        "192.168.1.1",   # an IP is not a domain
    ],
)
def test_rejects_non_company_domains(raw):
    assert registrable_domain(raw) is None


def test_domain_from_email_uses_the_same_rules():
    from app.services.domain_normalizer import domain_from_email

    assert domain_from_email("Gaurav@Mail.Acme.CO.UK") == "acme.co.uk"
    assert domain_from_email("no-at-sign") is None
    assert domain_from_email(None) is None
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_domain_normalizer.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.domain_normalizer'`

- [ ] **Step 3: Implement**

Create `api/app/services/domain_normalizer.py`:

```python
"""Reduce a hostname or email address to its registrable domain.

The registrable domain is the label immediately below the public suffix —
``acme.co.uk`` from ``mail.acme.co.uk``. It is the correct cache key for a
company profile: every employee's address, whatever subdomain they sit on,
must resolve to one entry.

We carry a curated suffix set rather than depend on ``tldextract``. That
package is excellent but downloads the Public Suffix List at first use, and a
network fetch during import is not something this codebase should acquire for
a best-effort enrichment path. The set below covers the multi-part suffixes a
B2B lead realistically arrives on; extend it when a real miss is reported —
an unknown multi-part suffix degrades to "one label below the last dot",
which is wrong but harmless (a slightly over-broad cache key), never a crash.
"""

from __future__ import annotations

import ipaddress
import re

# Multi-part public suffixes. Order does not matter; the longest match wins.
_MULTI_PART_SUFFIXES: frozenset[str] = frozenset(
    {
        "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "net.uk", "sch.uk",
        "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in", "gov.in", "ac.in", "edu.in",
        "com.au", "net.au", "org.au", "edu.au", "gov.au",
        "co.nz", "net.nz", "org.nz", "govt.nz",
        "co.za", "org.za", "net.za", "gov.za",
        "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
        "com.br", "net.br", "org.br", "gov.br",
        "com.sg", "com.my", "com.hk", "com.cn", "net.cn", "org.cn", "gov.cn",
        "com.mx", "com.ar", "com.tr", "com.pk", "com.bd", "com.ph", "com.vn",
        "co.id", "co.kr", "co.il", "co.th", "com.tw", "com.sa", "com.eg",
        "co.ke", "com.ng", "com.gh",
    }
)

_LABEL_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")


def registrable_domain(host: str | None) -> str | None:
    """Return the registrable domain for ``host``, or None if there isn't one.

    None means "this is not a company domain" — an empty value, a bare label,
    a public suffix on its own, an IP address, or anything with a malformed
    label. Callers treat None as "no company", never as an error.
    """
    if not host:
        return None

    value = host.strip().lower().rstrip(".")
    if not value or "." not in value:
        return None

    # An IP literal is never a company domain.
    try:
        ipaddress.ip_address(value)
        return None
    except ValueError:
        pass

    labels = value.split(".")
    if not all(_LABEL_RE.match(label) for label in labels):
        return None

    # Longest known multi-part suffix wins, so acme.co.uk beats a .uk reading.
    last_two = ".".join(labels[-2:])
    if last_two in _MULTI_PART_SUFFIXES:
        if len(labels) < 3:
            return None  # the suffix alone — no registrable name below it
        return ".".join(labels[-3:])

    if len(labels) < 2:
        return None
    return last_two


def domain_from_email(email: str | None) -> str | None:
    """Registrable domain of an email address, or None."""
    if not email or "@" not in email:
        return None
    return registrable_domain(email.rsplit("@", 1)[-1])
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd api && uv run pytest tests/test_domain_normalizer.py -q`
Expected: PASS

- [ ] **Step 5: Lint and commit**

```bash
cd api && uv run ruff check app/services/domain_normalizer.py tests/test_domain_normalizer.py && uv run ruff format app/services/domain_normalizer.py tests/test_domain_normalizer.py
git add api/app/services/domain_normalizer.py api/tests/test_domain_normalizer.py
git commit -m "feat: registrable-domain normaliser for company resolution"
```

---

## Task 2: `CompanyProfile` model and migration

**Files:**
- Modify: `api/app/db/models.py`
- Create: `api/alembic/versions/<rev>_company_profile.py`

- [ ] **Step 1: Add the model**

Append to `api/app/db/models.py` (place it near `LeadInfo`):

```python
class CompanyProfile(Base):
    """One resolved company per registrable domain, shared across all tenants.

    This cache is deliberately NOT scoped to a client. It holds only public
    web data about a company, so there is nothing to leak between tenants, and
    sharing it means a popular domain is crawled once for the whole platform
    rather than once per customer.

    Failures are cached too: a dead or parked domain records
    ``resolution_failed`` with a ``retry_after`` backoff, so one bad domain
    costs a single crawl instead of one per lead that arrives from it.
    """

    __tablename__ = "company_profile"

    domain = Column(String, primary_key=True)
    name = Column(String, nullable=True)
    description = Column(Text, nullable=True)
    logo_url = Column(String, nullable=True)

    resolution_failed = Column(Boolean, nullable=False, server_default="false")
    # Set only when resolution_failed — gates re-crawl attempts.
    retry_after = Column(DateTime(timezone=True), nullable=True)
    # Lazy refresh horizon for a SUCCESSFUL profile.
    refresh_after = Column(DateTime(timezone=True), nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
```

- [ ] **Step 2: Generate the migration**

Run: `cd api && uv run alembic revision --autogenerate -m "company profile cache"`
Expected: a new file under `api/alembic/versions/` creating `company_profile`.

- [ ] **Step 3: Review the generated migration by hand**

Open the generated file. Confirm it ONLY creates `company_profile` — autogenerate sometimes sweeps in unrelated drift. Delete any operation that is not this table. Confirm `down_revision` points at the current head (`uv run alembic heads`).

- [ ] **Step 4: Apply and verify**

```bash
cd api && uv run alembic upgrade head && uv run alembic check
```
Expected: upgrade runs; `alembic check` reports "No new upgrade operations detected."

- [ ] **Step 5: Verify downgrade works**

```bash
cd api && uv run alembic downgrade -1 && uv run alembic upgrade head
```
Expected: both succeed. A migration that cannot be reversed is a migration you cannot safely deploy.

- [ ] **Step 6: Commit**

```bash
git add api/app/db/models.py api/alembic/versions/
git commit -m "feat: company_profile table — cross-tenant domain cache"
```

---

## Task 3: Company profile resolver

**Files:**
- Create: `api/app/services/company_profile_service.py`
- Test: `api/tests/test_company_profile_service.py`

- [ ] **Step 1: Write the failing test**

```python
"""Cache-first company resolution.

The expensive path (crawl + LLM) must run at most once per domain. Everything
else — a fresh hit, a stale hit, a previously-failed domain inside its backoff
window — must return without touching the network.
"""

from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import pytest

from app.db.models import CompanyProfile
from app.services import company_profile_service as svc

pytestmark = pytest.mark.skipif(
    not __import__("os").getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL"
)


def _crawled(html="<html><title>Acme Corp</title><body>We do logistics.</body></html>"):
    return patch.object(svc, "_fetch_site_html", return_value=html)


def _extracted(result={"name": "Acme Corp", "description": "Acme Corp does logistics."}):
    return patch.object(svc, "extract_company_context", return_value=result)


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


def test_failed_domain_is_not_recrawled_during_backoff(db):
    db.add(
        CompanyProfile(
            domain="dead.com",
            resolution_failed=True,
            retry_after=datetime.now(UTC) + timedelta(hours=6),
        )
    )
    db.flush()
    with _crawled() as crawl, _extracted():
        profile = svc.resolve_company("dead.com", db)
    assert profile is None
    assert crawl.call_count == 0


def test_failed_domain_is_retried_after_backoff_expires(db):
    db.add(
        CompanyProfile(
            domain="revived.com",
            resolution_failed=True,
            retry_after=datetime.now(UTC) - timedelta(hours=1),
        )
    )
    db.flush()
    with _crawled(), _extracted():
        profile = svc.resolve_company("revived.com", db)
    assert profile is not None and profile.name == "Acme Corp"


def test_crawl_failure_records_backoff_rather_than_raising(db):
    with patch.object(svc, "_fetch_site_html", return_value=None):
        profile = svc.resolve_company("parked.com", db)
    assert profile is None
    row = db.get(CompanyProfile, "parked.com")
    assert row.resolution_failed is True
    assert row.retry_after is not None


@pytest.mark.parametrize(
    "bad",
    [
        None,
        {"name": "", "description": "x"},
        {"name": "   ", "description": "x"},
        {"name": "A" * 200, "description": "x"},          # implausibly long
        {"name": "COMPANY NAME", "description": "x"},      # echoed the prompt
    ],
)
def test_junk_llm_output_is_rejected_and_cached_as_failure(db, bad):
    with _crawled(), patch.object(svc, "extract_company_context", return_value=bad):
        profile = svc.resolve_company("junk.com", db)
    assert profile is None
    assert db.get(CompanyProfile, "junk.com").resolution_failed is True


def test_stale_profile_is_served_immediately(db):
    db.add(
        CompanyProfile(
            domain="stale.com",
            name="Old Name",
            refresh_after=datetime.now(UTC) - timedelta(days=1),
        )
    )
    db.flush()
    with _crawled(), _extracted():
        profile = svc.resolve_company("stale.com", db)
    # Serving stale beats blocking a caller on a re-crawl.
    assert profile.name in ("Old Name", "Acme Corp")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_company_profile_service.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.company_profile_service'`

- [ ] **Step 3: Implement**

Create `api/app/services/company_profile_service.py`:

```python
"""Resolve a registrable domain to a company profile, cache-first.

Reuses machinery that already exists: the Spider→Jina crawl stack and
``llm_service.extract_company_context``, which is what derives a customer's
own company name during onboarding. No new vendor.

Every failure mode returns None and records a backoff. A caller must be able
to treat this as "best effort, never raises" — it runs on a background thread
behind lead capture and must never surface to a visitor.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from app.db.models import CompanyProfile
from app.services.llm_service import extract_company_context

logger = logging.getLogger(__name__)

REFRESH_INTERVAL = timedelta(days=90)
FAILURE_BACKOFF = timedelta(days=7)

# Longest plausible company name. Anything past this is the LLM narrating.
_MAX_NAME_LEN = 120
# Phrases that mean the model echoed the instructions instead of answering.
_PROMPT_ECHOES = {"company name", "company_name", "name", "unknown", "n/a", "none"}


def _fetch_site_html(domain: str) -> str | None:
    """Fetch the domain's root page. Spider first, Jina as fallback.

    Isolated as its own function so tests can patch one seam instead of two
    async HTTP clients.
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


def _valid_name(name: str | None) -> bool:
    if not name:
        return False
    cleaned = name.strip()
    if not cleaned or len(cleaned) > _MAX_NAME_LEN:
        return False
    return cleaned.lower() not in _PROMPT_ECHOES


def _extract_logo(html: str, domain: str) -> str | None:
    """Best-effort logo: og:image, else apple-touch-icon. None if neither."""
    for pattern in (
        r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)',
        r'<link[^>]+rel=["\']apple-touch-icon["\'][^>]+href=["\']([^"\']+)',
    ):
        match = re.search(pattern, html, re.IGNORECASE)
        if match:
            url = match.group(1).strip()
            if url.startswith("//"):
                return f"https:{url}"
            if url.startswith("/"):
                return f"https://{domain}{url}"
            if url.startswith("http"):
                return url
    return None


def _record_failure(session: Session, domain: str) -> None:
    row = session.get(CompanyProfile, domain)
    now = datetime.now(UTC)
    if row is None:
        row = CompanyProfile(domain=domain)
        session.add(row)
    row.resolution_failed = True
    row.retry_after = now + FAILURE_BACKOFF
    session.commit()


def resolve_company(domain: str, session: Session) -> CompanyProfile | None:
    """Return a cached or freshly-resolved profile, or None.

    None means "no company could be identified" — never an error the caller
    must handle.
    """
    if not domain:
        return None

    now = datetime.now(UTC)
    row = session.get(CompanyProfile, domain)

    if row is not None:
        if row.resolution_failed:
            if row.retry_after and row.retry_after > now:
                return None  # inside backoff — do not spend a crawl
        elif row.name:
            if not row.refresh_after or row.refresh_after > now:
                return row
            # Stale: serve it now. A refresh is a separate concern; blocking a
            # caller on a re-crawl to freshen a 90-day-old name is a bad trade.
            return row

    html = _fetch_site_html(domain)
    if not html:
        _record_failure(session, domain)
        return None

    extracted = extract_company_context(html)
    if not extracted or not _valid_name(extracted.get("name")):
        _record_failure(session, domain)
        return None

    if row is None:
        row = CompanyProfile(domain=domain)
        session.add(row)
    row.name = extracted["name"].strip()
    row.description = (extracted.get("description") or "").strip() or None
    row.logo_url = _extract_logo(html, domain)
    row.resolution_failed = False
    row.retry_after = None
    row.refresh_after = now + REFRESH_INTERVAL
    session.commit()

    logger.info("company resolved | domain=%s | name=%s", domain, row.name)
    return row
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd api && uv run pytest tests/test_company_profile_service.py -q`
Expected: PASS (skipped if `DB_URL` is unset — the DB-backed suite runs in CI)

- [ ] **Step 5: Lint, format, commit**

```bash
cd api && uv run ruff check app/services/company_profile_service.py tests/test_company_profile_service.py && uv run ruff format app/services/company_profile_service.py tests/test_company_profile_service.py
git add api/app/services/company_profile_service.py api/tests/test_company_profile_service.py
git commit -m "feat: cache-first company profile resolver"
```

---

## Task 4: IP company-name sanity filter

**Files:**
- Modify: `api/app/services/ip_intel_service.py`
- Test: `api/tests/test_visitor_intelligence_shapes.py`

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_visitor_intelligence_shapes.py`:

```python
class TestIpCompanyNameSanityFilter:
    """ipapi.is returns a company object for ISP-owned ranges too, and its
    `type` classification is not reliable — production returned
    `type=business` for `TSBB pool2`, a subnet label. Only names that could
    plausibly be an employer may ever reach an operator."""

    @pytest.mark.parametrize(
        "name",
        [
            "TSBB pool2",
            "Bharti Airtel Limited",
            "Reliance Jio Infocomm Limited",
            "Vodafone Idea Ltd. (VIL)",
            "dynamic-pool-42",
            "BSNL Broadband",
            "Some Telecom Pvt Ltd",
            "subnet-allocation-7",
            "12345",
            "",
            None,
        ],
    )
    def test_rejects_carriers_and_pool_labels(self, name):
        from app.services.ip_intel_service import is_usable_company_name

        assert is_usable_company_name(name) is False

    @pytest.mark.parametrize(
        "name",
        ["Microsoft Corporation", "Infosys Limited", "Acme Corp", "Zomato"],
    )
    def test_accepts_plausible_employers(self, name):
        from app.services.ip_intel_service import is_usable_company_name

        assert is_usable_company_name(name) is True

    def test_isp_payload_yields_no_company_name(self):
        """An `isp` payload must come back with company_name stripped, so no
        consumer can render a carrier as the visitor's employer."""
        payload = {
            "company": {"name": "Bharti Airtel Limited", "domain": "airtel.in", "type": "isp"},
            "asn": {"asn": 24560, "org": "Bharti Airtel"},
            "is_vpn": False,
        }
        result = self._fetch(payload) if hasattr(self, "_fetch") else None
        if result is None:  # reuse the fetch helper from the class above
            from tests.test_visitor_intelligence_shapes import TestFetchIpIntelFlattening

            result = TestFetchIpIntelFlattening()._fetch(payload)
        assert result["company_name"] is None
        # The network operator is still available, just not as "the company".
        assert result["asn_org"] == "Bharti Airtel"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && uv run pytest tests/test_visitor_intelligence_shapes.py::TestIpCompanyNameSanityFilter -q`
Expected: FAIL — `ImportError: cannot import name 'is_usable_company_name'`

- [ ] **Step 3: Implement the filter**

Add to `api/app/services/ip_intel_service.py`, above `fetch_ip_intel`:

```python
# Tokens that mark a "company" name as network infrastructure rather than an
# employer. ipapi.is classified "TSBB pool2" as type=business in production,
# so the type field alone cannot be trusted.
_NETWORK_NAME_TOKENS = (
    "pool", "subnet", "broadband", "telecom", "telecommunication", "isp",
    "internet service", "cellular", "mobile", "wireless", "dsl", "fibre",
    "fiber", "cable", "network", "communications", "comunicaciones",
)

# Known consumer carriers. Their corporate names look plausible, so token
# matching alone would let them through.
_KNOWN_CARRIERS = (
    "airtel", "jio", "vodafone", "bsnl", "mtnl", "idea cellular",
    "tata teleservices", "act fibernet", "hathway", "excitel",
)

_MIN_COMPANY_NAME_LEN = 3


def is_usable_company_name(name: str | None) -> bool:
    """True only if ``name`` could plausibly be a visitor's employer.

    Deliberately conservative: a false positive here puts a carrier's name in
    front of a salesperson as though it were the lead's company. A false
    negative merely shows "not identified", which is honest.
    """
    if not name:
        return False
    cleaned = name.strip()
    if len(cleaned) < _MIN_COMPANY_NAME_LEN:
        return False
    lowered = cleaned.lower()
    if not any(char.isalpha() for char in cleaned):
        return False
    if any(carrier in lowered for carrier in _KNOWN_CARRIERS):
        return False
    return not any(token in lowered for token in _NETWORK_NAME_TOKENS)
```

- [ ] **Step 4: Apply it inside `fetch_ip_intel`**

In `api/app/services/ip_intel_service.py`, replace the `company_name` line of the return dict:

```python
    company_name = company.get("name")
    company_type = company.get("type")
    # Only a `business` classification whose NAME survives the sanity filter is
    # allowed to leave this function as a company. Everything else keeps its
    # network identity (asn_org) and reports no company at all.
    if company_type != "business" or not is_usable_company_name(company_name):
        company_name = None

    return {
        "company_name": company_name,
        "company_domain": company.get("domain") if company_name else None,
        "company_type": company_type,
        "asn": asn.get("asn"),
        "asn_org": asn.get("org") or asn.get("descr"),
        "is_vpn": bool(data.get("is_vpn", False)),
        "is_proxy": bool(data.get("is_proxy", False)),
        "is_tor": bool(data.get("is_tor", False)),
        "is_datacenter": bool(data.get("is_datacenter", False)),
        "is_abuser": bool(data.get("is_abuser", False)),
    }
```

- [ ] **Step 5: Run the whole shapes suite**

Run: `cd api && uv run pytest tests/test_visitor_intelligence_shapes.py -q`
Expected: PASS. The pre-existing `test_nested_company_object_is_flattened_to_primitives` asserts `company_name == "Google LLC"` on a `type=hosting` payload — that expectation is now wrong by design. Update it to assert `company_name is None` and `asn_org == "Google LLC"`, with a comment explaining that hosting is not an employer.

- [ ] **Step 6: Run the full suite, lint, commit**

```bash
cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest -q
git add api/app/services/ip_intel_service.py api/tests/test_visitor_intelligence_shapes.py
git commit -m "fix: never present an ISP or subnet label as a visitor's company"
```

---

## Task 5: One IP lookup per session

**Files:**
- Modify: `api/app/api/chat_routes.py`
- Test: `api/tests/api/test_chat_routes_ip_intel.py`

Production measured 6 ipapi.is calls across 4 sessions — one per chat message. A visitor's IP cannot change mid-session, so every call after the first is waste against a quota-limited vendor.

- [ ] **Step 1: Write the failing test**

Append to `api/tests/api/test_chat_routes_ip_intel.py`:

```python
def test_second_call_for_same_session_does_not_hit_the_vendor(db):
    """`_resolve_and_update_location` fires on every chat message. The IP
    cannot change within a session, so the paid lookup must run once."""
    client = Client(id=3, email="once@example.com", name="Once", api_key="once-key")
    db.add(client)
    db.flush()
    bot = Bot(id=3, client_id=3, bot_key="bot-once123", name="Once Bot", is_active=True)
    db.add(bot)
    db.commit()

    session_id = "test-session-once"
    db.add(ChatSession(id=session_id, bot_id=bot.id, status="bot"))
    db.commit()

    class MockSessionManager:
        def __init__(self, db):
            self.db = db

        def __enter__(self):
            return self.db

        def __exit__(self, *args):
            pass

    with (
        patch(
            "app.api.chat_routes.fetch_ip_intel",
            return_value={"company_name": None, "asn_org": "Airtel", "is_vpn": False},
        ) as fetch,
        patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo")),
        patch("app.api.chat_routes.get_session", return_value=MockSessionManager(db)),
    ):
        _resolve_and_update_location(session_id, "8.8.8.8")
        _resolve_and_update_location(session_id, "8.8.8.8")

    assert fetch.call_count == 1, "the paid IP lookup must run once per session"
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd api && DB_URL=<local Postgres> uv run pytest tests/api/test_chat_routes_ip_intel.py::test_second_call_for_same_session_does_not_hit_the_vendor -q`
Expected: FAIL — `assert 2 == 1`

- [ ] **Step 3: Implement the guard**

In `api/app/api/chat_routes.py`, inside `_resolve_and_update_location`, immediately before `ip_intel = fetch_ip_intel(ip_address)`:

```python
        # A visitor's IP cannot change within a session, so the paid lookup
        # runs once. This function fires on EVERY chat message; without this
        # guard a 20-message conversation burned 20 ipapi.is calls against a
        # quota-limited vendor (measured: 6 calls for 4 sessions in prod).
        with get_session() as session:
            existing = session.query(ChatSession).filter(ChatSession.id == session_id).first()
            already_resolved = bool(existing and (existing.visitor_metadata or {}).get("ip_intel"))
        if already_resolved:
            return

        ip_intel = fetch_ip_intel(ip_address)
```

Note the early `return` skips the geolocation block below it as well — that block already refuses to overwrite a resolved `location`, so its two HTTP calls were equally wasted on repeat invocations.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd api && DB_URL=<local Postgres> uv run pytest tests/api/test_chat_routes_ip_intel.py -q`
Expected: PASS (all tests in the file, including the two pre-existing ones)

- [ ] **Step 5: Lint and commit**

```bash
cd api && uv run ruff check app/api/chat_routes.py && uv run ruff format --check .
git add api/app/api/chat_routes.py api/tests/api/test_chat_routes_ip_intel.py
git commit -m "perf: resolve visitor IP intel once per session, not once per message"
```

---

## Task 6: Present tier 4 as a network signal, not a company

**Files:**
- Modify: `app/src/features/leads/VisitorIntelligenceSection.tsx`

With Task 4 in place, `company_name` arrives as `null` for every ISP and pool label, so the panel's company card will simply not render for them. This task makes the *remaining* presentation honest.

- [ ] **Step 1: Rename the section and split the two ideas**

In `VisitorIntelligenceSection.tsx`, change the section title from `Visitor Intelligence` to `Network & risk`, and change `CompanySignal` so the company block renders **only** when `company_name` is present. When it is absent but `asn_org` is, render the network operator under a plainly different label:

```tsx
{companyName ? (
  <div className="flex items-start gap-2.5 text-[13px] text-[var(--ds-text)]">
    <Building2 size={15} className="mt-0.5 shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
    <span className="min-w-0">
      <span className="block break-words font-medium">{companyName}</span>
      {companyDomain && (
        <span className="block break-all text-[12px] text-[var(--ds-text-subtle)]">{companyDomain}</span>
      )}
      <span className="mt-1 block text-[11px] text-[var(--ds-text-subtle)]">
        Derived from the visitor&rsquo;s network &mdash; not a confirmed employer.
      </span>
    </span>
  </div>
) : asnOrg ? (
  <p className="text-[12px] text-[var(--ds-text-subtle)]">
    Connecting via <span className="text-[var(--ds-text)]">{asnOrg}</span>
  </p>
) : null}
```

- [ ] **Step 2: Update the empty state**

Replace the "No company signal resolved…" copy with wording that matches what the panel now claims:

```tsx
<p className="rounded-xl border border-[var(--ds-border)] p-4 text-[12px] text-[var(--ds-text-subtle)]">
  No network details resolved for this visitor.
</p>
```

- [ ] **Step 3: Verify in the browser**

```bash
cd app && npm run dev
```
Open a Professional-plan lead whose session has `ip_intel`. Confirm an ISP-backed session now shows `Connecting via Bharti Airtel Limited` and **no** company card, and that the section heading reads `Network & risk`.

- [ ] **Step 4: Run checks and commit**

```bash
cd app && npx tsc --noEmit && npm run lint && npm run build
git add app/src/features/leads/VisitorIntelligenceSection.tsx
git commit -m "fix(leads): present IP data as network context, never as the company"
```

---

## Task 7: Full verification

- [ ] **Step 1: Backend**

```bash
cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest -q
```
Expected: all clean, zero failures. **Stop any local API server first** — a running uvicorn competes for DB connections and produces ~150 spurious errors that look like real failures.

- [ ] **Step 2: Frontend**

```bash
cd app && npm run lint && npx tsc --noEmit && npm run build
```
Expected: all clean.

- [ ] **Step 3: Confirm a single alembic head**

```bash
cd api && uv run alembic heads
```
Expected: exactly one head. If a second developer's migration landed first, rebase this plan's migration `down_revision` onto it — never leave two heads.

- [ ] **Step 4: Verify branch before pushing**

```bash
git branch --show-current
```
Expected: `development`.

---

## Self-Review

**1. Spec coverage.** Phase A items in the spec map to tasks: domain normaliser → Task 1; `company_profile` table → Task 2; cache-first resolver with failure backoff, stale serving, and output validation → Task 3; IP sanity filter → Task 4; tier-4 display separation → Task 6. The per-session IP guard (Task 5) is not in the spec's phase list — it is included because it lives in the same function Task 4 touches, and leaving a measured 33% waste in place while editing that file would be perverse. Phase B items (`lead_info` columns, `chat_routes` wiring, tiers 2 and 3) are explicitly out of scope and called out at the top.

**2. Placeholder scan.** No TBD/TODO. Every code step carries complete code. The one intentionally non-literal token is `<rev>` in the migration filename, which Alembic generates, and `<local Postgres>` for a connection string that varies per machine.

**3. Type consistency.** `registrable_domain` / `domain_from_email` (Task 1) are used nowhere else in Phase A — they are consumed in Phase B, which is correct and deliberate. `resolve_company(domain, session) -> CompanyProfile | None` (Task 3) matches its tests. `is_usable_company_name(name) -> bool` (Task 4) matches both its tests and its call site inside `fetch_ip_intel`. `CompanyProfile` field names in the model (Task 2) match every reference in Task 3's implementation and tests: `domain`, `name`, `description`, `logo_url`, `resolution_failed`, `retry_after`, `refresh_after`.

**4. Known consequence to watch.** Task 4 changes an existing test's expectation (`test_nested_company_object_is_flattened_to_primitives` asserts `company_name == "Google LLC"` on a `type=hosting` payload). Step 5 of that task calls this out explicitly so it is updated deliberately rather than discovered as a surprise failure.
