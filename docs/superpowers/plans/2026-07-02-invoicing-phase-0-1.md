# Invoicing Phases 0–1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the invoicing foundation — feature flags, GSTIN validation, super-admin-editable seller profile, buyer tax-identity fields on `Client`, and the extended `Invoice` schema + gapless-number counters — per [docs/billing/2026-07-02-invoicing-implementation-plan-v2.md](../../billing/2026-07-02-invoicing-implementation-plan-v2.md) Phases 0–1.

**Architecture:** Seller identity lives in the existing `pricing_config` key/value table (key `billing.seller_profile`) behind a typed accessor + validator, edited via new super-admin routes. Buyer identity is new nullable columns on `clients`. The `invoices` table gains additive tax/document columns (existing rows become `invoice_type='legacy'` via server default) plus an `invoice_counters` table for per-FY gapless numbering. All changes are flag-gated (`INVOICING_V2_ENABLED`) and additive/reversible.

**Tech Stack:** FastAPI · SQLAlchemy 2.0 · Alembic · Pydantic · pytest. Repo: `oye-chats-platform`, branch `development`, all paths below relative to `api/` unless noted.

**Environment facts (do not skip):**
- `uv run` is broken locally — run everything with `.venv/bin/python`. Tests: `cd api && .venv/bin/python -m pytest <file> --no-cov`. Lint: `.venv/bin/python -m ruff check .` and `.venv/bin/python -m ruff format .`
- PG-backed tests need `DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres` (they skip without it; if unreachable run `brew services restart postgresql@16`). The shared `db`/`pg_engine` fixtures live in `tests/conftest.py`.
- Alembic uses the same `DB_URL` env: `DB_URL=... .venv/bin/python -m alembic upgrade head`
- Current alembic head: `5e5af3f3259d`. Commit after every task; never push; stay on `development`.

---

## Phase 0 — flags, GSTIN validator, seller profile

### Task 1: Feature flags

**Files:**
- Modify: `app/config.py` (append near `PRORATED_UPGRADES_ENABLED`, ~line 370)
- Test: `tests/test_invoicing_flags.py`

- [ ] **Step 1: Write the failing test**

```python
"""Invoicing feature flags default OFF so nothing changes until rollout."""

from app import config


def test_invoicing_flags_default_off():
    assert config.INVOICING_V2_ENABLED is False
    assert config.INVOICE_EMAILS_ENABLED is False
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `cd api && .venv/bin/python -m pytest tests/test_invoicing_flags.py -v --no-cov`
Expected: FAIL `AttributeError: module 'app.config' has no attribute 'INVOICING_V2_ENABLED'`

- [ ] **Step 3: Implement** — in `app/config.py`, directly under the `PRORATED_UPGRADES_ENABLED` block (uses the module's existing `_env_flag` helper):

```python
# INVOICING_V2_ENABLED (default OFF): gates the own-issued GST invoicing track
# (see docs/billing/2026-07-02-invoicing-implementation-plan-v2.md). While off,
# webhook handlers keep writing legacy payment-history rows only.
INVOICING_V2_ENABLED = _env_flag("INVOICING_V2_ENABLED", default=False)

# INVOICE_EMAILS_ENABLED (default OFF): customer-facing invoice emails. Kept
# separate from INVOICING_V2_ENABLED so invoices can run in shadow mode
# (generated + stored, admin-visible, not emailed) during verification.
INVOICE_EMAILS_ENABLED = _env_flag("INVOICE_EMAILS_ENABLED", default=False)
```

- [ ] **Step 4: Run test — expect PASS**, then `.venv/bin/python -m ruff check . && .venv/bin/python -m ruff format .`

- [ ] **Step 5: Commit**

```bash
git add api/app/config.py api/tests/test_invoicing_flags.py
git commit -m "feat(invoicing): add INVOICING_V2_ENABLED + INVOICE_EMAILS_ENABLED flags (default off)"
```

### Task 2: GSTIN validator (pure, checksum-correct)

**Files:**
- Create: `app/core/gstin.py`
- Test: `tests/test_gstin.py`

- [ ] **Step 1: Write the failing tests**

```python
"""GSTIN format + checksum validation (15-char, Rule 46 buyer/seller identity).

Layout: SS PPPPPPPPPP E Z C — SS = state code (01-38 or 97), 10-char PAN,
E = entity code, literal 'Z', C = mod-36 check character.
"""

import pytest

from app.core.gstin import compute_check_char, is_valid_gstin


def test_known_valid_gstin():
    # Widely-published valid example (Maharashtra partnership firm).
    assert is_valid_gstin("27AAPFU0939F1ZV") is True


def test_lowercase_and_whitespace_normalized():
    assert is_valid_gstin("  27aapfu0939f1zv ") is True


def test_wrong_check_digit_rejected():
    assert is_valid_gstin("27AAPFU0939F1ZW") is False


@pytest.mark.parametrize(
    "bad",
    [
        "",                     # empty
        "27AAPFU0939F1Z",       # 14 chars
        "27AAPFU0939F1ZVX",     # 16 chars
        "00AAPFU0939F1ZV",      # state 00 invalid
        "99AAPFU0939F1ZV",      # state 99 invalid (97 is the only >38 code)
        "27AAPFU0939F1YV",      # 14th char must be literal 'Z'
        "271APFU0939F1ZV",      # PAN must start with 5 letters
    ],
)
def test_structurally_invalid_rejected(bad):
    assert is_valid_gstin(bad) is False


def test_compute_check_char_roundtrip():
    body = "27AAPFU0939F1Z"
    assert body + compute_check_char(body) == "27AAPFU0939F1ZV"
```

- [ ] **Step 2: Run — expect FAIL** (`ModuleNotFoundError: app.core.gstin`)

Run: `.venv/bin/python -m pytest tests/test_gstin.py -v --no-cov`

- [ ] **Step 3: Implement `app/core/gstin.py`**

```python
"""GSTIN validation — structure + mod-36 checksum.

Pure functions, no I/O. Used to validate the seller profile's GSTIN and
customer GSTINs captured for B2B tax invoices.
"""

from __future__ import annotations

import re

_GSTIN_RE = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
# GST state codes 01–38 plus 97 (Other Territory).
_VALID_STATE_CODES = {f"{i:02d}" for i in range(1, 39)} | {"97"}


def compute_check_char(body14: str) -> str:
    """Mod-36 check character over the first 14 GSTIN characters."""
    total = 0
    for i, ch in enumerate(body14):
        value = _CHARS.index(ch)
        product = value * (2 if i % 2 else 1)
        total += product // 36 + product % 36
    return _CHARS[(36 - total % 36) % 36]


def normalize_gstin(raw: str) -> str:
    return raw.strip().upper()


def is_valid_gstin(raw: str) -> bool:
    gstin = normalize_gstin(raw or "")
    if not _GSTIN_RE.match(gstin):
        return False
    if gstin[:2] not in _VALID_STATE_CODES:
        return False
    return gstin[-1] == compute_check_char(gstin[:-1])
```

- [ ] **Step 4: Run — expect all PASS.** If `test_known_valid_gstin` fails, verify the algorithm (index-even → factor 1, index-odd → factor 2) rather than editing the fixture: cross-check by computing the check char of another published GSTIN before touching anything.

- [ ] **Step 5: Lint + commit**

```bash
git add api/app/core/gstin.py api/tests/test_gstin.py
git commit -m "feat(invoicing): GSTIN structure + mod-36 checksum validator"
```

### Task 3: Seller profile — typed accessor over `pricing_config`

**Files:**
- Create: `app/services/seller_profile_service.py`
- Test: `tests/test_seller_profile.py`

Design: one JSONB document under `pricing_config.key = "billing.seller_profile"`. Reads go through `get_seller_profile(session)` returning a frozen dataclass with safe defaults (GST mode OFF until a GSTIN is saved). Writes go through `save_seller_profile(session, payload, actor_id)` which validates and upserts. No cache — invoice finalization is not a hot path.

- [ ] **Step 1: Write the failing tests** (uses the shared PG `db` fixture from `tests/conftest.py`; add the module-level skip guard used by other PG tests)

```python
"""Seller profile service — defaults, validation, persistence."""

import os

import pytest

from app.services.seller_profile_service import (
    SELLER_PROFILE_KEY,
    SellerProfileError,
    get_seller_profile,
    save_seller_profile,
)

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def test_defaults_when_unconfigured(db):
    profile = get_seller_profile(db)
    assert profile.configured is False
    assert profile.gst_enabled is False
    assert profile.trade_name == "OyeChats"
    assert profile.sac_code == "997331"
    assert profile.tax_rate_bps == 1800
    assert profile.price_inclusive is True
    assert profile.invoice_prefix == "DB"


def test_save_and_reload_roundtrip(db):
    save_seller_profile(
        db,
        {
            "legal_name": "Digibranders Pvt Ltd",
            "trade_name": "OyeChats",
            "gstin": "27AAPFU0939F1ZV",
            "address_lines": ["1 Example Road", "Mumbai 400001"],
        },
        actor_id=1,
    )
    profile = get_seller_profile(db)
    assert profile.configured is True
    assert profile.gst_enabled is True
    assert profile.legal_name == "Digibranders Pvt Ltd"
    # State code derives from the GSTIN's first two digits.
    assert profile.state_code == "27"


def test_invalid_gstin_rejected(db):
    with pytest.raises(SellerProfileError, match="GSTIN"):
        save_seller_profile(db, {"legal_name": "X Ltd", "gstin": "27AAPFU0939F1ZW"}, actor_id=1)


def test_legal_name_required(db):
    with pytest.raises(SellerProfileError, match="legal_name"):
        save_seller_profile(db, {"legal_name": "  ", "gstin": None}, actor_id=1)


def test_prefix_bounds(db):
    # 4-char prefix would make DB/25-26/000001-style numbers exceed 16 chars (Rule 46).
    with pytest.raises(SellerProfileError, match="prefix"):
        save_seller_profile(db, {"legal_name": "X Ltd", "invoice_prefix": "ABCD"}, actor_id=1)


def test_no_gstin_means_receipt_mode(db):
    save_seller_profile(db, {"legal_name": "Digibranders Pvt Ltd", "gstin": None}, actor_id=1)
    profile = get_seller_profile(db)
    assert profile.configured is True
    assert profile.gst_enabled is False
```

- [ ] **Step 2: Run — expect FAIL** (`ModuleNotFoundError`)

Run: `DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest tests/test_seller_profile.py -v --no-cov`

- [ ] **Step 3: Implement `app/services/seller_profile_service.py`**

```python
"""Seller-of-record profile — the legal identity printed on every invoice.

Stored as one JSONB document in ``pricing_config`` (key
``billing.seller_profile``) so it is super-admin editable at runtime and an
entity change (e.g. OyeChats getting its own GST registration) is a data
edit, never a deploy. Snapshotted onto each invoice at finalize time, so
edits never mutate already-issued documents.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.core.gstin import is_valid_gstin, normalize_gstin
from app.db.models import PricingConfig

SELLER_PROFILE_KEY = "billing.seller_profile"

# Rule 46(b): serial ≤16 chars. "PPP/YY-YY/NNNNNN" = len(prefix) + 13.
_MAX_PREFIX_LEN = 3
_MAX_RATE_BPS = 4000  # sanity ceiling, not a tax opinion


class SellerProfileError(ValueError):
    """Raised when a seller-profile payload fails validation."""


@dataclass(frozen=True)
class SellerProfile:
    configured: bool = False
    legal_name: str = ""
    trade_name: str = "OyeChats"
    gstin: str | None = None
    address_lines: list[str] = field(default_factory=list)
    state_code: str | None = None
    country: str = "IN"
    sac_code: str = "997331"
    tax_rate_bps: int = 1800
    price_inclusive: bool = True
    lut_active: bool = False
    lut_number: str | None = None
    invoice_prefix: str = "DB"
    logo_url: str | None = None

    @property
    def gst_enabled(self) -> bool:
        """GST tax-invoice mode; without a GSTIN we issue plain receipts."""
        return bool(self.gstin)


def get_seller_profile(session: Session) -> SellerProfile:
    row = session.get(PricingConfig, SELLER_PROFILE_KEY)
    if row is None or not isinstance(row.value, dict):
        return SellerProfile()
    defaults = SellerProfile()
    data: dict[str, Any] = row.value
    return SellerProfile(
        configured=True,
        legal_name=str(data.get("legal_name", "")),
        trade_name=str(data.get("trade_name", defaults.trade_name)),
        gstin=data.get("gstin") or None,
        address_lines=[str(x) for x in data.get("address_lines", [])],
        state_code=data.get("state_code") or None,
        country=str(data.get("country", defaults.country)),
        sac_code=str(data.get("sac_code", defaults.sac_code)),
        tax_rate_bps=int(data.get("tax_rate_bps", defaults.tax_rate_bps)),
        price_inclusive=bool(data.get("price_inclusive", defaults.price_inclusive)),
        lut_active=bool(data.get("lut_active", defaults.lut_active)),
        lut_number=data.get("lut_number") or None,
        invoice_prefix=str(data.get("invoice_prefix", defaults.invoice_prefix)),
        logo_url=data.get("logo_url") or None,
    )


def _validate(payload: dict[str, Any]) -> dict[str, Any]:
    defaults = SellerProfile()
    legal_name = str(payload.get("legal_name", "")).strip()
    if not legal_name:
        raise SellerProfileError("legal_name is required")

    gstin = payload.get("gstin")
    if gstin:
        gstin = normalize_gstin(str(gstin))
        if not is_valid_gstin(gstin):
            raise SellerProfileError("GSTIN failed format/checksum validation")
    else:
        gstin = None

    prefix = str(payload.get("invoice_prefix", defaults.invoice_prefix)).strip().upper()
    if not (1 <= len(prefix) <= _MAX_PREFIX_LEN) or not prefix.isalnum():
        raise SellerProfileError(f"invoice_prefix must be 1-{_MAX_PREFIX_LEN} alphanumeric chars (Rule 46 16-char serial limit)")

    tax_rate_bps = int(payload.get("tax_rate_bps", defaults.tax_rate_bps))
    if not 0 <= tax_rate_bps <= _MAX_RATE_BPS:
        raise SellerProfileError(f"tax_rate_bps must be between 0 and {_MAX_RATE_BPS}")

    sac_code = str(payload.get("sac_code", defaults.sac_code)).strip()
    if not sac_code:
        raise SellerProfileError("sac_code is required")

    # Place of supply comparisons key off the seller state; the GSTIN's first
    # two digits are authoritative when present.
    state_code = gstin[:2] if gstin else (payload.get("state_code") or None)

    return {
        "legal_name": legal_name,
        "trade_name": str(payload.get("trade_name", defaults.trade_name)).strip() or defaults.trade_name,
        "gstin": gstin,
        "address_lines": [str(x).strip() for x in payload.get("address_lines", []) if str(x).strip()],
        "state_code": state_code,
        "country": str(payload.get("country", defaults.country)).strip().upper() or defaults.country,
        "sac_code": sac_code,
        "tax_rate_bps": tax_rate_bps,
        "price_inclusive": bool(payload.get("price_inclusive", defaults.price_inclusive)),
        "lut_active": bool(payload.get("lut_active", defaults.lut_active)),
        "lut_number": (str(payload.get("lut_number")).strip() or None) if payload.get("lut_number") else None,
        "invoice_prefix": prefix,
        "logo_url": (str(payload.get("logo_url")).strip() or None) if payload.get("logo_url") else None,
    }


def save_seller_profile(session: Session, payload: dict[str, Any], *, actor_id: int | None) -> SellerProfile:
    value = _validate(payload)
    stmt = (
        insert(PricingConfig)
        .values(key=SELLER_PROFILE_KEY, value=value, updated_by=actor_id)
        .on_conflict_do_update(
            index_elements=["key"],
            set_={"value": value, "updated_by": actor_id},
        )
    )
    session.execute(stmt)
    session.flush()
    return get_seller_profile(session)
```

- [ ] **Step 4: Run — expect all PASS** (with `DB_URL` set)

- [ ] **Step 5: Lint + commit**

```bash
git add api/app/services/seller_profile_service.py api/tests/test_seller_profile.py
git commit -m "feat(invoicing): seller-of-record profile service over pricing_config"
```

### Task 4: Super-admin seller-profile routes

**Files:**
- Modify: `app/api/superadmin_routes_v2.py` (append routes near the `/pricing-config` handlers, ~line 562)
- Test: `tests/test_seller_profile_routes.py`

- [ ] **Step 1: Write the failing tests** (TestClient pattern copied from `tests/test_superadmin_plans.py`)

```python
"""Super-admin seller-profile routes — GET defaults, PUT validate + persist + audit."""

import os
from contextlib import contextmanager
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import superadmin_routes_v2
from app.api.auth import get_superadmin

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _client(db, monkeypatch) -> TestClient:
    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(id=1, is_superadmin=True, superadmin_role="owner")
    return TestClient(app)


def test_get_returns_defaults_when_unconfigured(db, monkeypatch):
    c = _client(db, monkeypatch)
    res = c.get("/superadmin/billing/seller-profile")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["configured"] is False
    assert body["gst_enabled"] is False
    assert body["invoice_prefix"] == "DB"


def test_put_persists_and_derives_state(db, monkeypatch):
    c = _client(db, monkeypatch)
    res = c.put(
        "/superadmin/billing/seller-profile",
        json={
            "legal_name": "Digibranders Pvt Ltd",
            "gstin": "27AAPFU0939F1ZV",
            "address_lines": ["1 Example Road", "Mumbai 400001"],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["configured"] is True
    assert body["gst_enabled"] is True
    assert body["state_code"] == "27"


def test_put_rejects_bad_gstin_as_422(db, monkeypatch):
    c = _client(db, monkeypatch)
    res = c.put("/superadmin/billing/seller-profile", json={"legal_name": "X Ltd", "gstin": "BAD"})
    assert res.status_code == 422
    assert "GSTIN" in res.json()["detail"]


def test_readonly_admin_cannot_write(db, monkeypatch):
    monkeypatch.setattr(superadmin_routes_v2, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(superadmin_routes_v2.router)
    app.dependency_overrides[get_superadmin] = lambda: SimpleNamespace(id=2, is_superadmin=True, superadmin_role="readonly")
    c = TestClient(app)
    res = c.put("/superadmin/billing/seller-profile", json={"legal_name": "X Ltd"})
    assert res.status_code == 403
```

- [ ] **Step 2: Run — expect FAIL** (404s: routes don't exist)

Run: `DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest tests/test_seller_profile_routes.py -v --no-cov`

- [ ] **Step 3: Implement** — append to `app/api/superadmin_routes_v2.py` (imports go at the top of the file with the existing ones):

```python
from app.services.seller_profile_service import (
    SellerProfileError,
    get_seller_profile,
    save_seller_profile,
)
```

```python
# ── billing: seller-of-record profile ───────────────────────────────────────


class SellerProfileBody(BaseModel):
    legal_name: str
    trade_name: str | None = None
    gstin: str | None = None
    address_lines: list[str] = Field(default_factory=list)
    state_code: str | None = None
    country: str | None = None
    sac_code: str | None = None
    tax_rate_bps: int | None = None
    price_inclusive: bool | None = None
    lut_active: bool | None = None
    lut_number: str | None = None
    invoice_prefix: str | None = None
    logo_url: str | None = None


def _profile_dict(profile) -> dict[str, Any]:
    return {
        "configured": profile.configured,
        "gst_enabled": profile.gst_enabled,
        "legal_name": profile.legal_name,
        "trade_name": profile.trade_name,
        "gstin": profile.gstin,
        "address_lines": profile.address_lines,
        "state_code": profile.state_code,
        "country": profile.country,
        "sac_code": profile.sac_code,
        "tax_rate_bps": profile.tax_rate_bps,
        "price_inclusive": profile.price_inclusive,
        "lut_active": profile.lut_active,
        "lut_number": profile.lut_number,
        "invoice_prefix": profile.invoice_prefix,
        "logo_url": profile.logo_url,
    }


@router.get("/billing/seller-profile")
def read_seller_profile(_admin: Client = Depends(get_superadmin)):
    with get_session() as session:
        return _profile_dict(get_seller_profile(session))


@router.put("/billing/seller-profile")
def update_seller_profile(body: SellerProfileBody, admin: Client = Depends(get_superadmin)):
    _require_write(admin)
    with get_session() as session:
        try:
            profile = save_seller_profile(
                session,
                body.model_dump(exclude_none=True),
                actor_id=admin.id,
            )
        except SellerProfileError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        record_audit(
            session,
            actor=admin,
            action="billing.seller_profile.update",
            target_type="pricing_config",
            target_id=None,
            detail={"legal_name": profile.legal_name, "gst_enabled": profile.gst_enabled},
        )
        session.commit()
        return _profile_dict(profile)
```

Note: before running, check `record_audit`'s exact signature in `app/services/audit_service.py` and match the call to how the neighbouring `/pricing-config` PUT invokes it (~line 599) — keyword names there are authoritative over the sketch above.

- [ ] **Step 4: Run — expect all PASS**

- [ ] **Step 5: Lint + commit**

```bash
git add api/app/api/superadmin_routes_v2.py api/tests/test_seller_profile_routes.py
git commit -m "feat(invoicing): superadmin GET/PUT /billing/seller-profile with audit"
```

### Task 5: Phase 0 gate — full suite + CODE REVIEW

- [ ] **Step 1:** Full checks:

```bash
cd api && .venv/bin/python -m ruff check . && .venv/bin/python -m ruff format --check . \
  && DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest --no-cov -q
```
Expected: 0 lint errors, full suite green (baseline was 718 + new tests).

- [ ] **Step 2: Code review gate.** Run the `code-review` skill (or `superpowers:requesting-code-review`) over the Phase 0 diff: `git diff <commit-before-task-1>..HEAD`. Fix every confirmed finding, re-run checks, amend/commit fixes.

- [ ] **Step 3:** Report Phase 0 results to the user (checks summary + review findings + fixes) before starting Phase 1.

---

## Phase 1 — buyer identity + invoice schema

### Task 6: Client billing fields (model + migration)

**Files:**
- Modify: `app/db/models.py` (Client, insert after `company_name`, ~line 31)
- Create: `alembic/versions/b7e2d4f9a1c6_client_billing_tax_identity.py`
- Test: `tests/test_client_billing_fields.py`

- [ ] **Step 1: Write the failing test**

```python
"""Client buyer-identity columns exist and round-trip."""

import os

import pytest

from app.db.models import Client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def test_billing_fields_roundtrip(db):
    c = Client(
        name="Acme",
        email="billing-fields@test.example",
        api_key="test-key-billing-fields",
        legal_name="Acme Industries Pvt Ltd",
        gstin="27AAPFU0939F1ZV",
        billing_address={"line1": "1 Test Lane", "city": "Mumbai", "postal_code": "400001"},
        billing_country="IN",
        billing_state_code="27",
        billing_email="accounts@acme.example",
    )
    db.add(c)
    db.flush()
    got = db.get(Client, c.id)
    assert got.gstin == "27AAPFU0939F1ZV"
    assert got.billing_address["city"] == "Mumbai"
    assert got.billing_state_code == "27"


def test_billing_fields_default_null(db):
    c = Client(name="Bare", email="bare-billing@test.example", api_key="test-key-bare-billing")
    db.add(c)
    db.flush()
    assert c.gstin is None and c.billing_state_code is None and c.billing_country is None
```

- [ ] **Step 2: Run — expect FAIL** (`TypeError: 'legal_name' is an invalid keyword argument`)

- [ ] **Step 3: Add columns to `Client`** in `app/db/models.py` after `company_name` (line 31):

```python
    # ── Buyer tax identity (invoicing v2) — all nullable; captured in account
    # settings / at checkout. billing_state_code is the GST place-of-supply
    # input (Circular 242/36/2024 makes state mandatory for online B2C —
    # enforced at checkout, not at the column level, to keep signup friction
    # unchanged).
    legal_name = Column(String, nullable=True)
    gstin = Column(String(15), nullable=True)
    billing_address = Column(JSONB, nullable=True)  # {line1, line2, city, postal_code}
    billing_country = Column(String(2), nullable=True)  # ISO-2, e.g. "IN"
    billing_state_code = Column(String(2), nullable=True)  # GST state code, e.g. "27"
    billing_email = Column(String, nullable=True)  # falls back to login email
```

- [ ] **Step 4: Create migration** `alembic/versions/b7e2d4f9a1c6_client_billing_tax_identity.py` (convention per `5e5af3f3259d_add_calcom_url_to_bots.py`):

```python
"""client_billing_tax_identity

Buyer-side tax identity for invoicing v2 (plan: docs/billing/
2026-07-02-invoicing-implementation-plan-v2.md Phase 1). All nullable —
capture is progressive (settings / checkout), never blocks signup.

Revision ID: b7e2d4f9a1c6
Revises: 5e5af3f3259d
Create Date: 2026-07-02

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "b7e2d4f9a1c6"
down_revision: str | Sequence[str] | None = "5e5af3f3259d"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("clients", sa.Column("legal_name", sa.String(), nullable=True))
    op.add_column("clients", sa.Column("gstin", sa.String(15), nullable=True))
    op.add_column("clients", sa.Column("billing_address", JSONB(), nullable=True))
    op.add_column("clients", sa.Column("billing_country", sa.String(2), nullable=True))
    op.add_column("clients", sa.Column("billing_state_code", sa.String(2), nullable=True))
    op.add_column("clients", sa.Column("billing_email", sa.String(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("clients", "billing_email")
    op.drop_column("clients", "billing_state_code")
    op.drop_column("clients", "billing_country")
    op.drop_column("clients", "billing_address")
    op.drop_column("clients", "gstin")
    op.drop_column("clients", "legal_name")
```

- [ ] **Step 5: Verify migration up/down on the local DB, then run the test — expect PASS**

```bash
DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m alembic upgrade head
DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m alembic downgrade -1
DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m alembic upgrade head
DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest tests/test_client_billing_fields.py -v --no-cov
```

(Note: the shared `db` fixture `create_all`s from models, so the test passes even without the migration — the alembic up/down cycle above is the migration's real verification.)

- [ ] **Step 6: Lint + commit**

```bash
git add api/app/db/models.py api/alembic/versions/b7e2d4f9a1c6_client_billing_tax_identity.py api/tests/test_client_billing_fields.py
git commit -m "feat(invoicing): client buyer tax-identity columns (gstin, billing address/state)"
```

### Task 7: Invoice schema extension + `invoice_counters` (model + migration)

**Files:**
- Modify: `app/db/models.py` (Invoice class, lines 1024–1062; new `InvoiceCounter` class after it)
- Create: `alembic/versions/c9f3e5a7b2d8_invoice_tax_document_columns.py`
- Test: `tests/test_invoice_schema.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Invoice tax-document columns + invoice_counters round-trip and defaults."""

import os

import pytest
from sqlalchemy import text

from app.db.models import Client, Invoice, InvoiceCounter

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


def _mk_client(db, email):
    c = Client(name="T", email=email, api_key=f"key-{email}")
    db.add(c)
    db.flush()
    return c


def test_new_invoice_defaults_to_legacy_type(db):
    c = _mk_client(db, "inv-schema-1@test.example")
    inv = Invoice(client_id=c.id, amount_cents=179900, currency="inr", status="paid")
    db.add(inv)
    db.flush()
    assert inv.invoice_type == "legacy"
    assert inv.invoice_number is None
    assert inv.is_export is False


def test_tax_fields_roundtrip(db):
    c = _mk_client(db, "inv-schema-2@test.example")
    inv = Invoice(
        client_id=c.id,
        amount_cents=179900,
        currency="inr",
        status="paid",
        invoice_type="tax_invoice",
        invoice_number="DB/25-26/000001",
        place_of_supply="27",
        supply_kind="intra",
        taxable_value_minor=152458,
        tax_rate_bps=1800,
        cgst_minor=13721,
        sgst_minor=13721,
        igst_minor=0,
        total_tax_minor=27442,
        hsn_sac="997331",
        seller_snapshot={"legal_name": "Digibranders Pvt Ltd", "gstin": "27AAPFU0939F1ZV"},
        buyer_snapshot={"name": "T", "state_code": "27"},
        line_items=[{"description": "Starter — monthly", "amount_minor": 179900}],
    )
    db.add(inv)
    db.flush()
    got = db.get(Invoice, inv.id)
    assert got.cgst_minor + got.sgst_minor == got.total_tax_minor
    assert got.seller_snapshot["gstin"] == "27AAPFU0939F1ZV"


def test_invoice_number_unique(db):
    c = _mk_client(db, "inv-schema-3@test.example")
    db.add(Invoice(client_id=c.id, amount_cents=1, currency="inr", status="paid", invoice_number="DB/25-26/000002"))
    db.flush()
    db.add(Invoice(client_id=c.id, amount_cents=1, currency="inr", status="paid", invoice_number="DB/25-26/000002"))
    with pytest.raises(Exception, match="unique|Unique"):
        db.flush()


def test_credit_note_self_fk(db):
    c = _mk_client(db, "inv-schema-4@test.example")
    original = Invoice(client_id=c.id, amount_cents=100, currency="inr", status="paid")
    db.add(original)
    db.flush()
    note = Invoice(
        client_id=c.id,
        amount_cents=-100,
        currency="inr",
        status="paid",
        invoice_type="credit_note",
        credit_note_of_id=original.id,
    )
    db.add(note)
    db.flush()
    assert note.credit_note_of_id == original.id


def test_invoice_counter_composite_key(db):
    db.add(InvoiceCounter(financial_year="25-26", prefix="DB", last_serial=41))
    db.flush()
    row = db.execute(
        text("SELECT last_serial FROM invoice_counters WHERE financial_year='25-26' AND prefix='DB'")
    ).scalar()
    assert row == 41
```

- [ ] **Step 2: Run — expect FAIL** (unknown kwargs / no `InvoiceCounter`)

- [ ] **Step 3: Extend the `Invoice` model** — inside the existing class, after `pdf_url` (line 1048), and change the `currency` default line (1039):

```python
    currency = Column(String, default="inr", server_default="inr", nullable=False)
```

```python
    # ── Invoicing v2: legal tax-document fields (nullable — rows created
    # before v2, or while INVOICING_V2_ENABLED is off, stay 'legacy' and are
    # excluded from GST exports; never retro-taxed). Finalized documents are
    # IMMUTABLE — corrections are credit notes, never edits.
    invoice_number = Column(String(16), unique=True, index=True, nullable=True)
    invoice_type = Column(String, nullable=False, default="legacy", server_default="legacy")  # tax_invoice|credit_note|receipt|legacy
    issued_at = Column(DateTime(timezone=True), nullable=True)
    seller_snapshot = Column(JSONB, nullable=True)  # legal identity at issue time
    buyer_snapshot = Column(JSONB, nullable=True)
    place_of_supply = Column(String(2), nullable=True)  # GST state code
    supply_kind = Column(String, nullable=True)  # intra|inter|export
    taxable_value_minor = Column(Integer, nullable=True)
    tax_rate_bps = Column(Integer, nullable=True)
    cgst_minor = Column(Integer, nullable=True)
    sgst_minor = Column(Integer, nullable=True)
    igst_minor = Column(Integer, nullable=True)
    total_tax_minor = Column(Integer, nullable=True)
    hsn_sac = Column(String(8), nullable=True)
    is_export = Column(Boolean, nullable=False, default=False, server_default="false")
    line_items = Column(JSONB, nullable=True)
    credit_note_of_id = Column(Integer, ForeignKey("invoices.id", ondelete="SET NULL"), nullable=True)
    # Razorpay's own invoice entity for this charge (payment.invoice_id from
    # the subscription.charged payload) — payment evidence, not the tax doc.
    razorpay_invoice_id = Column(String, index=True, nullable=True)
    # E-invoicing (IRP) — unused until the ₹5cr B2B threshold applies.
    irn = Column(String, nullable=True)
    signed_qr = Column(Text, nullable=True)
```

And after the `Invoice` class add:

```python
class InvoiceCounter(Base):
    """Gapless per-FY invoice serial allocator.

    One row per (financial_year, prefix); the finalize service increments
    ``last_serial`` under ``SELECT … FOR UPDATE`` so concurrent webhooks get
    consecutive numbers and abandoned payments burn none (serials are only
    allocated at finalize time — a Rule 46 audit requirement).
    """

    __tablename__ = "invoice_counters"

    financial_year = Column(String(5), primary_key=True)  # e.g. "25-26"
    prefix = Column(String(3), primary_key=True)
    last_serial = Column(Integer, nullable=False, default=0, server_default="0")
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
```

- [ ] **Step 4: Create migration** `alembic/versions/c9f3e5a7b2d8_invoice_tax_document_columns.py`:

```python
"""invoice_tax_document_columns

Invoicing v2 Phase 1: additive tax-document columns on ``invoices`` (existing
rows become invoice_type='legacy' via server default — INV-8/9/10 handling),
``invoice_counters`` for gapless per-FY numbering, and currency default
'usd'→'inr' (INV-10). Plan: docs/billing/2026-07-02-invoicing-implementation-plan-v2.md.

Revision ID: c9f3e5a7b2d8
Revises: b7e2d4f9a1c6
Create Date: 2026-07-02

"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

from alembic import op

revision: str = "c9f3e5a7b2d8"
down_revision: str | Sequence[str] | None = "b7e2d4f9a1c6"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("invoices", sa.Column("invoice_number", sa.String(16), nullable=True))
    op.create_index("ix_invoices_invoice_number", "invoices", ["invoice_number"], unique=True)
    op.add_column("invoices", sa.Column("invoice_type", sa.String(), nullable=False, server_default="legacy"))
    op.add_column("invoices", sa.Column("issued_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("invoices", sa.Column("seller_snapshot", JSONB(), nullable=True))
    op.add_column("invoices", sa.Column("buyer_snapshot", JSONB(), nullable=True))
    op.add_column("invoices", sa.Column("place_of_supply", sa.String(2), nullable=True))
    op.add_column("invoices", sa.Column("supply_kind", sa.String(), nullable=True))
    op.add_column("invoices", sa.Column("taxable_value_minor", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("tax_rate_bps", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("cgst_minor", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("sgst_minor", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("igst_minor", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("total_tax_minor", sa.Integer(), nullable=True))
    op.add_column("invoices", sa.Column("hsn_sac", sa.String(8), nullable=True))
    op.add_column("invoices", sa.Column("is_export", sa.Boolean(), nullable=False, server_default="false"))
    op.add_column("invoices", sa.Column("line_items", JSONB(), nullable=True))
    op.add_column(
        "invoices",
        sa.Column("credit_note_of_id", sa.Integer(), sa.ForeignKey("invoices.id", ondelete="SET NULL"), nullable=True),
    )
    op.add_column("invoices", sa.Column("razorpay_invoice_id", sa.String(), nullable=True))
    op.create_index("ix_invoices_razorpay_invoice_id", "invoices", ["razorpay_invoice_id"])
    op.add_column("invoices", sa.Column("irn", sa.String(), nullable=True))
    op.add_column("invoices", sa.Column("signed_qr", sa.Text(), nullable=True))
    op.alter_column("invoices", "currency", server_default="inr")

    op.create_table(
        "invoice_counters",
        sa.Column("financial_year", sa.String(5), primary_key=True),
        sa.Column("prefix", sa.String(3), primary_key=True),
        sa.Column("last_serial", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table("invoice_counters")
    op.alter_column("invoices", "currency", server_default="usd")
    op.drop_column("invoices", "signed_qr")
    op.drop_column("invoices", "irn")
    op.drop_index("ix_invoices_razorpay_invoice_id", table_name="invoices")
    op.drop_column("invoices", "razorpay_invoice_id")
    op.drop_column("invoices", "credit_note_of_id")
    op.drop_column("invoices", "line_items")
    op.drop_column("invoices", "is_export")
    op.drop_column("invoices", "hsn_sac")
    op.drop_column("invoices", "total_tax_minor")
    op.drop_column("invoices", "igst_minor")
    op.drop_column("invoices", "sgst_minor")
    op.drop_column("invoices", "cgst_minor")
    op.drop_column("invoices", "tax_rate_bps")
    op.drop_column("invoices", "taxable_value_minor")
    op.drop_column("invoices", "supply_kind")
    op.drop_column("invoices", "place_of_supply")
    op.drop_column("invoices", "buyer_snapshot")
    op.drop_column("invoices", "seller_snapshot")
    op.drop_column("invoices", "issued_at")
    op.drop_column("invoices", "invoice_type")
    op.drop_index("ix_invoices_invoice_number", table_name="invoices")
    op.drop_column("invoices", "invoice_number")
```

- [ ] **Step 5: Verify migration cycle + tests pass** (same 4 commands as Task 6 Step 5, plus `tests/test_invoice_schema.py`). Also confirm single head: `.venv/bin/python -m alembic heads` → only `c9f3e5a7b2d8`.

- [ ] **Step 6: Run the existing billing suite for regressions**

```bash
DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest tests/test_razorpay_service.py tests/test_subscription_renewal_grants.py tests/test_credit_service_clawback.py tests/test_webhook_billing_routes.py -q --no-cov
```
Expected: all pass (new columns are nullable/defaulted; creation sites unchanged).

- [ ] **Step 7: Lint + commit**

```bash
git add api/app/db/models.py api/alembic/versions/c9f3e5a7b2d8_invoice_tax_document_columns.py api/tests/test_invoice_schema.py
git commit -m "feat(invoicing): invoice tax-document columns + invoice_counters + inr default"
```

### Task 8: Customer billing-details API (GET/PUT)

**Files:**
- Modify: `app/api/subscription_routes.py` (append near `GET /invoices`, ~line 451)
- Test: `tests/test_billing_details_routes.py`

- [ ] **Step 1: Write the failing tests.** Follow the auth-override TestClient pattern used in `tests/test_seller_profile_routes.py` (Task 4) but override `get_current_client` from `app.api.auth` with a real `Client` row created via the `db` fixture:

```python
"""Customer billing-details endpoints — read, update, validation."""

import os
from contextlib import contextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import subscription_routes
from app.api.auth import get_current_client
from app.db.models import Client

pytestmark = pytest.mark.skipif(not os.getenv("DB_URL"), reason="needs a reachable Postgres at DB_URL")


@contextmanager
def _ctx(session):
    yield session


def _mk(db, monkeypatch):
    client = Client(name="Acme", email="billing-details@test.example", api_key="key-billing-details")
    db.add(client)
    db.flush()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[get_current_client] = lambda: client
    return TestClient(app), client


def test_get_returns_empty_details(db, monkeypatch):
    c, _ = _mk(db, monkeypatch)
    res = c.get("/subscriptions/billing-details")
    assert res.status_code == 200, res.text
    assert res.json()["gstin"] is None


def test_put_persists_and_derives_state_from_gstin(db, monkeypatch):
    c, client = _mk(db, monkeypatch)
    res = c.put(
        "/subscriptions/billing-details",
        json={
            "legal_name": "Acme Industries Pvt Ltd",
            "gstin": "27AAPFU0939F1ZV",
            "billing_address": {"line1": "1 Test Lane", "city": "Mumbai", "postal_code": "400001"},
            "billing_country": "IN",
        },
    )
    assert res.status_code == 200, res.text
    assert res.json()["billing_state_code"] == "27"
    assert client.gstin == "27AAPFU0939F1ZV"


def test_put_rejects_invalid_gstin(db, monkeypatch):
    c, _ = _mk(db, monkeypatch)
    res = c.put("/subscriptions/billing-details", json={"gstin": "NOTAGSTIN"})
    assert res.status_code == 422


def test_put_rejects_state_gstin_mismatch(db, monkeypatch):
    c, _ = _mk(db, monkeypatch)
    res = c.put(
        "/subscriptions/billing-details",
        json={"gstin": "27AAPFU0939F1ZV", "billing_state_code": "29"},
    )
    assert res.status_code == 422
    assert "state" in res.json()["detail"].lower()


def test_put_rejects_unknown_state_code(db, monkeypatch):
    c, _ = _mk(db, monkeypatch)
    res = c.put("/subscriptions/billing-details", json={"billing_state_code": "95"})
    assert res.status_code == 422
```

- [ ] **Step 2: Run — expect FAIL (404s)**

Run: `DB_URL=postgresql://postgres:postgres@127.0.0.1:5432/postgres .venv/bin/python -m pytest tests/test_billing_details_routes.py -v --no-cov`

- [ ] **Step 3: Implement** in `app/api/subscription_routes.py`. Match the module's existing router/deps style (check the imports at the top of the file; `get_current_client` and `get_session` are already imported for `GET /invoices`). Add:

```python
from app.core.gstin import _VALID_STATE_CODES, is_valid_gstin, normalize_gstin
```

(If importing the private `_VALID_STATE_CODES` feels wrong during implementation, rename it to public `VALID_STATE_CODES` in `app/core/gstin.py` and update Task 2's module — public is the better call.)

```python
class BillingDetailsBody(BaseModel):
    legal_name: str | None = None
    gstin: str | None = None
    billing_address: dict[str, str] | None = None
    billing_country: str | None = None
    billing_state_code: str | None = None
    billing_email: EmailStr | None = None


def _billing_details_dict(client: Client) -> dict:
    return {
        "legal_name": client.legal_name,
        "company_name": client.company_name,
        "gstin": client.gstin,
        "billing_address": client.billing_address,
        "billing_country": client.billing_country,
        "billing_state_code": client.billing_state_code,
        "billing_email": client.billing_email,
    }


@router.get("/billing-details")
def get_billing_details(client: Client = Depends(get_current_client)):
    """The buyer identity used on tax invoices (invoicing v2 Phase 1)."""
    return _billing_details_dict(client)


@router.put("/billing-details")
def update_billing_details(body: BillingDetailsBody, client: Client = Depends(get_current_client)):
    gstin = normalize_gstin(body.gstin) if body.gstin else None
    if gstin and not is_valid_gstin(gstin):
        raise HTTPException(status_code=422, detail="GSTIN failed format/checksum validation")

    state = body.billing_state_code
    if gstin:
        if state and state != gstin[:2]:
            raise HTTPException(status_code=422, detail="billing_state_code does not match the GSTIN's state digits")
        state = gstin[:2]
    if state and state not in _VALID_STATE_CODES:
        raise HTTPException(status_code=422, detail=f"Unknown GST state code: {state}")

    with get_session() as session:
        row = session.get(Client, client.id)
        if body.legal_name is not None:
            row.legal_name = body.legal_name.strip() or None
        row.gstin = gstin
        if body.billing_address is not None:
            row.billing_address = body.billing_address
        if body.billing_country is not None:
            row.billing_country = body.billing_country.strip().upper() or None
        if state is not None or body.billing_state_code is not None:
            row.billing_state_code = state
        if body.billing_email is not None:
            row.billing_email = str(body.billing_email)
        session.commit()
        session.refresh(row)
        # Keep the dependency-injected object in sync for the response.
        for attr in ("legal_name", "gstin", "billing_address", "billing_country", "billing_state_code", "billing_email"):
            setattr(client, attr, getattr(row, attr))
    return _billing_details_dict(client)
```

Note: `PUT` with `gstin: null` clears the GSTIN (row.gstin = None unconditionally when body.gstin is falsy) — that is intended: removing a GSTIN downgrades future invoices to B2C, never touches issued ones.

- [ ] **Step 4: Run — expect all PASS**

- [ ] **Step 5: Lint + commit**

```bash
git add api/app/api/subscription_routes.py api/tests/test_billing_details_routes.py api/app/core/gstin.py api/tests/test_gstin.py
git commit -m "feat(invoicing): customer billing-details GET/PUT with GSTIN/state validation"
```

### Task 9: Expose new invoice fields in `GET /subscriptions/invoices`

**Files:**
- Modify: `app/api/subscription_routes.py:451-473` (the `list_invoices` response dict)
- Test: extend `tests/test_invoice_schema.py`

- [ ] **Step 1: Add the failing test** (append to `tests/test_invoice_schema.py`)

```python
def test_list_invoices_exposes_tax_fields(db, monkeypatch):
    from contextlib import contextmanager

    from fastapi import FastAPI
    from fastapi.testclient import TestClient as HttpClient

    from app.api import subscription_routes
    from app.api.auth import get_current_client

    @contextmanager
    def _ctx(session):
        yield session

    client = _mk_client(db, "inv-list-tax@test.example")
    db.add(
        Invoice(
            client_id=client.id,
            amount_cents=179900,
            currency="inr",
            status="paid",
            invoice_type="tax_invoice",
            invoice_number="DB/25-26/000009",
            total_tax_minor=27442,
            taxable_value_minor=152458,
            hsn_sac="997331",
            supply_kind="intra",
        )
    )
    db.flush()
    monkeypatch.setattr(subscription_routes, "get_session", lambda: _ctx(db))
    app = FastAPI()
    app.include_router(subscription_routes.router)
    app.dependency_overrides[get_current_client] = lambda: client
    res = HttpClient(app).get("/subscriptions/invoices")
    assert res.status_code == 200, res.text
    row = next(r for r in res.json() if r.get("invoice_number") == "DB/25-26/000009")
    assert row["invoice_type"] == "tax_invoice"
    assert row["total_tax_minor"] == 27442
    assert row["taxable_value_minor"] == 152458
```

- [ ] **Step 2: Run — expect FAIL** (KeyError / StopIteration: fields absent)

- [ ] **Step 3: Implement** — in `list_invoices` (`subscription_routes.py:451`), add to the per-invoice response dict alongside the existing keys:

```python
            "invoice_number": inv.invoice_number,
            "invoice_type": inv.invoice_type,
            "issued_at": inv.issued_at.isoformat() if inv.issued_at else None,
            "taxable_value_minor": inv.taxable_value_minor,
            "total_tax_minor": inv.total_tax_minor,
            "cgst_minor": inv.cgst_minor,
            "sgst_minor": inv.sgst_minor,
            "igst_minor": inv.igst_minor,
            "tax_rate_bps": inv.tax_rate_bps,
            "hsn_sac": inv.hsn_sac,
            "supply_kind": inv.supply_kind,
            "is_export": inv.is_export,
```

(Adapt the exact dict-building style to what's already in the function — if it serializes via a helper or comprehension, extend that instead of inlining.)

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Lint + commit**

```bash
git add api/app/api/subscription_routes.py api/tests/test_invoice_schema.py
git commit -m "feat(invoicing): expose tax-document fields in GET /subscriptions/invoices"
```

### Task 10: Phase 1 gate — full suite + CODE REVIEW

- [ ] **Step 1: Full checks** (same command as Task 5 Step 1). Expected: full suite green, ruff clean, single alembic head `c9f3e5a7b2d8`.

- [ ] **Step 2: Code review gate.** Run the `code-review` skill over the Phase 1 diff (`git diff <phase-0-final-commit>..HEAD`). Fix confirmed findings, re-run checks, commit fixes.

- [ ] **Step 3: Report Phase 1 results to the user** — checks summary, review findings + resolutions, and the go/no-go question for starting Phase 2 (tax engine).

---

## Out of scope for this plan (next plans)

- Phase 2 tax engine (`core/tax.py`) — next plan; the golden cases are already in the v2 doc §1c table (₹1,799 → 152458/13721/13721; ₹4,599 → 389746/35077/35077 — recompute at write time, largest-remainder).
- Phase 3 finalize service + webhook wiring; Phase 4 PDF/email; Phase 5 credit notes; Phase 6 UIs (incl. the INV-6 currency fix); Phase 7 exports/reconciliation.
- Frontend billing-details form (Phase 6 surfaces the Task 8 endpoints).

## Self-review notes

- Spec coverage: v2-doc Phase 0 items (flags ✓ T1, seller profile ✓ T3/T4, fixtures → GSTIN + seller/buyer fixtures land in T2/T3 tests; tax-scenario fixtures belong to the Phase 2 plan where they're consumed — deliberate YAGNI). Phase 1 items (client fields ✓ T6, invoice extension ✓ T7, counters ✓ T7, currency default ✓ T7, capture API ✓ T8, invoices response ✓ T9). Checkout state-enforcement is Phase 3/6 scope (noted in T6 comment).
- Known judgment calls encoded above: `billing_country`/`billing_state_code` names (clearer than spec's bare `country`/`state_code` on the busy Client model); seller profile in `pricing_config` (reuses super-admin tooling; matches `runtime_config.py` precedent); no cache on seller-profile reads.
