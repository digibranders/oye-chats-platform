# Visitor Intelligence — Plan Gating & Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the Visitor Intelligence feature set (IP-based company/threat signal, validated-email display, and the manual "Send Follow-up" action) to the **Professional** plan only; gate the real-time email-validation check (`/chat/validate-email` + the widget-side blur UX already shipped) to **Standard and Professional**; and build the currently-nonexistent Admin Dashboard UI that surfaces this data.

**Architecture:** Two new plan-slug gates are added to `plan_entitlements_service.py`, following the exact pattern already used for Lead Source Attribution and Journey Analytics (a hardcoded `frozenset` of plan slugs + a thin resolver function — no new DB columns or Plan.features JSONB keys needed). `build_lead_response()` gains an `include_visitor_intelligence` parameter that adds `is_valid_email` / `email_score` / `visitor_metadata` to the payload only when the caller's plan qualifies; `lead_routes.py` wires this the same way it already wires `include_attribution` / `include_intelligence`, and the manual follow-up endpoint's gate moves from the general `is_lead_intelligence_enabled` check to the new Professional-only check. `chat_routes.py`'s bot-authenticated endpoints get a bot-scoped companion gate (mirroring `is_lead_source_attribution_enabled_for_bot`) so a Free/Starter bot's widget skips the paid Reoon call entirely rather than just hiding its result later. The frontend mirrors every gate with a matching plan-slug constant (same pattern as `JourneyPage.tsx`'s `JOURNEY_PLAN_SLUGS`) and adds a new `LeadDetailDrawer` section plus a "Send Follow-up" action that did not exist before this plan.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (backend), React 19 + TypeScript (Admin Dashboard `app/`), pytest, Vitest/tsc/eslint via the project's standard checks.

---

## Scope note — what "visitor intelligence" means here

The pre-existing `contact.company` field (a plain text field visitors can type into the lead-capture form) is **not** touched by this plan and stays visible on every plan — it predates this feature and gating it now would be a regression, not a new paywall. "Visitor Intelligence" in this plan refers specifically to the **new, currently-unexposed** fields built in the earlier visitor-intelligence work:

- `ChatSession.visitor_metadata` — the always-on, background IP-intelligence signal (company/ASN/VPN-threat data from ipapi.is), captured for every visitor regardless of plan but never yet returned by any API response.
- `LeadInfo.is_valid_email` / `LeadInfo.email_score` — the Reoon-based email-validation result, captured in the background after lead capture, also never yet returned by any API response.
- The manual "Send Follow-up" action (`POST /leads/{session_id}/follow-up`) — built and gated (currently behind the general `is_lead_intelligence_enabled` check), but with **no Admin UI** to trigger it.

## File Structure

| File | Change |
|---|---|
| `api/app/services/plan_entitlements_service.py` | Add `VISITOR_INTELLIGENCE_SLUGS` + `is_visitor_intelligence_enabled()`; add `EMAIL_VALIDATION_SLUGS` + `is_email_validation_enabled_for_bot()` |
| `api/app/services/lead_service.py` | `build_lead_response()` gains `include_visitor_intelligence` param |
| `api/app/api/lead_routes.py` | Wire the new gate into `list_leads`, `get_lead_detail`; switch `send_manual_follow_up`'s gate |
| `api/app/api/chat_routes.py` | Gate `validate_email_endpoint` and the Reoon call inside `_enrich_lead_in_background` |
| `api/tests/test_plan_entitlements_service.py` | Unit tests for the two new account/slug-set gates |
| `api/tests/test_bot_entitlements.py` | Per-bot DB test for `is_email_validation_enabled_for_bot` |
| `api/tests/test_lead_service_visitor_intelligence.py` (new) | Unit tests for `build_lead_response`'s new param |
| `api/tests/test_lead_routes.py` | Update autouse fixture + existing follow-up gate test; add new gating tests |
| `api/tests/test_chat_routes_email_validation_gating.py` (new) | Tests for the plan gate on `/chat/validate-email` and background enrichment |
| `app/src/types/domain.ts` | Extend `Lead` with `is_valid_email`, `email_score`, `visitor_metadata` |
| `app/src/context/upgradeIntents.ts` | Add `view_visitor_intelligence` intent |
| `app/src/services/api.js` / `api.d.ts` | Add `sendLeadFollowUp()` |
| `app/src/features/leads/VisitorIntelligenceSection.tsx` (new) | Company/IP signal + email-validity display, locked card when not Professional |
| `app/src/features/leads/LeadDetailDrawer.tsx` | Render the new section + "Send Follow-up" action |
| `app/src/features/leads/LeadsPage.tsx` | Compute `visitorIntelligenceUnlocked`, pass to the drawer |

---

## Task 1: Backend entitlement gates

**Files:**
- Modify: `api/app/services/plan_entitlements_service.py`
- Test: `api/tests/test_plan_entitlements_service.py`
- Test: `api/tests/test_bot_entitlements.py`

- [ ] **Step 1: Write the failing tests for the account-level Visitor Intelligence gate**

Add to `api/tests/test_plan_entitlements_service.py`, right after the existing `TestIsLeadIntelligenceEnabled` class (after line 569, before the `# ── Chat history retention helper` comment):

```python
# ── Visitor intelligence plan-gate helper ────────────────────────────────────
#
# Visitor Intelligence (IP-based company/threat signal, validated-email
# display, manual follow-up action) is a Professional-only deliverable —
# strictly narrower than ``is_lead_intelligence_enabled`` (Starter+).


class TestIsVisitorIntelligenceEnabled:
    def _entitlements(self, slug: str) -> PlanEntitlements:
        return PlanEntitlements(
            client_id=1,
            plan_slug=slug,
            plan_name=slug.title(),
            subscription_status="active",
            limits={},
            features={},
        )

    @pytest.mark.parametrize("slug", ["free", "starter", "standard"])
    def test_non_professional_denied(self, slug):
        session = MagicMock()
        with patch(
            "app.services.plan_entitlements_service.get_entitlements",
            return_value=self._entitlements(slug),
        ):
            assert is_visitor_intelligence_enabled(1, session) is False

    def test_professional_allowed(self):
        session = MagicMock()
        with patch(
            "app.services.plan_entitlements_service.get_entitlements",
            return_value=self._entitlements("professional"),
        ):
            assert is_visitor_intelligence_enabled(1, session) is True

    def test_returns_false_on_entitlements_lookup_failure(self):
        session = MagicMock()
        with patch(
            "app.services.plan_entitlements_service.get_entitlements",
            side_effect=RuntimeError("cache down"),
        ):
            assert is_visitor_intelligence_enabled(1, session) is False
```

Add the two new names to the existing top-of-file import block in the same test file (find the line importing `is_lead_intelligence_enabled` and add `is_visitor_intelligence_enabled` next to it):

```python
from app.services.plan_entitlements_service import (
    ...,
    is_lead_intelligence_enabled,
    is_visitor_intelligence_enabled,
    ...,
)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_plan_entitlements_service.py::TestIsVisitorIntelligenceEnabled -v`
Expected: FAIL with `ImportError: cannot import name 'is_visitor_intelligence_enabled'`

- [ ] **Step 3: Implement the account-level gate**

In `api/app/services/plan_entitlements_service.py`, insert immediately after the `is_lead_intelligence_enabled` function (after the line `return entitlements.plan_slug != "free"` and before the `def get_chat_history_retention_days` block):

```python
# ── Visitor intelligence gate ────────────────────────────────────────────────
#
# Visitor Intelligence is the IP-based company/threat signal
# (``ChatSession.visitor_metadata``), the Reoon-validated email display
# (``LeadInfo.is_valid_email`` / ``email_score``), and the manual "Send
# Follow-up" action — all strictly Professional-only, narrower than the
# general lead-intelligence layer (score/tier/BANT), which is Starter+.
# Kept as its own frozenset (rather than reusing ``plan_slug != "free"``)
# so a future plan tier change to lead intelligence can't silently loosen
# this boundary too.
VISITOR_INTELLIGENCE_SLUGS: frozenset[str] = frozenset({"professional"})


def is_visitor_intelligence_enabled(client_id: int, db_session: Session) -> bool:
    """True iff this client's active plan includes Visitor Intelligence.

    Gates: the company/IP-threat signal and validated-email fields on the
    ``/leads`` responses, and the manual follow-up send endpoint. Denies
    on any resolver error — same deny-by-default policy as every other
    gate in this module.
    """
    try:
        entitlements = get_entitlements(client_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "visitor_intelligence_gate: entitlements lookup failed for client=%s — denying",
            client_id,
            exc_info=True,
        )
        return False
    return entitlements.plan_slug in VISITOR_INTELLIGENCE_SLUGS
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && uv run pytest tests/test_plan_entitlements_service.py::TestIsVisitorIntelligenceEnabled -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing test for the bot-scoped email-validation gate**

Add to `api/tests/test_bot_entitlements.py`, after `test_lead_source_attribution_is_per_bot`:

```python
def test_email_validation_is_per_bot_standard_and_professional_only(db):
    """Email validation keys on plan SLUG ({standard, professional}) — a
    bot on Starter must not fire the paid Reoon check."""
    client = _client(db, "emailval-perbot@e.com")
    standard = _plan(db, "standard", price=94900, bant=True)
    starter = _plan(db, "starter", price=44900, bant=False)
    bot_std = _bot(db, client, "bot-emailval-std")
    bot_starter = _bot(db, client, "bot-emailval-starter")
    _sub(db, client, standard, bot_id=bot_std.id)
    _sub(db, client, starter, bot_id=bot_starter.id)
    db.flush()

    assert ent.is_email_validation_enabled_for_bot(bot_std.id, db) is True
    assert ent.is_email_validation_enabled_for_bot(bot_starter.id, db) is False
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd api && DB_URL=<your local Postgres URL> uv run pytest tests/test_bot_entitlements.py::test_email_validation_is_per_bot_standard_and_professional_only -v`
Expected: FAIL with `AttributeError: module 'app.services.plan_entitlements_service' has no attribute 'is_email_validation_enabled_for_bot'`

(If you don't have `DB_URL` set for local Postgres, this test is skipped rather than failing — that's fine, the DB-gated suite runs in CI. Proceed to implement regardless.)

- [ ] **Step 7: Implement the bot-scoped gate**

In `api/app/services/plan_entitlements_service.py`, insert directly after the `is_visitor_intelligence_enabled` function added in Step 3:

```python
# ── Real-time email validation gate (Standard + Professional) ───────────────
#
# The widget calls POST /chat/validate-email on the email field's blur event
# to block obviously-fake addresses before a visitor can submit the handoff
# or lead-capture form. This is a data-quality feature available one tier
# below Visitor Intelligence — Standard and Professional both get it; Free
# and Starter widgets skip the Reoon call entirely (not just hide its
# result), so a lower-tier bot never pays for a check it can't act on.
EMAIL_VALIDATION_SLUGS: frozenset[str] = frozenset({"standard", "professional"})


def is_email_validation_enabled_for_bot(bot_id: int, db_session: Session) -> bool:
    """True iff the plan funding THIS bot includes real-time email validation.

    Bot-scoped (mirrors :func:`is_lead_source_attribution_enabled_for_bot`)
    because the gated call sites — ``POST /chat/validate-email`` and the
    background lead-enrichment Reoon check — are both authenticated via
    ``X-Bot-Key``, not a client session. Denies on any resolver error.
    """
    try:
        entitlements = get_bot_entitlements(bot_id, db_session, include_usage=False)
    except Exception:
        logger.warning(
            "email_validation_gate: entitlements lookup failed for bot=%s — denying",
            bot_id,
            exc_info=True,
        )
        return False
    return entitlements.plan_slug in EMAIL_VALIDATION_SLUGS
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd api && DB_URL=<your local Postgres URL> uv run pytest tests/test_bot_entitlements.py::test_email_validation_is_per_bot_standard_and_professional_only -v`
Expected: PASS

- [ ] **Step 9: Run the full entitlements suite and lint**

Run: `cd api && uv run pytest tests/test_plan_entitlements_service.py tests/test_bot_entitlements.py -v && uv run ruff check app/services/plan_entitlements_service.py`
Expected: all PASS, ruff clean

- [ ] **Step 10: Commit**

```bash
git add api/app/services/plan_entitlements_service.py api/tests/test_plan_entitlements_service.py api/tests/test_bot_entitlements.py
git commit -m "feat: add Visitor Intelligence (Professional) and email-validation (Standard+) plan gates"
```

---

## Task 2: `build_lead_response` exposes the new fields behind the gate

**Files:**
- Modify: `api/app/services/lead_service.py:224-353`
- Test: `api/tests/test_lead_service_visitor_intelligence.py` (new)

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_lead_service_visitor_intelligence.py`:

```python
"""build_lead_response — Visitor Intelligence fields (is_valid_email,
email_score, visitor_metadata), gated by include_visitor_intelligence.

Mirrors the existing include_attribution / include_intelligence tests in
spirit: the fields are absent by default and only appear when the caller
opts in (i.e. when the route already confirmed the plan qualifies).
"""

from datetime import UTC, datetime
from types import SimpleNamespace

from app.services.lead_service import build_lead_response


def _session(**overrides):
    base = dict(
        id="sess-1",
        bant_score=0,
        behavioral_score=0,
        dimension_scores=None,
        dimensions_assessed=0,
        bant_last_updated=None,
        bant_need=None,
        bant_budget=None,
        bant_authority=None,
        bant_timeline=None,
        qualification_framework="bant",
        location=None,
        device=None,
        visit_count=1,
        page_url=None,
        referrer=None,
        utm_params=None,
        lead_viewed_at=None,
        created_at=datetime(2026, 4, 1, tzinfo=UTC),
        last_active_at=datetime(2026, 4, 23, tzinfo=UTC),
        visitor_metadata=None,
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def _lead_info(**overrides):
    base = dict(name="Jane", email="jane@acme.com", phone=None, company="Acme", is_valid_email=None, email_score=None)
    base.update(overrides)
    return SimpleNamespace(**base)


class TestVisitorIntelligenceFieldsDefaultOff:
    def test_fields_absent_when_not_requested(self):
        payload = build_lead_response(_session(), _lead_info(is_valid_email=True, email_score=92))
        assert "is_valid_email" not in payload["contact"]
        assert "email_score" not in payload["contact"]
        assert "visitor_metadata" not in payload

    def test_fields_absent_with_no_lead_info(self):
        payload = build_lead_response(_session(visitor_metadata={"company": "Acme"}), None, include_visitor_intelligence=True)
        # No lead_info at all — contact stays None, but the session-level
        # visitor_metadata signal is still surfaced (it exists independent
        # of whether the visitor ever submitted a form).
        assert payload["contact"] is None
        assert payload["visitor_metadata"] == {"company": "Acme"}


class TestVisitorIntelligenceFieldsWhenEnabled:
    def test_email_validity_and_score_included(self):
        payload = build_lead_response(
            _session(),
            _lead_info(is_valid_email=True, email_score=87),
            include_visitor_intelligence=True,
        )
        assert payload["contact"]["is_valid_email"] is True
        assert payload["contact"]["email_score"] == 87

    def test_visitor_metadata_included_from_session(self):
        ip_intel = {"company": "Acme Corp", "asn": "AS15169", "is_vpn": False}
        payload = build_lead_response(
            _session(visitor_metadata=ip_intel),
            _lead_info(),
            include_visitor_intelligence=True,
        )
        assert payload["visitor_metadata"] == ip_intel

    def test_visitor_metadata_defaults_to_none_when_unresolved(self):
        payload = build_lead_response(_session(), _lead_info(), include_visitor_intelligence=True)
        assert payload["visitor_metadata"] is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_lead_service_visitor_intelligence.py -v`
Expected: FAIL — `TypeError: build_lead_response() got an unexpected keyword argument 'include_visitor_intelligence'`

- [ ] **Step 3: Implement the new parameter and fields**

In `api/app/services/lead_service.py`, change the `build_lead_response` signature (line 224-231):

```python
def build_lead_response(
    session: ChatSession,
    lead_info: LeadInfo | None,
    message_count: int = 0,
    bot: Bot | None = None,
    *,
    include_attribution: bool = False,
    include_intelligence: bool = True,
    include_visitor_intelligence: bool = False,
) -> dict:
```

Update the docstring (immediately below the signature) by adding this paragraph after the existing `include_intelligence` paragraph (before the `BR-01:` paragraph):

```python
    ``include_visitor_intelligence`` gates the Professional-only Visitor
    Intelligence layer: the Reoon-validated ``is_valid_email`` / `email_score`
    on ``contact``, and the top-level ``visitor_metadata`` IP-intelligence
    block (company/ASN/VPN-threat signal captured in the background for
    every visitor, regardless of plan — this flag only controls whether it's
    ever returned in the API response). Route boundary:
    ``is_visitor_intelligence_enabled``. Unlike ``include_intelligence``,
    these keys are never present in the base payload and are only added
    when this flag is True — there's nothing to strip on lower tiers
    because the fields don't exist in the payload at all otherwise.
```

Update the `contact` construction (lines 264-271) to add the two fields only when enabled:

```python
    contact = None
    if lead_info is not None:
        contact = {
            "name": lead_info.name,
            "email": lead_info.email,
            "phone": lead_info.phone,
            "company": lead_info.company,
        }
        if include_visitor_intelligence:
            contact["is_valid_email"] = lead_info.is_valid_email
            contact["email_score"] = lead_info.email_score
```

Add `visitor_metadata` to the top-level `payload` dict. In the `payload: dict = {...}` block (lines 296-314), add one line right after `"unread": lead_viewed_at is None,`:

```python
        "unread": lead_viewed_at is None,
        "lead_viewed_at": _isoformat_or_none(lead_viewed_at),
    }

    if include_visitor_intelligence:
        payload["visitor_metadata"] = getattr(session, "visitor_metadata", None)
```

(This replaces the closing `}` of the existing `payload = {...}` literal — the dict now closes right after `lead_viewed_at`, and `visitor_metadata` is added conditionally afterward, same style as the existing `if not include_intelligence:` / `if include_attribution:` blocks further down.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && uv run pytest tests/test_lead_service_visitor_intelligence.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Run the full lead_service-adjacent suite to check for regressions**

Run: `cd api && uv run pytest tests/test_lead_routes.py tests/test_qualification_framework_readers.py tests/test_lead_service_visitor_intelligence.py -v`
Expected: all PASS (existing tests don't pass `include_visitor_intelligence`, so they exercise the default-False path — must stay green unchanged)

- [ ] **Step 6: Commit**

```bash
git add api/app/services/lead_service.py api/tests/test_lead_service_visitor_intelligence.py
git commit -m "feat: build_lead_response exposes Visitor Intelligence fields behind include_visitor_intelligence"
```

---

## Task 3: Wire the gate into `lead_routes.py` and re-point the follow-up gate

**Files:**
- Modify: `api/app/api/lead_routes.py`
- Test: `api/tests/test_lead_routes.py`

- [ ] **Step 1: Update the autouse fixture so existing tests keep passing**

In `api/tests/test_lead_routes.py`, update the `_allow_leads_dashboard` fixture (lines 24-36) to also stub the new gate, since `send_manual_follow_up` will call it after this task:

```python
@pytest.fixture(autouse=True)
def _allow_leads_dashboard(monkeypatch):
    """Every route in this file assumes the caller has paid-tier leads
    access — the plan gates are exercised in ``test_plan_entitlements_service``
    and in ``TestFreePlanIntelligenceStripping`` / ``TestVisitorIntelligenceGating``
    below. Stub them here so we don't have to mock a full entitlements
    resolver in every test's session fixture. ``patch`` at import site so
    both the router-level dependency and the in-handler checks see the stub.
    """
    from app.api import lead_routes as _lead_routes

    monkeypatch.setattr(_lead_routes, "is_leads_dashboard_enabled", lambda *_a, **_k: True)
    monkeypatch.setattr(_lead_routes, "is_lead_intelligence_enabled", lambda *_a, **_k: True)
    monkeypatch.setattr(_lead_routes, "is_visitor_intelligence_enabled", lambda *_a, **_k: True)
```

- [ ] **Step 2: Write the failing tests for the new response-shaping + gate switch**

Add to the end of `api/tests/test_lead_routes.py`:

```python
class TestVisitorIntelligenceGating:
    def test_follow_up_denied_when_not_professional(self, monkeypatch):
        """send_manual_follow_up now gates on Visitor Intelligence
        (Professional-only), NOT the general lead-intelligence check —
        a Starter/Standard client must be denied even though they pass
        is_lead_intelligence_enabled."""
        from app.api import lead_routes

        monkeypatch.setattr(lead_routes, "is_visitor_intelligence_enabled", lambda *_a, **_k: False)

        session = MagicMock()
        _install_scalars_chain(session, [1], _chat_session_row(), _lead_info())
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        with patch("app.api.lead_routes.send_email_async") as mock_send:
            response = TestClient(_build_app(auth_override=_client_auth())).post("/leads/lead-1/follow-up")

        assert response.status_code == 403
        assert "not enabled" in response.json()["detail"].lower()
        mock_send.assert_not_called()

    def test_get_lead_detail_includes_visitor_fields_when_professional(self, monkeypatch):
        from app.api import lead_routes

        monkeypatch.setattr(lead_routes, "is_visitor_intelligence_enabled", lambda *_a, **_k: True)

        session = MagicMock()
        lead = _lead_info(is_valid_email=True, email_score=91)
        chat_session_row = _chat_session_row()
        chat_session_row.visitor_metadata = {"company": "Acme"}
        _install_scalars_chain(session, [1], chat_session_row, _bot_row(), lead, [])
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads/lead-1")

        assert response.status_code == 200
        body = response.json()
        assert body["contact"]["is_valid_email"] is True
        assert body["contact"]["email_score"] == 91
        assert body["visitor_metadata"] == {"company": "Acme"}

    def test_get_lead_detail_omits_visitor_fields_when_not_professional(self, monkeypatch):
        from app.api import lead_routes

        monkeypatch.setattr(lead_routes, "is_visitor_intelligence_enabled", lambda *_a, **_k: False)

        session = MagicMock()
        lead = _lead_info(is_valid_email=True, email_score=91)
        chat_session_row = _chat_session_row()
        chat_session_row.visitor_metadata = {"company": "Acme"}
        _install_scalars_chain(session, [1], chat_session_row, _bot_row(), lead, [])
        monkeypatch.setattr(lead_routes, "get_session", lambda: _session_context(session))

        response = TestClient(_build_app(auth_override=_client_auth())).get("/leads/lead-1")

        assert response.status_code == 200
        body = response.json()
        assert "is_valid_email" not in body["contact"]
        assert "visitor_metadata" not in body
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_lead_routes.py::TestVisitorIntelligenceGating -v`
Expected: FAIL — `test_follow_up_denied_when_not_professional` gets 200 instead of 403 (still using the old gate); the other two fail because `visitor_metadata`/`is_valid_email` are missing from the response.

- [ ] **Step 4: Wire the gate into `list_leads` and `get_lead_detail`**

In `api/app/api/lead_routes.py`, update the import block (lines ~22-26):

```python
from app.services.plan_entitlements_service import (
    is_lead_intelligence_enabled,
    is_lead_source_attribution_enabled,
    is_leads_dashboard_enabled,
    is_visitor_intelligence_enabled,
)
```

In `list_leads`, after the line `intelligence_enabled = is_lead_intelligence_enabled(auth["client_id"], session)`, add:

```python
        visitor_intelligence_enabled = is_visitor_intelligence_enabled(auth["client_id"], session)
```

And update the `build_lead_response(...)` call inside the loop to pass it through:

```python
            lead = build_lead_response(
                chat_session,
                lead_info_map.get(chat_session.id),
                msg_count,
                bot=bot_map.get(chat_session.bot_id),
                include_attribution=attribution_enabled,
                include_intelligence=intelligence_enabled,
                include_visitor_intelligence=visitor_intelligence_enabled,
            )
```

In `get_lead_detail`, after the line `intelligence_enabled = is_lead_intelligence_enabled(auth["client_id"], session)`, add:

```python
        visitor_intelligence_enabled = is_visitor_intelligence_enabled(auth["client_id"], session)
```

And update its `build_lead_response(...)` call:

```python
        lead = build_lead_response(
            chat_session,
            lead_info,
            msg_count,
            bot=bot,
            include_attribution=attribution_enabled,
            include_intelligence=intelligence_enabled,
            include_visitor_intelligence=visitor_intelligence_enabled,
        )
```

- [ ] **Step 5: Re-point `send_manual_follow_up`'s gate**

In `api/app/api/lead_routes.py`, inside `send_manual_follow_up`, replace:

```python
        if not is_lead_intelligence_enabled(auth["client_id"], session):
            raise HTTPException(status_code=403, detail="Lead Intelligence not enabled on your plan")
```

with:

```python
        if not is_visitor_intelligence_enabled(auth["client_id"], session):
            raise HTTPException(status_code=403, detail="Visitor Intelligence not enabled on your plan")
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd api && uv run pytest tests/test_lead_routes.py -v`
Expected: all PASS, including the new `TestVisitorIntelligenceGating` class and every pre-existing test (the autouse fixture keeps `TestSendManualFollowUp`'s gate-1/2/3/4 tests green since it now stubs `is_visitor_intelligence_enabled` to `True` by default).

- [ ] **Step 7: Lint**

Run: `cd api && uv run ruff check app/api/lead_routes.py`
Expected: clean

- [ ] **Step 8: Commit**

```bash
git add api/app/api/lead_routes.py api/tests/test_lead_routes.py
git commit -m "feat: gate lead visitor-intelligence fields and manual follow-up to Professional plan"
```

---

## Task 4: Gate `/chat/validate-email` and background Reoon enrichment to Standard+Professional

**Files:**
- Modify: `api/app/api/chat_routes.py:397-420,789-824`
- Test: `api/tests/test_chat_routes_email_validation_gating.py` (new)

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_chat_routes_email_validation_gating.py`:

```python
"""Plan gating for real-time email validation (Standard + Professional).

A Free/Starter bot must never fire the paid Reoon call — not just have its
result hidden. Both the real-time widget endpoint and the background
lead-enrichment path are covered.
"""

from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.auth import get_current_bot
from app.api.chat_routes import router


def _bot(bot_id: int = 1):
    return MagicMock(id=bot_id, bot_key="bot-1", client_id=1)


def _build_app(bot):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_bot] = lambda: bot
    return app


class TestValidateEmailEndpointGating:
    def test_skips_reoon_and_returns_valid_when_plan_lacks_feature(self, monkeypatch):
        from app.api import chat_routes

        monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: False)
        with patch("app.services.reoon_service.verify_email") as mock_verify:
            response = TestClient(_build_app(_bot())).post(
                "/chat/validate-email", json={"email": "junk@disposable-mail.test"}
            )

        assert response.status_code == 200
        assert response.json() == {"valid": True}
        mock_verify.assert_not_called()

    def test_runs_reoon_when_plan_has_feature(self, monkeypatch):
        from app.api import chat_routes

        monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: True)
        with patch(
            "app.services.reoon_service.verify_email",
            return_value={"is_valid_syntax": True, "is_disposable": True},
        ) as mock_verify:
            response = TestClient(_build_app(_bot())).post(
                "/chat/validate-email", json={"email": "junk@disposable-mail.test"}
            )

        assert response.status_code == 200
        assert response.json()["valid"] is False
        mock_verify.assert_called_once()


class TestBackgroundEnrichmentGating:
    def test_reoon_skipped_for_bot_without_feature(self, monkeypatch):
        from app.api import chat_routes
        from app.db.models import LeadInfo

        monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: False)

        lead = MagicMock(spec=LeadInfo)
        session = MagicMock()
        session.query.return_value.filter.return_value.first.return_value = lead

        with (
            patch("app.services.email_domain_service.extract_company_domain", return_value="acme.com") as mock_domain,
            patch("app.services.reoon_service.verify_email") as mock_verify,
            patch("app.api.chat_routes.get_session") as mock_get_session,
        ):
            mock_get_session.return_value.__enter__.return_value = session
            chat_routes._enrich_lead_in_background("sess-1", "person@acme.com", bot_id=1)

        mock_domain.assert_called_once()  # free — always runs
        mock_verify.assert_not_called()  # paid — gated

    def test_reoon_runs_for_bot_with_feature(self, monkeypatch):
        from app.api import chat_routes
        from app.db.models import LeadInfo

        monkeypatch.setattr(chat_routes, "is_email_validation_enabled_for_bot", lambda *_a, **_k: True)

        lead = MagicMock(spec=LeadInfo)
        session = MagicMock()
        session.query.return_value.filter.return_value.first.return_value = lead

        with (
            patch("app.services.email_domain_service.extract_company_domain", return_value="acme.com"),
            patch(
                "app.services.reoon_service.verify_email",
                return_value={"status": "safe", "is_valid_syntax": True},
            ) as mock_verify,
            patch("app.api.chat_routes.get_session") as mock_get_session,
        ):
            mock_get_session.return_value.__enter__.return_value = session
            chat_routes._enrich_lead_in_background("sess-1", "person@acme.com", bot_id=1)

        mock_verify.assert_called_once()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_chat_routes_email_validation_gating.py -v`
Expected: FAIL — `_enrich_lead_in_background()` doesn't accept a `bot_id` keyword yet, and `is_email_validation_enabled_for_bot` isn't imported/used in `chat_routes.py` yet.

- [ ] **Step 3: Gate `validate_email_endpoint`**

In `api/app/api/chat_routes.py`, add the import near the top (alongside the other service imports — find the block importing from `app.services.plan_entitlements_service` used in `lead_capture_endpoint`, or add a new top-level import since it's now used in two places):

```python
from app.services.plan_entitlements_service import (
    is_email_validation_enabled_for_bot,
    is_lead_source_attribution_enabled_for_bot,
)
```

(If `is_lead_source_attribution_enabled_for_bot` is currently imported locally inside `lead_capture_endpoint` rather than at module scope, leave that local import alone — just add the new top-level import for `is_email_validation_enabled_for_bot` on its own line instead of merging the two.)

Replace the body of `validate_email_endpoint` (lines 789-824):

```python
@router.post("/chat/validate-email")
@limiter.limit("20/minute", key_func=key_from_bot_key)
def validate_email_endpoint(body: ValidateEmailRequest, request: Request, bot: Bot = Depends(get_current_bot)):
    """Real-time check the widget calls on email-field blur, before the
    visitor can submit the handoff or offline-message form. Auth: X-Bot-Key.

    Standard + Professional plans only — gated per-bot via
    ``is_email_validation_enabled_for_bot`` so a Free/Starter bot never
    fires the paid Reoon call (not just hides its result): the widget
    still submits the form normally, exactly as it did before this
    feature existed.

    Deliberately lenient: blocks only unambiguous junk (bad syntax,
    disposable addresses, spamtraps, domains with no working mail server).
    Catch-all and "unknown" results are let through — many real B2B
    companies run catch-all mail gateways that Reoon can't confirm
    deliverability on either way, and this endpoint's job is to keep fake
    leads out, not to reject genuine visitors it can't fully verify. Fails
    open (valid=True) if Reoon is unreachable, unconfigured, or the bot's
    plan doesn't include this feature — an infra hiccup or a lower tier
    must never block a real visitor from talking to a human. See
    docs/superpowers/plans/2026-08-08-visitor-intelligence.md.
    """
    email = body.email.strip().lower()
    if not _EMAIL_RE.match(email):
        return {"valid": False, "reason": "Please enter a valid email address."}

    with get_session() as session:
        if not is_email_validation_enabled_for_bot(bot.id, session):
            return {"valid": True}

    from app.services.reoon_service import verify_email

    validation = verify_email(email)
    if validation is None:
        return {"valid": True}

    is_junk = (
        not validation.get("is_valid_syntax", True)
        or validation.get("is_disposable") is True
        or validation.get("is_spamtrap") is True
        or validation.get("status") == "invalid"
        or validation.get("mx_accepts_mail") is False
    )
    if is_junk:
        return {"valid": False, "reason": "This email address doesn't look right — mind double-checking it?"}
    return {"valid": True}
```

- [ ] **Step 4: Run the endpoint-gating tests**

Run: `cd api && uv run pytest tests/test_chat_routes_email_validation_gating.py::TestValidateEmailEndpointGating -v`
Expected: PASS

- [ ] **Step 5: Gate the background enrichment's Reoon call**

In `api/app/api/chat_routes.py`, update `_enrich_lead_in_background`'s signature and body (lines 397-420ish):

```python
def _enrich_lead_in_background(session_id: str, email: str | None, bot_id: int | None = None):
    """Fire-and-forget: free domain extraction + Reoon power-mode validation.

    Two independent checks, not chained — the domain is free and always
    attempted regardless of plan; Reoon validation (paid, Standard+
    Professional only — checked via ``is_email_validation_enabled_for_bot``)
    determines is_valid_email/email_score but never blocks the domain from
    being written, and neither one ever blocks lead capture itself (that
    already succeeded before this was scheduled). Power mode can take
    seconds to over a minute per Reoon's own docs — that's fine here since
    nothing is waiting on this thread. ``bot_id`` is optional only for
    backward-compat with any already-queued background task from before
    this signature changed; a missing bot_id denies the paid check
    (deny-by-default), matching every other gate in this codebase.
    """
    if not email:
        return

    from app.db.models import LeadInfo
    from app.services.email_domain_service import extract_company_domain

    domain = extract_company_domain(email)

    validation = None
    with get_session() as session:
        if bot_id is not None and is_email_validation_enabled_for_bot(bot_id, session):
            from app.services.reoon_service import verify_email

            validation = verify_email(email)

    with get_session() as session:
        lead = session.query(LeadInfo).filter(LeadInfo.session_id == session_id).first()
        if not lead:
```

(The remainder of the function body — assigning `lead.company`, `lead.is_valid_email`, `lead.email_score`, and `session.commit()` — is unchanged; only the two lines above the existing `with get_session() as session:` / `lead = session.query(...)` block are replaced, and the pre-existing `validation = verify_email(email)` line that used to run unconditionally before the DB block is removed since `validation` is now set above.)

Update the one call site in `lead_capture_endpoint` (around line 876) to pass `bot_id`:

```python
            submit_background(_enrich_lead_in_background, body.session_id, body.email, bot.id)
```

- [ ] **Step 6: Run the full new test file**

Run: `cd api && uv run pytest tests/test_chat_routes_email_validation_gating.py -v`
Expected: PASS (4 tests)

- [ ] **Step 7: Run the full chat_routes suite to check for regressions**

Run: `cd api && uv run pytest tests/ -k "chat_routes or lead" -v`
Expected: all PASS

- [ ] **Step 8: Lint**

Run: `cd api && uv run ruff check app/api/chat_routes.py`
Expected: clean

- [ ] **Step 9: Commit**

```bash
git add api/app/api/chat_routes.py api/tests/test_chat_routes_email_validation_gating.py
git commit -m "feat: gate real-time and background email validation to Standard+Professional plans"
```

---

## Task 5: Frontend types + upgrade-intent copy

**Files:**
- Modify: `app/src/types/domain.ts:234-254`
- Modify: `app/src/context/upgradeIntents.ts`

- [ ] **Step 1: Extend the `Lead` interface**

In `app/src/types/domain.ts`, update the `LeadContact` interface (find it just above `Lead`) to add the two new optional contact fields, and add `visitor_metadata` to `Lead`:

```typescript
export interface LeadContact {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  /** Present only when the caller's plan includes Visitor Intelligence (Professional). */
  is_valid_email?: boolean | null;
  /** Present only when the caller's plan includes Visitor Intelligence (Professional). */
  email_score?: number | null;
}
```

(If `LeadContact` is defined inline rather than as a named interface, locate its actual declaration first via `grep -n "LeadContact" app/src/types/domain.ts` and add the same two fields there.)

Update `Lead` (lines 234-254) to add `visitor_metadata`:

```typescript
export interface Lead {
  session_id: string;
  score: number;
  bant_score?: number;
  behavioral_score?: number;
  tier: string;
  status: string;
  dimensions_assessed?: number;
  bant?: Record<string, LeadDimensionScore>;
  behavioral?: Record<string, unknown>;
  contact: LeadContact | null;
  location?: string;
  device?: string;
  chats?: number;
  created_at?: string | null;
  last_active_at?: string | null;
  unread?: boolean;
  lead_viewed_at?: string | null;
  /** Present only on plans with Lead Source Attribution enabled. */
  source?: Record<string, unknown>;
  /**
   * IP-based company/threat signal (ipapi.is), captured for every visitor
   * regardless of plan but only ever returned on plans with Visitor
   * Intelligence (Professional).
   */
  visitor_metadata?: Record<string, unknown> | null;
}
```

- [ ] **Step 2: Add the `view_visitor_intelligence` upgrade intent**

In `app/src/context/upgradeIntents.ts`, add the new key to the `UpgradeIntentKey` union (alongside `view_leads` / `view_journeys`):

```typescript
export type UpgradeIntentKey =
  | 'add_bot'
  | 'add_operator'
  | 'add_department'
  | 'add_canned_response'
  | 'view_support'
  | 'view_leads'
  | 'view_journeys'
  | 'view_visitor_intelligence'
  | 'leads_form'
  | 'view_team'
  | 'view_qualification'
  | 'view_integrations'
  | 'webhooks_integration'
  | 'meetings_integration'
  | 'advanced_settings'
  | 'widget_behavior'
  | 'branding_removable'
  | 'auto_recrawl'
  | 'topup_credits'
  | 'live_chat_appearance'
  | 'live_chat';
```

Add the builder entry to `UPGRADE_INTENTS`, right after the `view_journeys` entry:

```typescript
  view_visitor_intelligence: () => ({
    eyebrow: 'Visitor Intelligence is a Professional feature',
    title: 'Know who you’re talking to before they tell you',
    description:
      'Upgrade to Professional to see each visitor’s company signal, a validated deliverability score for every captured email, and to send a manual follow-up the moment a lead goes quiet.',
    highlights: [
      'Company & threat signal resolved from the visitor’s IP',
      'Reoon-validated email score — know a real inbox from a typo before you reach out',
      'One-click manual follow-up email, with built-in unsubscribe & cooldown safeguards',
    ],
    recommendedPlan: 'Professional',
  }),
```

- [ ] **Step 3: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: no new errors (this task only adds types/data, no consumers yet)

- [ ] **Step 4: Commit**

```bash
git add app/src/types/domain.ts app/src/context/upgradeIntents.ts
git commit -m "feat: add Visitor Intelligence types and upgrade-modal copy"
```

---

## Task 6: `sendLeadFollowUp` API client function

**Files:**
- Modify: `app/src/services/api.js`
- Modify: `app/src/services/api.d.ts`

- [ ] **Step 1: Add the function to `api.js`**

In `app/src/services/api.js`, add right after `markAllLeadsViewed` (after line 1823, before the `// ── Webhooks ──` comment):

```javascript
// Manually trigger a follow-up email for a captured lead. Every gate (valid
// email, cooldown, unsubscribe, bot pause) is enforced server-side — this
// call can come back 400/403/409/423 with a human-readable `detail`, which
// callers should surface rather than treat as a generic failure.
export const sendLeadFollowUp = async (sessionId, confirmOverride = false) => {
    try {
        const response = await api.post(`/leads/${sessionId}/follow-up`, {
            confirm_override: confirmOverride,
        });
        return response.data;
    } catch (error) {
        console.error('API Error sending lead follow-up:', error);
        throw buildApiError(error, 'Failed to send follow-up email');
    }
};
```

- [ ] **Step 2: Add the type declaration**

In `app/src/services/api.d.ts`, add right after the `markLeadViewed` declaration (line 273):

```typescript
export function markAllLeadsViewed(botId?: number): Promise<void>;
export interface SendFollowUpResult {
  success: boolean;
}
export function sendLeadFollowUp(sessionId: string, confirmOverride?: boolean): Promise<SendFollowUpResult>;
```

(If `markAllLeadsViewed` is already declared elsewhere in the file, don't duplicate it — just add the new `SendFollowUpResult` interface and `sendLeadFollowUp` declaration wherever the lead-related declarations are grouped.)

- [ ] **Step 3: Typecheck and lint**

Run: `cd app && npx tsc --noEmit && npm run lint`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add app/src/services/api.js app/src/services/api.d.ts
git commit -m "feat: add sendLeadFollowUp API client function"
```

---

## Task 7: `VisitorIntelligenceSection` component

**Files:**
- Create: `app/src/features/leads/VisitorIntelligenceSection.tsx`

This mirrors `LeadInsights.tsx`'s structure (safe readers over loosely-typed JSON, a `SectionTitle` header, an early-return when there's nothing to show) but adds a **locked** state, since — unlike source attribution/behavioral signals, which are simply absent on lower tiers — Visitor Intelligence needs an explicit upgrade nudge inside the drawer (the drawer isn't fully locked; only this one section is).

- [ ] **Step 1: Write the component**

```typescript
/**
 * VisitorIntelligenceSection - the Professional-only company/threat signal
 * + validated-email display inside the lead detail drawer, plus the manual
 * "Send Follow-up" action.
 *
 * Unlike `LeadInsights` (whose sections simply omit themselves when their
 * data is absent), this section is itself gated: on Free/Starter/Standard
 * it renders a compact locked teaser instead of the fields, since the data
 * genuinely doesn't exist in the API response on those plans (see
 * `build_lead_response`'s `include_visitor_intelligence` parameter).
 */
import { type ReactElement, useState } from 'react';
import { AlertTriangle, Building2, CheckCircle2, Lock, Mail, Send, Shield, XCircle } from 'lucide-react';
import { Button, StatusBadge } from '../../design-system';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import { sendLeadFollowUp } from '../../services/api';
import { type LeadDetail } from './useLeadDetail';

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function SectionTitle({ children }: { children: string }): ReactElement {
  return (
    <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-muted)]">
      <Shield size={13} aria-hidden="true" />
      {children}
    </h3>
  );
}

/** Compact locked teaser shown in place of the section on non-Professional plans. */
function LockedTeaser(): ReactElement {
  const { openUpgradeModal } = useUpgradeModal();
  return (
    <section className="space-y-3">
      <SectionTitle>Visitor Intelligence</SectionTitle>
      <button
        type="button"
        onClick={() => openUpgradeModal('view_visitor_intelligence')}
        className="flex w-full items-center gap-3 rounded-xl border border-dashed border-[var(--ds-border)] p-4 text-left transition-colors hover:border-[var(--ds-border-strong)]"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
          <Lock size={16} aria-hidden="true" />
        </span>
        <span className="min-w-0">
          <span className="block text-[13px] font-medium text-[var(--ds-text)]">
            Company signal & email validity are locked
          </span>
          <span className="block text-[12px] text-[var(--ds-text-subtle)]">
            Upgrade to Professional to see this and send a manual follow-up.
          </span>
        </span>
      </button>
    </section>
  );
}

function CompanySignal({ metadata }: { metadata: Record<string, unknown> }): ReactElement | null {
  const company = asString(metadata.company);
  const asn = asString(metadata.asn) ?? asString(metadata.org);
  const isVpn = metadata.is_vpn === true || metadata.is_proxy === true;
  if (!company && !asn && !isVpn) return null;

  return (
    <div className="space-y-2 rounded-xl border border-[var(--ds-border)] p-4">
      {company && (
        <div className="flex items-center gap-2.5 text-[13px] text-[var(--ds-text)]">
          <Building2 size={15} className="shrink-0 text-[var(--ds-text-subtle)]" aria-hidden="true" />
          <span className="break-words">{company}</span>
        </div>
      )}
      {asn && !company && <p className="text-[12px] text-[var(--ds-text-subtle)]">Network: {asn}</p>}
      {isVpn && (
        <div className="flex items-center gap-2 text-[12px]">
          <AlertTriangle size={13} className="shrink-0 text-[var(--ds-warning)]" aria-hidden="true" />
          <span className="text-[var(--ds-warning)]">Connecting via VPN/proxy — company signal may be unreliable</span>
        </div>
      )}
    </div>
  );
}

function EmailValidityBadge({ isValid, score }: { isValid: boolean | null | undefined; score: number | null | undefined }): ReactElement | null {
  if (isValid === null || isValid === undefined) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-[var(--ds-text-subtle)]">
        <Mail size={13} aria-hidden="true" />
        Email not yet validated
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      {isValid ? (
        <StatusBadge tone="success">
          <CheckCircle2 size={12} aria-hidden="true" className="mr-1 inline" />
          Deliverable{typeof score === 'number' ? ` · ${score}/100` : ''}
        </StatusBadge>
      ) : (
        <StatusBadge tone="danger">
          <XCircle size={12} aria-hidden="true" className="mr-1 inline" />
          Not confirmed deliverable
        </StatusBadge>
      )}
    </div>
  );
}

interface FollowUpActionProps {
  sessionId: string;
  eligible: boolean;
}

/** The manual "Send Follow-up" button — the only send path in this system;
 * there is no automatic/timed send anywhere. Every server-side gate can
 * still reject the click (409 cooldown offers a one-click override retry;
 * 400/403/423 surface as a plain error with no retry). */
function FollowUpAction({ sessionId, eligible }: FollowUpActionProps): ReactElement {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error' | 'cooldown'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function send(confirmOverride: boolean): Promise<void> {
    setState('sending');
    setMessage(null);
    try {
      await sendLeadFollowUp(sessionId, confirmOverride);
      setState('sent');
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Could not send the follow-up.';
      const status = (err as { status?: number } | undefined)?.status;
      if (status === 409) {
        setState('cooldown');
        setMessage(detail);
      } else {
        setState('error');
        setMessage(detail);
      }
    }
  }

  if (!eligible) return <></>;

  return (
    <div className="space-y-2">
      <Button
        size="sm"
        variant="outline"
        disabled={state === 'sending' || state === 'sent'}
        onClick={() => void send(false)}
      >
        <Send size={14} aria-hidden="true" />
        {state === 'sending' ? 'Sending…' : state === 'sent' ? 'Sent' : 'Send follow-up email'}
      </Button>
      {state === 'cooldown' && message && (
        <div className="space-y-1.5">
          <p className="text-[12px] text-[var(--ds-warning)]">{message}</p>
          <Button size="sm" variant="ghost" onClick={() => void send(true)}>
            Send anyway
          </Button>
        </div>
      )}
      {state === 'error' && message && <p className="text-[12px] text-[var(--ds-danger)]">{message}</p>}
    </div>
  );
}

export function VisitorIntelligenceSection({
  detail,
  unlocked,
}: {
  detail: LeadDetail;
  unlocked: boolean;
}): ReactElement {
  if (!unlocked) return <LockedTeaser />;

  const metadata = asRecord(detail.visitor_metadata);
  const hasCompanySignal = Object.keys(metadata).length > 0;
  const isValidEmail = detail.contact?.is_valid_email;
  const emailScore = detail.contact?.email_score;
  const eligibleForFollowUp = Boolean(detail.contact?.email) && isValidEmail === true;

  return (
    <section className="space-y-3">
      <SectionTitle>Visitor Intelligence</SectionTitle>
      <div className="space-y-3">
        {hasCompanySignal ? (
          <CompanySignal metadata={metadata} />
        ) : (
          <p className="rounded-xl border border-[var(--ds-border)] p-4 text-[12px] text-[var(--ds-text-subtle)]">
            No company signal resolved for this visitor's IP yet.
          </p>
        )}
        {detail.contact?.email && <EmailValidityBadge isValid={isValidEmail} score={emailScore} />}
        <FollowUpAction sessionId={detail.session_id} eligible={eligibleForFollowUp} />
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd app && npx tsc --noEmit`
Expected: no errors from this new file. If `StatusBadge`'s `tone` prop doesn't accept `"danger"`, check `design-system/components/PlanBadge.tsx` or `StatusBadge`'s type definition via `grep -n "tone" app/src/design-system/components/StatusBadge.tsx` and swap to whichever tone name the design system actually uses for a negative/error state (likely `"danger"` or `"error"` — match the existing enum exactly).

- [ ] **Step 3: Commit**

```bash
git add app/src/features/leads/VisitorIntelligenceSection.tsx
git commit -m "feat: add VisitorIntelligenceSection component (company signal, email validity, follow-up action)"
```

---

## Task 8: Wire the section into `LeadDetailDrawer` and `LeadsPage`

**Files:**
- Modify: `app/src/features/leads/LeadDetailDrawer.tsx:1-63,289-548`
- Modify: `app/src/features/leads/LeadsPage.tsx:213-219,787-795`

- [ ] **Step 1: Add the `visitorIntelligenceUnlocked` prop to `LeadDetailDrawer`**

In `app/src/features/leads/LeadDetailDrawer.tsx`, add the import (near the top, alongside the other feature imports):

```typescript
import { VisitorIntelligenceSection } from './VisitorIntelligenceSection';
```

Extend `LeadDetailDrawerProps` (after the `locked` prop, before `annotations`):

```typescript
  /**
   * True when the caller's plan includes Visitor Intelligence
   * (Professional). Controls whether `VisitorIntelligenceSection` renders
   * the company signal / email validity / follow-up action, or a locked
   * teaser in their place. Independent of `locked` — a Starter client
   * (unlocked lead intelligence, no Visitor Intelligence) sees the full
   * drawer with only this one section gated.
   */
  visitorIntelligenceUnlocked?: boolean;
```

Update the function signature to destructure it (default `false`):

```typescript
export function LeadDetailDrawer({
  data,
  onClose,
  view = 'detail',
  locked = false,
  visitorIntelligenceUnlocked = false,
  annotations,
}: LeadDetailDrawerProps): ReactElement {
```

Render the section right after `<LeadInsights detail={detail} />` (still inside the `{view === 'detail' && !locked && (<>...</>)}` block):

```typescript
            {/* Source attribution + behavioural signals (rendered only when present) */}
            <LeadInsights detail={detail} />

            {/* Company signal, email validity, and the manual follow-up action */}
            <VisitorIntelligenceSection detail={detail} unlocked={visitorIntelligenceUnlocked} />
              </>
            )}
```

- [ ] **Step 2: Compute and pass the flag from `LeadsPage`**

In `app/src/features/leads/LeadsPage.tsx`, add the plan-slug constant right after the existing `CONTACT_FILTER_OPTIONS` declaration (mirrors `JourneyPage.tsx`'s `JOURNEY_PLAN_SLUGS`):

```typescript
/**
 * Plan slugs allowed to see Visitor Intelligence (company signal, email
 * validity, manual follow-up). Mirrors ``VISITOR_INTELLIGENCE_SLUGS`` in
 * ``plan_entitlements_service.py`` — Professional only.
 */
const VISITOR_INTELLIGENCE_PLAN_SLUGS = new Set<string>(['professional']);
```

In the `LeadsPage` function body, update the `useEntitlements()` destructure (line 216) to also pull `planSlug`:

```typescript
  const { isFree, hasFeature, planSlug } = useEntitlements();
```

Add a derived flag right below `bantUnlocked`:

```typescript
  const bantUnlocked = hasFeature('bant');
  const visitorIntelligenceUnlocked = VISITOR_INTELLIGENCE_PLAN_SLUGS.has(planSlug);
```

Pass it to the drawer (in the `<LeadDetailDrawer ... />` render near the bottom, lines 787-795):

```typescript
      {selectedSessionId !== null && (
        <LeadDetailDrawer
          data={detailData}
          view={drawerView}
          locked={isFree}
          visitorIntelligenceUnlocked={visitorIntelligenceUnlocked}
          onClose={() => setSelectedSessionId(null)}
          annotations={annotations.controllerFor(selectedSessionId)}
        />
      )}
```

- [ ] **Step 3: Typecheck, lint, build**

Run: `cd app && npx tsc --noEmit && npm run lint && npm run build`
Expected: all clean

- [ ] **Step 4: Manual browser verification**

Run: start the admin dev server (`admin-dev` launch config, port 5174) and the API (`api` launch config, port 8000) if not already running. Open the Leads page, click into a lead that has a captured email:
- On a Free/Starter/Standard test account: the drawer's Visitor Intelligence section shows the locked teaser; clicking it opens the upgrade modal with the "Visitor Intelligence is a Professional feature" copy.
- On a Professional test account (or with `hasFeature`/`planSlug` temporarily mocked in devtools if no such seeded account exists locally): the section shows the company signal (or "No company signal resolved yet"), the email-validity badge, and — only when that lead's email is validated — the "Send follow-up email" button, which calls the real endpoint and reflects sending/sent/cooldown/error states.

- [ ] **Step 5: Commit**

```bash
git add app/src/features/leads/LeadDetailDrawer.tsx app/src/features/leads/LeadsPage.tsx
git commit -m "feat: wire Visitor Intelligence section and Send Follow-up action into the Leads UI"
```

---

## Task 9: Full-project verification pass

**Files:** none (verification only)

- [ ] **Step 1: Backend — full suite + lint**

Run: `cd api && uv run ruff check . && uv run pytest`
Expected: ruff clean; every test passes (including the pre-existing 3170+ that were green before this plan)

- [ ] **Step 2: Frontend — lint, typecheck, build**

Run: `cd app && npm run lint && npx tsc --noEmit && npm run build`
Expected: all clean

- [ ] **Step 3: Confirm branch and push readiness**

Run: `git branch --show-current`
Expected: `development` (per the project's git workflow rule — never commit to `main`)

- [ ] **Step 4: Report checks passed**

Summarize in the PR/commit description: "lint ✓ · format ✓ · build ✓ · pytest (backend) ✓ · tsc ✓ · eslint (frontend) ✓" per the Mandatory Pre-Completion Checks in `../CLAUDE.md`.

---

## Self-Review

**1. Spec coverage:**
- "Visitor intelligence [...] paid feature in professional plan only" → Task 1 (`is_visitor_intelligence_enabled`, Professional-only slug set), Task 2 (fields gated behind it), Task 3 (routes wired + follow-up gate switched), Task 7/8 (UI locked below Professional). ✅
- "email validation we can give [...] standard + professional plans" → Task 1 (`is_email_validation_enabled_for_bot`, Standard+Professional slug set), Task 4 (both the real-time endpoint and the background Reoon call gated). ✅
- "is admin dashboard ui ready [...] whole app/ build is pending" (the gap this plan fills) → Task 7 (new `VisitorIntelligenceSection`) + Task 8 (wired into the drawer + Leads page) build the entire missing UI: company/IP display, email-validity display, and the Send Follow-up action + button, none of which existed before. ✅

**2. Placeholder scan:** No "TBD"/"implement later"/"add error handling" placeholders. The one deliberately-open item — Step 2 of Task 7 telling the implementer to check the real `StatusBadge` tone enum — is a verification instruction with a concrete fallback (`"danger"` or `"error"`), not an unresolved design gap; every other step has literal, complete code.

**3. Type consistency:** `include_visitor_intelligence` (backend param) → `visitor_intelligence_enabled` (route-local variable) → `visitorIntelligenceUnlocked` (frontend prop) → `VISITOR_INTELLIGENCE_PLAN_SLUGS` (frontend constant) all refer to the same gate consistently across tasks. `is_visitor_intelligence_enabled` (account-level, used in `lead_routes.py`) vs. `is_email_validation_enabled_for_bot` (bot-scoped, used in `chat_routes.py`) are intentionally two different functions with two different signatures — this mirrors the codebase's existing split between `is_lead_source_attribution_enabled` (account) and `is_lead_source_attribution_enabled_for_bot` (bot), so the asymmetry is a correct application of an established pattern, not an inconsistency. `sendLeadFollowUp(sessionId, confirmOverride)` in Task 6 matches its usage in `FollowUpAction` (Task 7) and the backend's `SendFollowUpRequest.confirm_override` field (already shipped, unchanged by this plan).
