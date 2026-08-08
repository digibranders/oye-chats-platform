# Visitor Intelligence & Manual Follow-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add IP-based company/threat signal (ipapi.is), free email-domain extraction, Reoon-based email validation, and an operator-triggered (not automatic) follow-up-email action to OyeChats' chat-lead pipeline.

**Architecture:** Two independent enrichment lanes extend the existing `chat_routes.py` background-task pattern: an always-on IP lookup (ipapi.is) writes to the already-unused `ChatSession.visitor_metadata` JSONB column, and a conditional email lane (free domain parsing + Reoon power-mode validation) fires only when a visitor submits an email via `/chat/lead-capture`, updating `LeadInfo`. A new Admin API endpoint lets an operator manually trigger a follow-up email per lead, enforcing four safety gates (validity, cooldown-with-override, suppression, sending-domain pause) before sending. No automatic/timed sends exist anywhere in this design.

**Tech Stack:** Python 3 / FastAPI / SQLAlchemy / Alembic (existing stack), `urllib` for outbound HTTP (matching the existing `_resolve_and_update_location` pattern — no new HTTP client dependency), pytest for tests.

---

## Important: environment note before starting

While preparing this plan, file reads under `oye-chats-platform/` intermittently failed with `EPERM` (writes succeeded) — this matches a previously-diagnosed iCloud "dataless placeholder" eviction issue on this exact repo (see project memory: repos moved off iCloud, 2026-07-31). **Task 1 below re-verifies the handful of details this plan depends on** (test fixtures, the email-dispatch call, `Bot` model fields, migration head) before any code is written. If Task 1's reads also fail, do not force retries — check `Console.app` for `bird`/`cloudd` errors, confirm the repo shows a cloud-synced-with-no-local-copy badge in Finder, or wait a few minutes and retry once; do not `rm`/re-clone to "fix" it.

## File Structure

| File                                                              | Responsibility                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api/app/services/ip_intel_service.py`                          | **New.** Calls ipapi.is, returns parsed company/ASN/threat dict. Pure function, no DB.                                                                                                                                 |
| `api/app/services/email_domain_service.py`                      | **New.** Extracts a company domain from an email address; filters out free/personal providers. Pure function, no DB.                                                                                                   |
| `api/app/services/reoon_service.py`                             | **New.** Calls Reoon's `/verify` endpoint in power mode, returns parsed validation dict. Pure function, no DB.                                                                                                       |
| `api/app/api/chat_routes.py`                                    | **Modify.** Extend `_resolve_and_update_location` to also call `ip_intel_service` and write `ChatSession.visitor_metadata`. Add `_enrich_lead_from_email` and dispatch it from `lead_capture_endpoint`.      |
| `api/app/db/models.py`                                          | **Modify.** Add columns to `LeadInfo` (`email_status`, `is_safe_to_send`, `last_followup_sent_at`, `followup_sent_by_operator_id`); add `Bot.followup_sending_paused`; add new `EmailSuppression` model. |
| `api/alembic/versions/<rev>_add_visitor_intelligence_fields.py` | **New.** Migration for the above.                                                                                                                                                                                      |
| `api/app/api/admin_leads_routes.py`                             | **New.** Manual `POST /admin/leads/{session_id}/send-followup` endpoint implementing the four gates.                                                                                                                 |
| `api/app/api/unsubscribe_routes.py`                             | **New.** Public `GET /unsubscribe` endpoint that writes to `EmailSuppression` — required so the email sent by the follow-up flow has a working unsubscribe link.                                                  |
| `api/tests/services/test_ip_intel_service.py`                   | **New.** Unit tests, mocked HTTP.                                                                                                                                                                                      |
| `api/tests/services/test_email_domain_service.py`               | **New.** Unit tests, no mocking needed (pure logic).                                                                                                                                                                   |
| `api/tests/services/test_reoon_service.py`                      | **New.** Unit tests, mocked HTTP.                                                                                                                                                                                      |
| `api/tests/api/test_chat_routes_ip_intel.py`                    | **New.** Integration test for the always-on IP lane.                                                                                                                                                                   |
| `api/tests/api/test_lead_capture_enrichment.py`                 | **New.** Integration test for the conditional email lane.                                                                                                                                                              |
| `api/tests/api/test_unsubscribe_routes.py`                      | **New.** Integration test for the suppression writer.                                                                                                                                                                  |
| `api/tests/api/test_admin_leads_routes.py`                      | **New.** Integration tests for all four gates.                                                                                                                                                                         |

---

### Task 1: Recon — confirm the unknowns this plan depends on

**Files:** none modified — read-only investigation.

- [ ] **Step 1: Confirm the test fixture pattern**

Run:

```bash
cat api/tests/conftest.py
```

Expected: a pytest fixture file. Note the exact fixture names for (a) a DB session, (b) a test `Bot`, (c) a FastAPI `TestClient`, (d) an authenticated-operator fixture if one exists. Write them down — Tasks 3, 8, and 9's tests use the placeholder names `db_session`, `test_bot`, `client`, `admin_auth_headers`, `test_operator`. Find-and-replace those with the real names before running any test in this plan.

- [ ] **Step 2: Locate the existing email-dispatch function**

Run:

```bash
grep -rniE "def send_email|smtp|ses_client|boto3|brevo" api/app --include="*.py" | grep -v __pycache__
```

Expected: one or more hits showing the module and function OyeChats already uses to send transactional email (referenced in project memory as an SES/Brevo-based sender). Note the exact import path and function signature — Task 9's implementation calls it as `app.services.email_sender.send_email(to=..., template=..., variables=..., bot_id=...)`; update the import and call signature to match what you actually find.

- [ ] **Step 3: Confirm `Bot` model's field list and admin auth pattern**

Run:

```bash
sed -n '247,505p' api/app/db/models.py
grep -rn "Depends(get_current_operator\|Depends(get_current_admin\|Depends(require_operator" api/app/api --include="*.py"
```

Expected: the full `Bot` class (confirm there's no existing pause-equivalent field before Task 6 adds one) and the existing FastAPI dependency other `/admin` routes use for operator auth. Task 9's `get_current_operator` placeholder must be replaced with that real dependency, not left as `raise NotImplementedError(...)`.

- [ ] **Step 4: Confirm the Alembic migration head**

Run:

```bash
cd api && alembic current && alembic heads
```

Note the output — Task 6's generated migration needs a real `down_revision` matching the current head.

- [ ] **Step 5: Confirm the router-registration file**

Run:

```bash
grep -n "include_router" api/app/main.py
```

Expected: the existing pattern for wiring a new `APIRouter` into the app. Tasks 7 and 9 both add a line here matching that exact pattern.

---

### Task 2: IP intelligence client (ipapi.is)

**Files:**

- Create: `api/app/services/ip_intel_service.py`
- Test: `api/tests/services/test_ip_intel_service.py`

- [ ] **Step 1: Write the failing test**

```python
# api/tests/services/test_ip_intel_service.py
import json
from unittest.mock import patch, MagicMock

from app.services.ip_intel_service import fetch_ip_intel


def _mock_response(payload: dict):
    mock_resp = MagicMock()
    mock_resp.read.return_value = json.dumps(payload).encode()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = False
    return mock_resp


def test_fetch_ip_intel_parses_business_company(monkeypatch):
    monkeypatch.setenv("IPAPI_IS_KEY", "test-key")
    payload = {
        "company": {"name": "Acme Corp", "domain": "acme.com", "type": "business"},
        "asn": {"org": "Acme Corp", "domain": "acme.com"},
        "is_vpn": False,
        "is_proxy": False,
        "is_datacenter": False,
        "is_abuser": False,
    }
    with patch("app.services.ip_intel_service.urllib.request.urlopen", return_value=_mock_response(payload)):
        result = fetch_ip_intel("1.2.3.4")

    assert result["company"] == {"name": "Acme Corp", "domain": "acme.com", "type": "business"}
    assert result["is_vpn"] is False
    assert result["is_datacenter"] is False


def test_fetch_ip_intel_returns_none_on_error(monkeypatch):
    monkeypatch.setenv("IPAPI_IS_KEY", "test-key")
    with patch("app.services.ip_intel_service.urllib.request.urlopen", side_effect=OSError("timeout")):
        result = fetch_ip_intel("1.2.3.4")

    assert result is None


def test_fetch_ip_intel_returns_none_without_api_key(monkeypatch):
    monkeypatch.delenv("IPAPI_IS_KEY", raising=False)
    result = fetch_ip_intel("1.2.3.4")
    assert result is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/services/test_ip_intel_service.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.ip_intel_service'`

- [ ] **Step 3: Write the implementation**

```python
# api/app/services/ip_intel_service.py
"""IP-based company and threat-signal lookup via ipapi.is.

Always-on, best-effort signal — see
docs/superpowers/plans/2026-08-08-visitor-intelligence.md for why this
can never resolve the real employer behind an ISP-routed IP.
"""

import json
import logging
import os
import urllib.parse
import urllib.request

logger = logging.getLogger(__name__)

IPAPI_IS_URL = "https://api.ipapi.is/"


def fetch_ip_intel(ip_address: str) -> dict | None:
    """Fetch company/ASN/threat data for an IP. Returns None on any failure."""
    api_key = os.getenv("IPAPI_IS_KEY", "")
    if not api_key:
        return None

    query = urllib.parse.urlencode({"q": ip_address, "key": api_key})
    url = f"{IPAPI_IS_URL}?{query}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "OyeChats/1.0"})
        with urllib.request.urlopen(req, timeout=3.0) as response:
            data = json.loads(response.read().decode())
    except Exception as exc:
        logger.warning(f"ipapi.is lookup failed for {ip_address}: {exc}")
        return None

    if "error" in data:
        logger.warning(f"ipapi.is returned error for {ip_address}: {data.get('error')}")
        return None

    return {
        "company": data.get("company"),
        "asn": data.get("asn"),
        "is_vpn": data.get("is_vpn", False),
        "is_proxy": data.get("is_proxy", False),
        "is_tor": data.get("is_tor", False),
        "is_datacenter": data.get("is_datacenter", False),
        "is_abuser": data.get("is_abuser", False),
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && pytest tests/services/test_ip_intel_service.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
cd api && git add app/services/ip_intel_service.py tests/services/test_ip_intel_service.py
git commit -m "feat: add ipapi.is client for IP-based company/threat signal"
```

---

### Task 3: Wire ipapi.is into the existing background resolver

**Files:**

- Modify: `api/app/api/chat_routes.py` (`_resolve_and_update_location`)
- Test: `api/tests/api/test_chat_routes_ip_intel.py`

- [ ] **Step 1: Write the failing test**

```python
# api/tests/api/test_chat_routes_ip_intel.py
from unittest.mock import patch

from app.api.chat_routes import _resolve_and_update_location
from app.db.models import ChatSession
from app.db.session import get_session  # adjust import if Task 1 found a different session helper


def test_resolve_and_update_location_writes_visitor_metadata(db_session, test_bot):
    session_id = "test-session-ip-intel"
    chat_session = ChatSession(id=session_id, bot_id=test_bot.id, status="bot")
    db_session.add(chat_session)
    db_session.commit()

    fake_intel = {
        "company": {"name": "Acme Corp", "domain": "acme.com", "type": "business"},
        "asn": {"org": "Acme Corp"},
        "is_vpn": False,
        "is_proxy": False,
        "is_tor": False,
        "is_datacenter": False,
        "is_abuser": False,
    }

    with patch("app.api.chat_routes.fetch_ip_intel", return_value=fake_intel), \
         patch("app.api.chat_routes.urllib.request.urlopen", side_effect=OSError("skip geo for this test")):
        _resolve_and_update_location(session_id, "8.8.8.8")

    with get_session() as session:
        updated = session.query(ChatSession).filter(ChatSession.id == session_id).first()
        assert updated.visitor_metadata["company"]["name"] == "Acme Corp"
        assert updated.visitor_metadata["is_vpn"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/api/test_chat_routes_ip_intel.py -v`
Expected: FAIL — `visitor_metadata` is `None` (ipapi.is call not wired in yet)

- [ ] **Step 3: Add the import and the write inside `_resolve_and_update_location`**

Add near the top of `api/app/api/chat_routes.py`, alongside the existing imports:

```python
from app.services.ip_intel_service import fetch_ip_intel
```

Inside `_resolve_and_update_location`, immediately after the existing `is_local` early-return block (the `if is_local: ... return` check) and before the primary geolocation lookup (`ipwho.is`) block, add:

```python
        ip_intel = fetch_ip_intel(ip_address)
        if ip_intel:
            for _ in range(5):
                with get_session() as session:
                    chat_session = session.query(ChatSession).filter(ChatSession.id == session_id).first()
                    if chat_session:
                        chat_session.visitor_metadata = ip_intel
                        session.commit()
                        logger.info(f"IP intel resolved | session={session_id} | company={ip_intel.get('company')}")
                        break
                time.sleep(0.5)
```

This mirrors the existing retry-for-race-condition pattern already used later in the same function for `location` — the `ChatSession` row is inserted by the same request that spawned this background thread, so a fast ipapi.is response can occasionally beat the INSERT.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && pytest tests/api/test_chat_routes_ip_intel.py -v`
Expected: PASS

- [ ] **Step 5: Add `IPAPI_IS_KEY` to the env template**

Add one line to `api/.env.example` (append, don't overwrite the file):

```
IPAPI_IS_KEY=
```

- [ ] **Step 6: Commit**

```bash
cd api && git add app/api/chat_routes.py .env.example tests/api/test_chat_routes_ip_intel.py
git commit -m "feat: write ipapi.is company/threat signal to ChatSession.visitor_metadata"
```

---

### Task 4: Domain-extraction service (free, in-house)

**Files:**

- Create: `api/app/services/email_domain_service.py`
- Test: `api/tests/services/test_email_domain_service.py`

- [ ] **Step 1: Write the failing test**

```python
# api/tests/services/test_email_domain_service.py
from app.services.email_domain_service import extract_company_domain


def test_extracts_domain_from_business_email():
    assert extract_company_domain("priya@xyz.com") == "xyz.com"


def test_returns_none_for_free_email_provider():
    assert extract_company_domain("priya@gmail.com") is None
    assert extract_company_domain("priya@yahoo.com") is None
    assert extract_company_domain("priya@outlook.com") is None
    assert extract_company_domain("priya@icloud.com") is None


def test_returns_none_for_malformed_email():
    assert extract_company_domain("not-an-email") is None
    assert extract_company_domain("") is None
    assert extract_company_domain(None) is None


def test_lowercases_and_strips_domain():
    assert extract_company_domain("Priya@XYZ.COM ") == "xyz.com"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/services/test_email_domain_service.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write the implementation**

```python
# api/app/services/email_domain_service.py
"""Free, in-house company-domain extraction from an email address.

No API call — see docs/superpowers/plans/2026-08-08-visitor-intelligence.md
for why this replaced a paid reverse-email-lookup vendor.
"""

# Not exhaustive by design — covers the providers a B2B chatbot lead is
# actually likely to type. Extend this list as false positives are
# reported; do not attempt to auto-generate it — a bad addition here
# silently drops a real company's leads.
_FREE_EMAIL_DOMAINS = frozenset({
    "gmail.com", "googlemail.com",
    "yahoo.com", "yahoo.co.in", "ymail.com",
    "outlook.com", "hotmail.com", "live.com", "msn.com",
    "icloud.com", "me.com", "mac.com",
    "protonmail.com", "proton.me",
    "aol.com",
    "rediffmail.com",
    "zoho.com",
})


def extract_company_domain(email: str | None) -> str | None:
    """Return the lowercased domain of a business email, or None if the
    address is malformed or belongs to a known free/personal provider."""
    if not email or "@" not in email:
        return None

    domain = email.strip().lower().rsplit("@", 1)[-1]
    if not domain or "." not in domain:
        return None

    if domain in _FREE_EMAIL_DOMAINS:
        return None

    return domain
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && pytest tests/services/test_email_domain_service.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
cd api && git add app/services/email_domain_service.py tests/services/test_email_domain_service.py
git commit -m "feat: add free in-house company-domain extraction from email"
```

---

### Task 5: Reoon validation client (power mode)

**Files:**

- Create: `api/app/services/reoon_service.py`
- Test: `api/tests/services/test_reoon_service.py`

- [ ] **Step 1: Write the failing test**

```python
# api/tests/services/test_reoon_service.py
import json
from unittest.mock import patch, MagicMock

from app.services.reoon_service import verify_email


def _mock_response(payload: dict):
    mock_resp = MagicMock()
    mock_resp.read.return_value = json.dumps(payload).encode()
    mock_resp.__enter__.return_value = mock_resp
    mock_resp.__exit__.return_value = False
    return mock_resp


def test_verify_email_safe_to_send(monkeypatch):
    monkeypatch.setenv("REOON_API_KEY", "test-key")
    payload = {
        "status": "safe",
        "overall_score": 98,
        "is_safe_to_send": True,
        "is_disposable": False,
        "is_deliverable": True,
    }
    with patch("app.services.reoon_service.urllib.request.urlopen", return_value=_mock_response(payload)):
        result = verify_email("gaurav@fynix.digital")

    assert result["is_safe_to_send"] is True
    assert result["status"] == "safe"


def test_verify_email_not_safe_to_send(monkeypatch):
    monkeypatch.setenv("REOON_API_KEY", "test-key")
    payload = {
        "status": "invalid",
        "overall_score": 3,
        "is_safe_to_send": False,
        "is_disposable": False,
        "is_deliverable": False,
    }
    with patch("app.services.reoon_service.urllib.request.urlopen", return_value=_mock_response(payload)):
        result = verify_email("gaurav@cleanstart.com")

    assert result["is_safe_to_send"] is False


def test_verify_email_returns_none_on_error(monkeypatch):
    monkeypatch.setenv("REOON_API_KEY", "test-key")
    with patch("app.services.reoon_service.urllib.request.urlopen", side_effect=OSError("timeout")):
        result = verify_email("test@example.com")

    assert result is None


def test_verify_email_returns_none_without_api_key(monkeypatch):
    monkeypatch.delenv("REOON_API_KEY", raising=False)
    assert verify_email("test@example.com") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/services/test_reoon_service.py -v`
Expected: FAIL with `ModuleNotFoundError`

- [ ] **Step 3: Write the implementation**

```python
# api/app/services/reoon_service.py
"""Email validation via Reoon, power mode only.

Power mode was chosen over quick mode after a live accuracy test found
3 of 11 quick-mode results wrong (including a real false positive on a
known-invalid address) — see
docs/superpowers/plans/2026-08-08-visitor-intelligence.md §04. Power mode
costs the same 1 credit per call as quick mode, confirmed empirically.
"""

import json
import logging
import os
import urllib.parse
import urllib.request

logger = logging.getLogger(__name__)

REOON_VERIFY_URL = "https://emailverifier.reoon.com/api/v1/verify"


def verify_email(email: str) -> dict | None:
    """Run a Reoon power-mode check. Returns None on any failure — callers
    must treat None as 'unknown, do not send', never as 'safe'."""
    api_key = os.getenv("REOON_API_KEY", "")
    if not api_key:
        return None

    query = urllib.parse.urlencode({"email": email, "key": api_key, "mode": "power"})
    url = f"{REOON_VERIFY_URL}?{query}"

    try:
        req = urllib.request.Request(url, headers={"User-Agent": "OyeChats/1.0"})
        with urllib.request.urlopen(req, timeout=90.0) as response:
            data = json.loads(response.read().decode())
    except Exception as exc:
        logger.warning(f"Reoon verification failed for {email}: {exc}")
        return None

    if "status" not in data:
        logger.warning(f"Reoon returned unexpected payload for {email}: {data}")
        return None

    return {
        "status": data.get("status"),
        "overall_score": data.get("overall_score"),
        "is_safe_to_send": data.get("is_safe_to_send", False),
        "is_disposable": data.get("is_disposable", False),
        "is_deliverable": data.get("is_deliverable", False),
    }
```

Note the 90-second timeout — Reoon's own docs warn power mode can take "seconds to over a minute" on slow mail servers; this runs entirely inside a background thread, so a slow call costs nothing in perceived latency.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && pytest tests/services/test_reoon_service.py -v`
Expected: 4 passed

- [ ] **Step 5: Add `REOON_API_KEY` to the env template**

Add one line to `api/.env.example`:

```
REOON_API_KEY=
```

- [ ] **Step 6: Commit**

```bash
cd api && git add app/services/reoon_service.py .env.example tests/services/test_reoon_service.py
git commit -m "feat: add Reoon power-mode email validation client"
```

---

### Task 6: Migration — LeadInfo, Bot, and EmailSuppression

**Files:**

- Modify: `api/app/db/models.py` (`LeadInfo` class, `Bot` class)
- Create (same file): new `EmailSuppression` class, added directly below `LeadInfo`
- Create: `api/alembic/versions/<rev>_add_visitor_intelligence_fields.py`

- [ ] **Step 1: Add the new columns to `LeadInfo`**

In `api/app/db/models.py`, inside the `LeadInfo` class, add after the existing `visitor_journey` column:

```python
    email_status = Column(String, nullable=True)  # Reoon power-mode "status": safe/invalid/disposable/...
    is_safe_to_send = Column(Boolean, nullable=True)  # Reoon's is_safe_to_send at capture time
    last_followup_sent_at = Column(DateTime(timezone=True), nullable=True)
    followup_sent_by_operator_id = Column(Integer, ForeignKey("operators.id", ondelete="SET NULL"), nullable=True)
```

Add the relationship below the existing `bot = relationship(...)` line in the same class:

```python
    followup_sent_by = relationship("Operator")
```

- [ ] **Step 2: Add the pause flag to `Bot`**

In the `Bot` class (confirm the exact field list from Task 1 Step 3 first, to avoid a duplicate column), add:

```python
    followup_sending_paused = Column(Boolean, default=False, server_default="false", nullable=False)
```

- [ ] **Step 3: Add the `EmailSuppression` model**

Add a new class in `api/app/db/models.py`, directly below the `LeadInfo` class:

```python
class EmailSuppression(Base):
    """Permanent per-bot unsubscribe list. Checked by Gate 3 before any
    manual follow-up send — see
    docs/superpowers/plans/2026-08-08-visitor-intelligence.md §02.
    Once added, a row is never removed by application code."""

    __tablename__ = "email_suppressions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    bot_id = Column(Integer, ForeignKey("bots.id", ondelete="CASCADE"), nullable=False, index=True)
    email = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (UniqueConstraint("bot_id", "email", name="uq_email_suppressions_bot_email"),)
```

- [ ] **Step 4: Generate the migration**

Run (using the head revision confirmed in Task 1 Step 4):

```bash
cd api && alembic revision --autogenerate -m "add visitor intelligence fields"
```

Expected: a new file under `api/alembic/versions/`. Open it and confirm it contains exactly: 4 new `lead_info` columns, 1 new `bots` column with `server_default='false'`, and the new `email_suppressions` table with the unique constraint. If autogenerate misses the `server_default` or the unique constraint, add them by hand in the generated file's `upgrade()` function — do not skip them, a missing `server_default` will break existing rows on deploy.

- [ ] **Step 5: Apply and verify**

Run:

```bash
cd api && alembic upgrade head
```

Expected: no errors, ends at the new revision.

- [ ] **Step 6: Commit**

```bash
cd api && git add app/db/models.py alembic/versions/
git commit -m "feat: add LeadInfo email-status/followup fields, Bot pause flag, EmailSuppression table"
```

---

### Task 7: Unsubscribe endpoint (populates `EmailSuppression`)

**Files:**

- Create: `api/app/api/unsubscribe_routes.py`
- Test: `api/tests/api/test_unsubscribe_routes.py`
- Modify: `api/app/main.py` (router registration, exact pattern confirmed in Task 1 Step 5)

- [ ] **Step 1: Write the failing test**

```python
# api/tests/api/test_unsubscribe_routes.py
def test_unsubscribe_creates_suppression_row(client, db_session, test_bot):
    from app.db.models import EmailSuppression

    response = client.get(f"/unsubscribe?bot_id={test_bot.id}&email=lead@example.com")

    assert response.status_code == 200
    row = (
        db_session.query(EmailSuppression)
        .filter(EmailSuppression.bot_id == test_bot.id, EmailSuppression.email == "lead@example.com")
        .first()
    )
    assert row is not None


def test_unsubscribe_is_idempotent(client, db_session, test_bot):
    client.get(f"/unsubscribe?bot_id={test_bot.id}&email=lead@example.com")
    response = client.get(f"/unsubscribe?bot_id={test_bot.id}&email=lead@example.com")
    assert response.status_code == 200


def test_unsubscribe_rejects_malformed_email(client, test_bot):
    response = client.get(f"/unsubscribe?bot_id={test_bot.id}&email=not-an-email")
    assert response.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/api/test_unsubscribe_routes.py -v`
Expected: FAIL — 404, route doesn't exist

- [ ] **Step 3: Write the implementation**

```python
# api/app/api/unsubscribe_routes.py
"""Public unsubscribe endpoint. No auth — this link is clicked from an
email client, not called by the widget/API-key flow used elsewhere."""

import logging

from fastapi import APIRouter, HTTPException
from sqlalchemy.exc import IntegrityError

from app.db.models import EmailSuppression
from app.db.session import get_session  # adjust import if Task 1 found a different session helper

logger = logging.getLogger(__name__)
router = APIRouter(tags=["unsubscribe"])


@router.get("/unsubscribe")
def unsubscribe(bot_id: int, email: str):
    email = email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Invalid email address.")

    with get_session() as session:
        existing = (
            session.query(EmailSuppression)
            .filter(EmailSuppression.bot_id == bot_id, EmailSuppression.email == email)
            .first()
        )
        if existing:
            return {"success": True, "message": "You're already unsubscribed."}

        try:
            session.add(EmailSuppression(bot_id=bot_id, email=email))
            session.commit()
        except IntegrityError:
            session.rollback()  # race: another request inserted it first — fine, already suppressed

    logger.info(f"Unsubscribe recorded | bot={bot_id} | email={email[:3]}***")
    return {"success": True, "message": "You've been unsubscribed."}
```

- [ ] **Step 4: Register the router**

Using the exact pattern found in Task 1 Step 5, add to `api/app/main.py`:

```python
from app.api.unsubscribe_routes import router as unsubscribe_router
app.include_router(unsubscribe_router)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd api && pytest tests/api/test_unsubscribe_routes.py -v`
Expected: 3 passed

- [ ] **Step 6: Commit**

```bash
cd api && git add app/api/unsubscribe_routes.py tests/api/test_unsubscribe_routes.py app/main.py
git commit -m "feat: add public unsubscribe endpoint backing EmailSuppression"
```

---

### Task 8: Wire domain extraction + Reoon into lead capture

**Files:**

- Modify: `api/app/api/chat_routes.py` (`lead_capture_endpoint`)
- Test: `api/tests/api/test_lead_capture_enrichment.py`

- [ ] **Step 1: Write the failing test**

```python
# api/tests/api/test_lead_capture_enrichment.py
from unittest.mock import patch

from app.db.models import LeadInfo


def test_lead_capture_enriches_company_and_validation(db_session, test_bot):
    from app.api.chat_routes import _enrich_lead_from_email
    from app.db.repository import create_or_update_lead_info  # confirm exact path/signature in Task 1

    session_id = "test-session-enrich"
    create_or_update_lead_info(db_session, session_id=session_id, bot_id=test_bot.id, name="Gaurav", email="gaurav@fynix.digital")
    db_session.commit()

    fake_validation = {"status": "safe", "overall_score": 98, "is_safe_to_send": True,
                        "is_disposable": False, "is_deliverable": True}

    with patch("app.api.chat_routes.verify_email", return_value=fake_validation):
        _enrich_lead_from_email(session_id, test_bot.id, "gaurav@fynix.digital")

    lead = db_session.query(LeadInfo).filter(LeadInfo.session_id == session_id).first()
    assert lead.company == "fynix.digital"
    assert lead.email_status == "safe"
    assert lead.is_safe_to_send is True


def test_lead_capture_skips_domain_for_free_email(db_session, test_bot):
    from app.api.chat_routes import _enrich_lead_from_email
    from app.db.repository import create_or_update_lead_info

    session_id = "test-session-enrich-free"
    create_or_update_lead_info(db_session, session_id=session_id, bot_id=test_bot.id, name="Priya", email="priya@gmail.com")
    db_session.commit()

    fake_validation = {"status": "safe", "overall_score": 90, "is_safe_to_send": True,
                        "is_disposable": False, "is_deliverable": True}

    with patch("app.api.chat_routes.verify_email", return_value=fake_validation):
        _enrich_lead_from_email(session_id, test_bot.id, "priya@gmail.com")

    lead = db_session.query(LeadInfo).filter(LeadInfo.session_id == session_id).first()
    assert lead.company is None
    assert lead.is_safe_to_send is True
```

`create_or_update_lead_info`'s exact module path and keyword arguments must be confirmed against the real function (it's called from the existing `lead_capture_endpoint`) before this test can run — grep for its definition if Task 1 didn't already surface it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && pytest tests/api/test_lead_capture_enrichment.py -v`
Expected: FAIL — `ImportError: cannot import name '_enrich_lead_from_email'`

- [ ] **Step 3: Write the implementation**

Add imports near the top of `api/app/api/chat_routes.py`:

```python
from app.services.email_domain_service import extract_company_domain
from app.services.reoon_service import verify_email
```

Add a new background function, placed directly after `_resolve_and_update_location`:

```python
def _enrich_lead_from_email(session_id: str, bot_id: int, email: str):
    """Fire-and-forget: free domain extraction + Reoon power-mode validation.

    Two independent checks, not chained — the domain is free and always
    attempted; validation determines is_safe_to_send but never blocks the
    domain from being written. See
    docs/superpowers/plans/2026-08-08-visitor-intelligence.md §01.
    """
    domain = extract_company_domain(email)
    validation = verify_email(email)

    for _ in range(5):
        with get_session() as session:
            lead = session.query(LeadInfo).filter(LeadInfo.session_id == session_id).first()
            if lead:
                if domain:
                    lead.company = domain
                if validation:
                    lead.email_status = validation["status"]
                    lead.is_safe_to_send = validation["is_safe_to_send"]
                session.commit()
                logger.info(
                    f"Lead enriched | session={session_id} | domain={domain} | "
                    f"safe_to_send={validation.get('is_safe_to_send') if validation else 'unknown'}"
                )
                return
        time.sleep(0.5)

    logger.warning(f"Lead enrichment: LeadInfo row never appeared | session={session_id}")
```

In `lead_capture_endpoint`, immediately after the existing `create_or_update_lead_info(...)` call and before `session.commit()`, add:

```python
            if body.email:
                submit_background(_enrich_lead_from_email, body.session_id, bot.id, body.email)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && pytest tests/api/test_lead_capture_enrichment.py -v`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
cd api && git add app/api/chat_routes.py tests/api/test_lead_capture_enrichment.py
git commit -m "feat: enrich captured leads with free domain + Reoon validation in background"
```

---

### Task 9: Manual "Send Follow-up" admin endpoint (the four gates)

**Files:**

- Create: `api/app/api/admin_leads_routes.py`
- Test: `api/tests/api/test_admin_leads_routes.py`
- Modify: `api/app/main.py` (router registration)

- [ ] **Step 1: Write the failing tests — one per gate**

```python
# api/tests/api/test_admin_leads_routes.py
from datetime import datetime, timedelta, timezone

from app.db.models import Bot, ChatSession, EmailSuppression, LeadInfo


def _make_lead(db_session, test_bot, session_id="lead-1", **overrides):
    chat_session = ChatSession(id=session_id, bot_id=test_bot.id, status="bot")
    db_session.add(chat_session)
    lead = LeadInfo(
        session_id=session_id, bot_id=test_bot.id,
        name="Gaurav", email="gaurav@fynix.digital", company="fynix.digital",
        is_safe_to_send=True,
    )
    for key, value in overrides.items():
        setattr(lead, key, value)
    db_session.add(lead)
    db_session.commit()
    return lead


def test_gate1_blocks_when_not_safe_to_send(client, db_session, test_bot, admin_auth_headers):
    _make_lead(db_session, test_bot, is_safe_to_send=False)
    response = client.post("/admin/leads/lead-1/send-followup", headers=admin_auth_headers)
    assert response.status_code == 400
    assert "not eligible" in response.json()["detail"].lower()


def test_gate2_warns_but_allows_override(client, db_session, test_bot, admin_auth_headers):
    recent = datetime.now(timezone.utc) - timedelta(days=1)
    _make_lead(db_session, test_bot, last_followup_sent_at=recent)

    blocked = client.post("/admin/leads/lead-1/send-followup", headers=admin_auth_headers)
    assert blocked.status_code == 409  # needs confirmation

    overridden = client.post(
        "/admin/leads/lead-1/send-followup", headers=admin_auth_headers, json={"confirm_override": True}
    )
    assert overridden.status_code == 200


def test_gate3_blocks_suppressed_email_with_no_override(client, db_session, test_bot, admin_auth_headers):
    _make_lead(db_session, test_bot)
    db_session.add(EmailSuppression(bot_id=test_bot.id, email="gaurav@fynix.digital"))
    db_session.commit()

    response = client.post(
        "/admin/leads/lead-1/send-followup", headers=admin_auth_headers, json={"confirm_override": True}
    )
    assert response.status_code == 403
    assert "unsubscribed" in response.json()["detail"].lower()


def test_gate4_blocks_when_bot_paused(client, db_session, test_bot, admin_auth_headers):
    test_bot.followup_sending_paused = True
    db_session.commit()
    _make_lead(db_session, test_bot)

    response = client.post("/admin/leads/lead-1/send-followup", headers=admin_auth_headers)
    assert response.status_code == 423
    assert "paused" in response.json()["detail"].lower()


def test_all_gates_pass_records_operator_and_timestamp(client, db_session, test_bot, admin_auth_headers, test_operator):
    _make_lead(db_session, test_bot)

    response = client.post("/admin/leads/lead-1/send-followup", headers=admin_auth_headers)

    assert response.status_code == 200
    lead = db_session.query(LeadInfo).filter(LeadInfo.session_id == "lead-1").first()
    assert lead.last_followup_sent_at is not None
    assert lead.followup_sent_by_operator_id == test_operator.id
```

`admin_auth_headers` and `test_operator` are placeholder fixture names — replace with whatever Task 1 Step 1 found in `conftest.py` for authenticating as an operator.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && pytest tests/api/test_admin_leads_routes.py -v`
Expected: FAIL — 404, route doesn't exist

- [ ] **Step 3: Write the implementation**

```python
# api/app/api/admin_leads_routes.py
"""Manual, operator-triggered follow-up email. There is no automatic or
timed send anywhere in this system — see
docs/superpowers/plans/2026-08-08-visitor-intelligence.md §02 for why."""

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.db.models import Bot, EmailSuppression, LeadInfo, Operator
from app.db.session import get_session  # adjust import if Task 1 found a different session helper
from app.services.email_sender import send_email  # adjust import/signature — confirmed in Task 1 Step 2

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin/leads", tags=["admin-leads"])

FOLLOWUP_COOLDOWN = timedelta(days=14)


class SendFollowupRequest(BaseModel):
    confirm_override: bool = False


@router.post("/{session_id}/send-followup")
def send_followup(
    session_id: str,
    body: SendFollowupRequest,
    operator: Operator = Depends(...),  # replace with the real dependency found in Task 1 Step 3
):
    with get_session() as session:
        lead = session.query(LeadInfo).filter(LeadInfo.session_id == session_id).first()
        if not lead:
            raise HTTPException(status_code=404, detail="Lead not found.")

        # Gate 1 — hard stop, no override. Mirrors why the button wouldn't
        # be shown in the Admin UI in the first place.
        if not lead.email or lead.is_safe_to_send is not True:
            raise HTTPException(status_code=400, detail="Lead is not eligible — no validated, safe-to-send email.")

        # Gate 2 — soft stop, operator can override.
        if lead.last_followup_sent_at:
            elapsed = datetime.now(timezone.utc) - lead.last_followup_sent_at
            if elapsed < FOLLOWUP_COOLDOWN and not body.confirm_override:
                raise HTTPException(
                    status_code=409,
                    detail=f"Already followed up {elapsed.days} day(s) ago. Resend with confirm_override to proceed.",
                )

        # Gate 3 — hard stop, no override, ever.
        suppressed = (
            session.query(EmailSuppression)
            .filter(EmailSuppression.bot_id == lead.bot_id, EmailSuppression.email == lead.email)
            .first()
        )
        if suppressed:
            raise HTTPException(status_code=403, detail="This email has unsubscribed — cannot send.")

        # Gate 4 — hard stop, no override.
        bot = session.query(Bot).filter(Bot.id == lead.bot_id).first()
        if bot and bot.followup_sending_paused:
            raise HTTPException(status_code=423, detail="Sending is paused for this bot — contact ops.")

        send_email(
            to=lead.email,
            template="chat_followup",
            variables={"name": lead.name or "there", "company": lead.company},
            bot_id=lead.bot_id,
        )

        lead.last_followup_sent_at = datetime.now(timezone.utc)
        lead.followup_sent_by_operator_id = operator.id
        session.commit()

        logger.info(f"Follow-up sent | session={session_id} | operator={operator.id}")
        return {"success": True}
```

The `Depends(...)` placeholder and the `send_email` import are the two pieces this task cannot finish blind — Task 1 Steps 2–3 must resolve them to the real dependency and function signature before this file compiles against the actual codebase.

- [ ] **Step 4: Register the router** (same pattern as Task 7 Step 4)

```python
from app.api.admin_leads_routes import router as admin_leads_router
app.include_router(admin_leads_router)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd api && pytest tests/api/test_admin_leads_routes.py -v`
Expected: 5 passed

- [ ] **Step 6: Commit**

```bash
cd api && git add app/api/admin_leads_routes.py tests/api/test_admin_leads_routes.py app/main.py
git commit -m "feat: add manual operator-triggered follow-up endpoint with 4 safety gates"
```

---

### Task 10: Admin UI — "Send Follow-up" button (separate follow-on plan, not covered here)

The frontend (`app/` — the Admin 2.0 dashboard) needs: a "Send Follow-up" button on each eligible lead row, disabled/hidden when `is_safe_to_send` is not `true`; a confirmation dialog wired to Gate 2's `409` response; and a preview/edit step before the final POST, per the design doc's §02 note that the operator can edit the message before sending. **This plan does not cover it** — the frontend directory could not be explored during this planning session (same read-permission issue noted at the top of this document). Scope it as its own plan once file access is confirmed working, using this backend's exact request/response contract from Task 9 (`POST /admin/leads/{session_id}/send-followup`, `{confirm_override: bool}`, status codes 200/400/403/409/423).

---

## Self-Review

**Spec coverage** (against the published design doc, "OyeChats — Ideal System Architecture"):

- Always-on IP signal (§01, top lane) → Tasks 2–3 ✓
- Free domain extraction (§01, bottom lane) → Task 4 ✓
- Reoon power-mode validation, chosen over quick mode from live test evidence (§01 bottom lane; §04) → Task 5 ✓
- Data model additions (§03 table: `LeadInfo` fields, suppression) → Task 6 ✓
- Wiring into lead capture, both lanes independent not chained (§01 merge box) → Task 8 ✓
- Manual trigger, 4 gates, no automation (§02) → Task 9 ✓
- Unsubscribe link the sent email needs (implied by Gate 3 existing at all) → Task 7 ✓
- Admin UI button → explicitly scoped out as Task 10, not silently dropped ✓

**Placeholder scan:** the `Depends(...)` operator-auth dependency and the `send_email` import path in Task 9, and the `create_or_update_lead_info` import in Task 8, are the only unresolved pieces — each is a named, concrete gap pointing at an exact Task 1 recon step, not a vague "add appropriate handling." Every other function in this plan has complete, runnable code.

**Type consistency:** `is_safe_to_send` (bool), `email_status` (str), `last_followup_sent_at` (datetime), `followup_sent_by_operator_id` (int FK) are defined once in Task 6 and referenced with identical names in Tasks 8 and 9. `extract_company_domain(email: str | None) -> str | None`, `verify_email(email: str) -> dict | None`, `fetch_ip_intel(ip_address: str) -> dict | None` are defined in Tasks 2/4/5 and called with matching signatures everywhere they're used.
