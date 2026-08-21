# Close the Remaining Capability Ledger Items — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four capability-ledger items confirmed still open after a full, code-verified audit of `oye-chats-platform/app/REBUILD.md` §5 against the actual `claude/ui-ux-redesign-review-laf0r4` branch: crawl limits are invisible before a crawl starts, a bot's true seat count (plan + purchased extra) is under-reported, live-chat state transitions are logged but never readable, and there is no admin-facing view of queue depth or wait times.

**Architecture:** Each item is backend-first, frontend-second, and independently shippable — none of the four blocks on another. Three touch `plan_entitlements_service.py` / `analytics_routes.py`, which already have the exact patterns to extend (see the "Existing pattern" note in each task); the fourth (audit trail) is a small new read endpoint on a table that has been write-only since the model was added. No new tables. No new dependencies.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 (`select()`/`func`) on the backend, matching `api/app/api/analytics_routes.py` and `api/app/db/repository.py`; React 19 + the `src/ui` design system + TanStack Query on the frontend, matching the rest of `app/src/features/`.

---

## How this list was produced

`REBUILD.md` §5 named ten items as still open. Nine of the ten were checked
against running code, not assumed from the document text, and six turned out
to already be built — the ledger just never got updated:

- Server-side lead pagination — already server-paged (`LeadsPage.tsx`'s own
  docstring: "The API has supported `tier`, `min_score`, `page` and `limit`
  the whole time").
- Operator profile edit — `ProfileSection.tsx` closes it directly, comment
  and all.
- Per-lead visitor journey — `LeadInsights.tsx`'s `buildJourney`.
- Live credit costs from `/credits/balance` — `UsagePage.tsx` renders
  `balance.costs`, not a hardcoded string.
- Chat-history pagination in the lead transcript — `useLeadDetail.ts` already
  runs cursor pagination (`beforeId`/`limit`, `TRANSCRIPT_PAGE_SIZE = 40`)
  against a 200-message ceiling.
- Seed-question re-editing — closed by a different, better design than a
  literal in-place edit: `MessagesSection.tsx` regenerates proposals via the
  same `POST /bots/{id}/seed-questions?force=true` endpoint and lets the
  customer fold them into the already fully-editable `welcome_suggestions`
  quick-action list.

`REBUILD.md` has been updated in this pass to reflect all of that. What is
below is the genuine remainder — verified against the FastAPI route table and
the SQLAlchemy models directly, not against the doc.

---

### Task 1: Surface the plan's crawl limits before a crawl starts

**Files:**
- Modify: `api/app/services/plan_entitlements_service.py:747-838` (`_compute`)
- Modify: `app/src/services/api.d.ts` (type for the entitlements `limits` shape, if declared there — see Step 1)
- Modify: `app/src/features/agents/knowledge/add/WebsiteFlow.tsx:62-200`
- Test: `api/tests/test_plan_entitlements_crawl_limits.py`
- Test: `app/src/features/agents/knowledge/add/WebsiteFlow.test.tsx`

The cap exists and is enforced (`document_routes.py:1421-1422`,
`plan_service.get_crawl_limits(plan)` → `max_crawl_pages`, `max_crawl_depth`,
`max_crawl_js_pages`, `max_crawl_concurrency`), but it is invisible until a
crawl is rejected. `GET /auth/me/entitlements` — the one call `useEntitlements`
makes — never includes it. Add the two customer-relevant numbers
(`max_crawl_pages`, `max_crawl_depth`) to the same `limits` dict every other
plan number already rides in, then show them on the form before the customer
picks a page count.

**Existing pattern to follow:** `_compute` already builds `limits = dict(plan.limits or {})` and then adjusts one key in place (the `operators` block right below it, `plan_entitlements_service.py:814-828`). This is the same shape: read two more numbers off `plan.limits`, no new query.

- [ ] **Step 1: Confirm `plan.limits` actually carries the two crawl keys today**

Run: `.venv/bin/python -c "
from app.db.session import get_session
from app.db.models import Plan
with get_session() as s:
    for p in s.query(Plan).all():
        print(p.slug, p.limits.get('max_crawl_pages'), p.limits.get('max_crawl_depth'))
"`
Expected: every plan slug prints two integers (or `-1` for unlimited on the top tier). If any plan prints `None`, stop and use `plan_service.get_crawl_limits(plan)` instead of reading `plan.limits` directly in Step 2 — that function already has the fallback logic for a missing key.

- [ ] **Step 2: Write the failing backend test**

```python
# api/tests/test_plan_entitlements_crawl_limits.py
"""The plan's crawl page/depth cap rides in the entitlements payload the
console already fetches, so WebsiteFlow can show it before a crawl starts
instead of only after one is rejected."""

import pytest

pytestmark = pytest.mark.skipif(
    __import__("os").getenv("DB_URL") is None, reason="needs a reachable Postgres at DB_URL"
)


def test_entitlements_limits_include_crawl_page_and_depth_caps(db):
    from app.db.models import Client, Plan, Subscription
    from app.services.plan_entitlements_service import get_entitlements

    plan = db.query(Plan).filter(Plan.slug == "starter").one()
    client = Client(name="Crawl Cap Co", email="crawlcap@test.example", api_key="key-crawlcap")
    db.add(client)
    db.flush()
    db.add(Subscription(client_id=client.id, plan_id=plan.id, status="active"))
    db.commit()

    entitlements = get_entitlements(client.id, db, use_cache=False)

    assert entitlements.limits["max_crawl_pages"] == plan.limits.get("max_crawl_pages")
    assert entitlements.limits["max_crawl_depth"] == plan.limits.get("max_crawl_depth")
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd api && DB_URL=<test-db-url> uv run pytest tests/test_plan_entitlements_crawl_limits.py -v`
Expected: `KeyError: 'max_crawl_pages'` — the key genuinely is not there yet.

- [ ] **Step 4: Add the two keys in `_compute`**

In `api/app/services/plan_entitlements_service.py`, immediately after the existing `operators` adjustment block (ends around line 828, right before `result = PlanEntitlements(...)`):

```python
    # Crawl page/depth caps ride in `plan.limits` already (enforced in
    # `document_routes.py`), but were never exposed here, so the console had
    # no way to tell a customer their cap before a crawl was rejected for
    # hitting it. Read-only pass-through — no adjustment needed, unlike
    # `operators`/`bots`, because there is no purchasable add-on for either.
    limits["max_crawl_pages"] = plan.limits.get("max_crawl_pages", UNLIMITED)
    limits["max_crawl_depth"] = plan.limits.get("max_crawl_depth", UNLIMITED)
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd api && DB_URL=<test-db-url> uv run pytest tests/test_plan_entitlements_crawl_limits.py -v`
Expected: PASS

- [ ] **Step 6: Commit the backend half**

```bash
cd api
git add app/services/plan_entitlements_service.py tests/test_plan_entitlements_crawl_limits.py
git commit -m "feat: expose the plan's crawl page/depth cap in /auth/me/entitlements"
```

- [ ] **Step 7: Check the frontend entitlements type for the new keys**

Run: `grep -n "interface.*Limit\|LimitKey" app/src/hooks/useEntitlements.ts app/src/services/api.d.ts`
Add `max_crawl_pages` and `max_crawl_depth` to whatever union/interface those greps surface (the file backing `LimitKey` in `useEntitlements.ts`), following the exact style of the existing `'bots' | 'operators' | 'documents' | ...` entries already there.

- [ ] **Step 8: Read `WebsiteFlow.tsx` to find where the URL is submitted**

Run: `sed -n '1,80p' app/src/features/agents/knowledge/add/WebsiteFlow.tsx`
Confirm the exact prop name for `useEntitlements` import (the file may not import it yet) and the exact JSX location of the `Field label="Website address"` block (`WebsiteFlow.tsx:183` today) — this is where the cap note goes, directly under that field.

- [ ] **Step 9: Write the failing frontend test**

```tsx
// app/src/features/agents/knowledge/add/WebsiteFlow.test.tsx (new describe block if the file exists, new file if not)
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WebsiteFlow } from './WebsiteFlow';

vi.mock('../../../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    limitFor: (key: string) => (key === 'max_crawl_pages' ? 100 : key === 'max_crawl_depth' ? 3 : -1),
  }),
}));

describe('WebsiteFlow — crawl cap', () => {
  it('states the plan’s page and depth cap before a crawl starts', () => {
    render(<WebsiteFlow botId={1} onDiscovered={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/up to 100 pages, 3 levels deep/i)).toBeInTheDocument();
  });
});
```

Adjust the rendered props (`botId`/`onDiscovered`/`onCancel`) to match `WebsiteFlow`'s real prop signature once Step 8's read confirms it — this plan cannot see the exact interface without that read.

- [ ] **Step 10: Run it to confirm it fails**

Run: `cd app && npx vitest run src/features/agents/knowledge/add/WebsiteFlow.test.tsx`
Expected: FAIL — no such text on screen.

- [ ] **Step 11: Add the cap note to the form**

In `WebsiteFlow.tsx`, import `useEntitlements` from `'../../../../hooks/useEntitlements'` and add directly under the `Field label="Website address"` block:

```tsx
const { limitFor } = useEntitlements();
const maxPages = limitFor('max_crawl_pages');
const maxDepth = limitFor('max_crawl_depth');
```

```tsx
{maxPages > 0 ? (
  <p className="text-xs text-text-tertiary">
    Your plan crawls up to {maxPages} pages, {maxDepth} levels deep.
  </p>
) : null}
```

(`limitFor` returns `-1` for unlimited per the existing `UNLIMITED` sentinel convention in `useEntitlements.ts` — the `maxPages > 0` guard is deliberately not `!== null`, matching that sentinel, so an unlimited plan shows nothing rather than "up to -1 pages".)

- [ ] **Step 12: Run the test to confirm it passes**

Run: `cd app && npx vitest run src/features/agents/knowledge/add/WebsiteFlow.test.tsx`
Expected: PASS

- [ ] **Step 13: Full checks and commit**

```bash
cd app
npx tsc --noEmit && npm run lint && npm run build
git add src/features/agents/knowledge/add/WebsiteFlow.tsx src/features/agents/knowledge/add/WebsiteFlow.test.tsx src/hooks/useEntitlements.ts
git commit -m "feat: show the plan's crawl page/depth cap on the website-crawl form"
```

---

### Task 2: Count a purchased extra bot seat, not just the plan's included ones

**Files:**
- Modify: `api/app/services/plan_entitlements_service.py:747-838` (`_compute`), `:77` (imports)
- Test: `api/tests/test_plan_entitlements_extra_bot_seats.py`

`Client.max_bots` (default 100, `api/app/db/models.py:98`) and
`Client.extra_bot_seats` (default 0, `:104`) exist for exactly this — the
column comment literally states the formula:
`min(plan.limits.bots + extra_bot_seats, plan.limits.max_bots_cap)`. Nothing
reads `extra_bot_seats` anywhere in `plan_entitlements_service.py` today, so a
workspace that bought extra bot seats sees the same limit as one that did not.
`GeneralPage.tsx:180`'s `botLimit = limitFor('bots')` already renders whatever
this returns — no frontend change is needed once the backend number is right.

**Existing pattern to follow:** the `operators` limit three lines above where this goes (`plan_entitlements_service.py:814-828`) does the identical "ceiling vs. what was actually granted" adjustment for seats — same shape, different column.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_plan_entitlements_extra_bot_seats.py
"""A workspace that bought extra bot seats must see them in its bot limit,
not just the plan's included count — `Client.extra_bot_seats` exists for
exactly this and nothing read it."""

import pytest

pytestmark = pytest.mark.skipif(
    __import__("os").getenv("DB_URL") is None, reason="needs a reachable Postgres at DB_URL"
)


def test_extra_bot_seats_add_to_the_plan_limit(db):
    from app.db.models import Client, Plan, Subscription
    from app.services.plan_entitlements_service import get_entitlements

    plan = db.query(Plan).filter(Plan.slug == "starter").one()
    base_bots = plan.limits.get("bots")
    client = Client(
        name="Extra Seats Co",
        email="extraseats@test.example",
        api_key="key-extraseats",
        extra_bot_seats=3,
    )
    db.add(client)
    db.flush()
    db.add(Subscription(client_id=client.id, plan_id=plan.id, status="active"))
    db.commit()

    entitlements = get_entitlements(client.id, db, use_cache=False)

    assert entitlements.limits["bots"] == base_bots + 3


def test_zero_extra_seats_leaves_the_plan_limit_unchanged(db):
    from app.db.models import Client, Plan, Subscription
    from app.services.plan_entitlements_service import get_entitlements

    plan = db.query(Plan).filter(Plan.slug == "starter").one()
    base_bots = plan.limits.get("bots")
    client = Client(name="No Extras Co", email="noextras@test.example", api_key="key-noextras")
    db.add(client)
    db.flush()
    db.add(Subscription(client_id=client.id, plan_id=plan.id, status="active"))
    db.commit()

    entitlements = get_entitlements(client.id, db, use_cache=False)

    assert entitlements.limits["bots"] == base_bots


def test_unlimited_plan_stays_unlimited_regardless_of_extra_seats(db):
    from app.db.models import Client, Plan, Subscription
    from app.services.plan_entitlements_service import UNLIMITED, get_entitlements

    plan = db.query(Plan).filter(Plan.slug == "enterprise").one()
    assert plan.limits.get("bots") == UNLIMITED, "this test assumes Enterprise bots is unlimited"
    client = Client(
        name="Enterprise Extras Co",
        email="entextras@test.example",
        api_key="key-entextras",
        extra_bot_seats=5,
    )
    db.add(client)
    db.flush()
    db.add(Subscription(client_id=client.id, plan_id=plan.id, status="active"))
    db.commit()

    entitlements = get_entitlements(client.id, db, use_cache=False)

    assert entitlements.limits["bots"] == UNLIMITED
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd api && DB_URL=<test-db-url> uv run pytest tests/test_plan_entitlements_extra_bot_seats.py -v`
Expected: `test_extra_bot_seats_add_to_the_plan_limit` FAILS (`base_bots + 3 != base_bots`); the other two pass already, which is expected — they're the "don't regress this" guards.

- [ ] **Step 3: Import `Client` in `plan_entitlements_service.py`**

Change line 77 from:

```python
from app.db.models import Bot, Plan
```

to:

```python
from app.db.models import Bot, Client, Plan
```

- [ ] **Step 4: Add the seat adjustment in `_compute`**

In `api/app/services/plan_entitlements_service.py`, directly after the block Task 1 added (`limits["max_crawl_depth"] = ...`) and before `result = PlanEntitlements(...)`:

```python
    # `bots` is the plan's included count; `Client.extra_bot_seats` is what
    # was purchased on top of it (POST /subscription/bot-seats, mirroring how
    # `operators` above adds `subscription.operator_quantity`). Unlimited
    # (`UNLIMITED`) stays unlimited regardless of what was purchased — there
    # is nothing to add extra seats on top of.
    bots_limit = limits.get("bots")
    if isinstance(bots_limit, int) and bots_limit != UNLIMITED:
        client_row = db_session.get(Client, client_id)
        extra_seats = int(client_row.extra_bot_seats or 0) if client_row is not None else 0
        limits["bots"] = bots_limit + extra_seats
```

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `cd api && DB_URL=<test-db-url> uv run pytest tests/test_plan_entitlements_extra_bot_seats.py -v`
Expected: 3 passed

- [ ] **Step 6: Run the full entitlements suite to check for regressions**

Run: `cd api && DB_URL=<test-db-url> uv run pytest tests/ -k entitlements -v`
Expected: all green — this touches a hot path every plan gate reads, so anything that broke here would show up as a cascade, not just in the two new files.

- [ ] **Step 7: Commit**

```bash
cd api
git add app/services/plan_entitlements_service.py tests/test_plan_entitlements_extra_bot_seats.py
git commit -m "fix: count a purchased extra bot seat toward the workspace's bot limit"
```

---

### Task 3: Make the live-chat audit trail readable

**Files:**
- Create: `api/app/api/live_chat_audit_routes.py`
- Modify: `api/app/main.py` (register the router)
- Modify: `app/src/services/api.js` (client function)
- Modify: `app/src/services/api.d.ts` (type)
- Modify: `app/src/features/leads/LeadDrawer.tsx` (render the trail)
- Test: `api/tests/test_live_chat_audit_read.py`
- Test: `app/src/features/leads/LeadsPage.test.tsx` (extend — this is what already exercises the drawer, see Step 9)

`ChatAuditLog` (`api/app/db/models.py:1358-1371`) is written on every
handoff/accept/close/transfer/timeout, from `chat_routes.py` and
`operator_routes.py`. Nothing reads it — confirmed by grepping every route
file for the model name and finding only `INSERT`s. This closes it with the
smallest possible surface: one session-scoped GET, rendered as a compact
timeline where the transcript already lives, `LeadDrawer.tsx`.

**Existing pattern to follow:** `api/app/api/lead_routes.py`'s own
`_resolve_client_bot_ids` + `get_current_client_or_operator` auth shape is
what every lead-adjacent read in this codebase uses; this route matches it
exactly rather than inventing a new auth pattern.

- [ ] **Step 1: Confirm the exact `action` values in use, so the test fixtures are real ones**

Run: `grep -n "ChatAuditLog(" api/app/api/chat_routes.py api/app/api/operator_routes.py | grep -o "action=\"[a-z_]*\""`
Use whatever this prints (expected: something like `handoff_requested`, `accepted`, `closed`, `transferred`, `timeout`, `visitor_cancelled`) in Step 2's fixture rather than the docstring's `action` comment, in case the two have drifted.

- [ ] **Step 2: Write the failing backend test**

```python
# api/tests/test_live_chat_audit_read.py
"""ChatAuditLog is written on every live-chat state transition and read by
nothing — this is the first read path."""

import pytest

pytestmark = pytest.mark.skipif(
    __import__("os").getenv("DB_URL") is None, reason="needs a reachable Postgres at DB_URL"
)


@pytest.fixture
def app_with_router():
    from fastapi import FastAPI

    from app.api.live_chat_audit_routes import router

    app = FastAPI()
    app.include_router(router)
    return app


def test_returns_the_session_s_transitions_oldest_first(db, app_with_router):
    from fastapi.testclient import TestClient

    from app.api.auth import get_current_client_or_operator
    from app.db.models import ChatAuditLog, ChatSession, Client

    client_row = Client(name="Audit Co", email="audit@test.example", api_key="key-audit")
    db.add(client_row)
    db.flush()
    session = ChatSession(id="sess-audit-1", client_id=client_row.id, status="closed")
    db.add(session)
    db.add_all(
        [
            ChatAuditLog(session_id=session.id, action="handoff_requested"),
            ChatAuditLog(session_id=session.id, action="accepted"),
            ChatAuditLog(session_id=session.id, action="closed"),
        ]
    )
    db.commit()

    app_with_router.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client",
        "client_id": client_row.id,
    }
    resp = TestClient(app_with_router).get(f"/chat/sessions/{session.id}/audit")

    assert resp.status_code == 200
    actions = [row["action"] for row in resp.json()["entries"]]
    assert actions == ["handoff_requested", "accepted", "closed"]


def test_refuses_a_session_belonging_to_another_client(db, app_with_router):
    from fastapi.testclient import TestClient

    from app.api.auth import get_current_client_or_operator
    from app.db.models import ChatSession, Client

    owner = Client(name="Owner Co", email="owner@test.example", api_key="key-owner")
    stranger = Client(name="Stranger Co", email="stranger@test.example", api_key="key-stranger")
    db.add_all([owner, stranger])
    db.flush()
    session = ChatSession(id="sess-audit-2", client_id=owner.id, status="closed")
    db.add(session)
    db.commit()

    app_with_router.dependency_overrides[get_current_client_or_operator] = lambda: {
        "type": "client",
        "client_id": stranger.id,
    }
    resp = TestClient(app_with_router).get(f"/chat/sessions/{session.id}/audit")

    assert resp.status_code == 404
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd api && DB_URL=<test-db-url> uv run pytest tests/test_live_chat_audit_read.py -v`
Expected: `ModuleNotFoundError: No module named 'app.api.live_chat_audit_routes'`

- [ ] **Step 4: Write the route**

```python
# api/app/api/live_chat_audit_routes.py
"""Read path for ``ChatAuditLog`` — written on every live-chat state
transition (handoff, accept, close, transfer, timeout) since the model was
added, and never read by anything until this file. See ``ChatAuditLog`` in
``db/models.py`` and the writers in ``chat_routes.py`` / ``operator_routes.py``.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select

from app.api.auth import get_current_client_or_operator
from app.db.models import ChatAuditLog, ChatSession
from app.db.session import get_session

router = APIRouter(prefix="/chat", tags=["chat"])


@router.get("/sessions/{session_id}/audit")
def get_session_audit_trail(session_id: str, auth: dict = Depends(get_current_client_or_operator)):
    """The ordered state-transition history for one conversation.

    Scoped the same way every other session-level read in this codebase is:
    an operator sees it only for the bot they're bound to, a client sees it
    only for a session under one of their own bots. A session that exists
    but belongs to someone else 404s, not 403 — matching `lead_routes.py`'s
    own reasoning: confirming a session id exists on someone else's account
    is itself an information leak.
    """
    with get_session() as db_session:
        session_row = db_session.execute(
            select(ChatSession).where(ChatSession.id == session_id)
        ).scalar_one_or_none()
        if session_row is None:
            raise HTTPException(status_code=404, detail="Session not found.")

        if auth.get("type") == "operator":
            operator_bot_id = auth.get("bot_id") or getattr(auth.get("entity"), "bot_id", None)
            if session_row.bot_id != operator_bot_id:
                raise HTTPException(status_code=404, detail="Session not found.")
        elif session_row.client_id != auth["client_id"]:
            raise HTTPException(status_code=404, detail="Session not found.")

        rows = db_session.execute(
            select(ChatAuditLog)
            .where(ChatAuditLog.session_id == session_id)
            .order_by(ChatAuditLog.created_at.asc())
        ).scalars().all()

        return {
            "entries": [
                {
                    "action": row.action,
                    "operator_id": row.operator_id,
                    "details": row.details,
                    "created_at": row.created_at.isoformat() if row.created_at else None,
                }
                for row in rows
            ]
        }
```

- [ ] **Step 5: Register the router**

In `api/app/main.py`, add near the other route imports:

```python
from app.api.live_chat_audit_routes import router as live_chat_audit_router
```

and near `app.include_router(chat_router)`:

```python
app.include_router(live_chat_audit_router)
```

- [ ] **Step 6: Run the tests to confirm they pass**

Run: `cd api && DB_URL=<test-db-url> uv run pytest tests/test_live_chat_audit_read.py -v`
Expected: 2 passed

- [ ] **Step 7: Lint and commit the backend half**

```bash
cd api
uv run ruff check app/api/live_chat_audit_routes.py app/main.py
uv run ruff format app/api/live_chat_audit_routes.py
git add app/api/live_chat_audit_routes.py app/main.py tests/test_live_chat_audit_read.py
git commit -m "feat: add a read path for the live-chat audit trail"
```

- [ ] **Step 8: Add the client function**

In `app/src/services/api.js`, near `getRatingsSummary` (same file, same style):

```js
export const getSessionAuditTrail = async (sessionId) => {
    try {
        const response = await api.get(`/chat/sessions/${sessionId}/audit`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching session audit trail:', error);
        throw error;
    }
};
```

In `app/src/services/api.d.ts`, near `getRatingsSummary`'s declaration:

```ts
export interface SessionAuditEntry {
  action: string;
  operator_id: number | null;
  details: Record<string, unknown> | null;
  created_at: string | null;
}
export function getSessionAuditTrail(sessionId: string): Promise<{ entries: SessionAuditEntry[] }>;
```

- [ ] **Step 9: Read `LeadDrawer.tsx` to find where to add the panel**

Run: `sed -n '1,60p' app/src/features/leads/LeadDrawer.tsx` and `grep -n "Disclosure\|LeadSection" app/src/features/leads/LeadDrawer.tsx`
This drawer already renders a transcript and other sections behind `LeadSection`/`Disclosure` (see the imports at the top of the file, `LeadSection` from `./LeadSection`). The audit trail becomes one more `LeadSection`, collapsed by default, placed after the transcript — confirm the exact prop shape `LeadSection` expects before Step 11.

There is no standalone `LeadDrawer.test.tsx` — the drawer is exercised through `app/src/features/leads/LeadsPage.test.tsx`, which already mocks the whole `services/api` module via `vi.hoisted` (`const api = vi.hoisted(() => ({ getLeads: vi.fn(), getLeadDetail: vi.fn(), getChatHistory: vi.fn(), getSessionDetails: vi.fn(), ... }))`, `LeadsPage.test.tsx:19-29`) and gives every mock a default in its top-level `beforeEach` (`api.getLeadDetail.mockResolvedValue(scoredLead())`, `api.getChatHistory.mockResolvedValue([])`, `api.getSessionDetails.mockResolvedValue({ visitor_rating: 5 })`, `LeadsPage.test.tsx:122-124`). The new test extends this file, not a new one.

- [ ] **Step 10: Write the failing frontend test**

Add `getSessionAuditTrail: vi.fn()` to the `vi.hoisted` `api` object at the top of `app/src/features/leads/LeadsPage.test.tsx`, and add a default resolve beside the other three in `beforeEach`:

```ts
api.getSessionAuditTrail.mockResolvedValue({ entries: [] });
```

Then add the test itself, alongside `'keeps both faces of the drawer reachable from either'` (`LeadsPage.test.tsx:176`):

```tsx
it('shows the session’s state transitions in order', async () => {
  api.getSessionAuditTrail.mockResolvedValue({
    entries: [
      { action: 'handoff_requested', operator_id: null, details: null, created_at: '2026-08-20T10:00:00Z' },
      { action: 'accepted', operator_id: 7, details: null, created_at: '2026-08-20T10:01:00Z' },
    ],
  });
  const user = userEvent.setup();
  renderPage('/leads?lead=s1');

  await user.click(await screen.findByRole('tab', { name: /conversation/i }));
  await user.click(await screen.findByRole('button', { name: /activity/i }));

  const entries = await screen.findAllByRole('listitem', { name: /requested a person|operator joined/i });
  expect(entries.map((entry) => entry.textContent)).toEqual([
    expect.stringContaining('Requested a person'),
    expect.stringContaining('Operator joined'),
  ]);
});
```

- [ ] **Step 11: Run it to confirm it fails**

Run: `cd app && npx vitest run src/features/leads/LeadsPage.test.tsx -t "state transitions"`
Expected: FAIL — `api.getSessionAuditTrail` is not called by anything yet, and no "Activity" disclosure exists to click.

- [ ] **Step 12: Add the section to `LeadDrawer.tsx`**

Add a `useQuery` call (matching how `useLeadDetail.ts` already calls TanStack Query) for `getSessionAuditTrail(sessionId)`, then a collapsed `LeadSection` titled "Activity" rendering each entry as `{formatRelative(entry.created_at)} — {humanizeAction(entry.action)}`, where `humanizeAction` is a small local map (`handoff_requested: 'Requested a person'`, `accepted: 'Operator joined'`, `closed: 'Closed'`, `transferred: 'Transferred'`, `timeout: 'Timed out'`, `visitor_cancelled: 'Visitor left the queue'`) — one line per entry, oldest first, no icons or timeline graphics; this is an audit list, not a new visual language for the drawer.

- [ ] **Step 13: Run the test to confirm it passes**

Run: `cd app && npx vitest run src/features/leads/LeadsPage.test.tsx -t "state transitions"`
Expected: PASS

- [ ] **Step 14: Run the full `LeadsPage.test.tsx` file to check for regressions**

Run: `cd app && npx vitest run src/features/leads/LeadsPage.test.tsx`
Expected: all green — a new default `beforeEach` mock and a new tab-panel section can affect existing tests in this file that were not touched directly.

- [ ] **Step 15: Full checks and commit**

```bash
cd app
npx tsc --noEmit && npm run lint && npm run build
git add src/services/api.js src/services/api.d.ts src/features/leads/LeadDrawer.tsx src/features/leads/LeadsPage.test.tsx
git commit -m "feat: render the live-chat audit trail on the lead drawer"
```

---

### Task 4: Queue analytics — current depth and historical wait time

**Files:**
- Modify: `api/app/db/repository.py` (new function, alongside `get_ratings_summary`/`get_resolution_summary`)
- Modify: `api/app/api/analytics_routes.py` (new route)
- Modify: `app/src/services/api.js`, `app/src/services/api.d.ts`
- Modify: `app/src/features/analytics/ConversationsTab.tsx`
- Test: `api/tests/test_queue_analytics.py`
- Test: `app/src/features/analytics/ConversationsTab.test.tsx` (extend existing)

**This depends on the real signal, not the tempting-looking one.**
`LiveChatQueueEntry` looks like the obvious data source — it is a persisted
FIFO queue table with `enqueued_at`/`dequeued_at`/`dequeue_reason`. It is
also dead: `tests/test_live_chat_cas_and_queue.py`'s own docstring (finding
F33) states plainly that "no code path ever populates that table" and that
live queue depth was moved to counting `ChatSession.status == 'waiting'`
instead, in `live_chat_availability_service.py`'s `_current_queue_size`.
Building this task on `LiveChatQueueEntry` would ship a panel that reads
zero forever. Current depth reuses `_current_queue_size`'s exact query;
historical wait time and abandonment rate are computed from `ChatAuditLog`
(Task 3's table), pairing each session's `handoff_requested` entry with its
next terminal entry (`accepted` = resolved, `timeout`/`visitor_cancelled` =
abandoned).

**Existing pattern to follow:** `get_ratings_summary` /
`get_resolution_summary` in `api/app/db/repository.py:965-1000` are the
direct template — same file, same `_session_owner_filter` scoping helper,
same return shape (a small dict of pre-aggregated numbers, not raw rows).

- [ ] **Step 1: Read `_session_owner_filter` and `_current_queue_size` before writing anything**

Run: `grep -n "_session_owner_filter" api/app/db/repository.py | head -3` and `sed -n '340,365p' api/app/services/live_chat_availability_service.py`
Confirm the exact filter helper's signature (`_session_owner_filter(bot_id, client_id)`) and the staleness window constant name (`_QUEUE_STALENESS_WINDOW`) referenced in `_current_queue_size` — the new function needs the same staleness bound so "current depth" means the same thing here as it does to the widget's own QUEUE_FULL check.

- [ ] **Step 2: Write the failing backend test**

```python
# api/tests/test_queue_analytics.py
"""Queue depth and wait time, built on the signal that is actually
maintained (ChatSession.status == 'waiting' + ChatAuditLog), not on
LiveChatQueueEntry, which nothing populates (see test_live_chat_cas_and_queue.py,
finding F33)."""

from datetime import UTC, datetime, timedelta

import pytest

pytestmark = pytest.mark.skipif(
    __import__("os").getenv("DB_URL") is None, reason="needs a reachable Postgres at DB_URL"
)


def test_current_depth_counts_only_fresh_waiting_sessions(db):
    from app.db.models import Bot, ChatAuditLog, ChatSession, Client
    from app.db.repository import get_queue_summary

    client = Client(name="Queue Co", email="queue@test.example", api_key="key-queue")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, name="B", bot_key="bot-queue")
    db.add(bot)
    db.flush()

    now = datetime.now(UTC)
    fresh = ChatSession(id="q-fresh", bot_id=bot.id, client_id=client.id, status="waiting", last_active_at=now)
    stale = ChatSession(
        id="q-stale",
        bot_id=bot.id,
        client_id=client.id,
        status="waiting",
        last_active_at=now - timedelta(hours=2),
    )
    db.add_all([fresh, stale])
    db.commit()

    summary = get_queue_summary(db, bot_id=bot.id, since=now - timedelta(days=7))

    assert summary["current_depth"] == 1


def test_average_wait_pairs_handoff_with_the_next_terminal_entry(db):
    from app.db.models import Bot, ChatAuditLog, ChatSession, Client
    from app.db.repository import get_queue_summary

    client = Client(name="Wait Co", email="wait@test.example", api_key="key-wait")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, name="B", bot_key="bot-wait")
    db.add(bot)
    db.flush()

    session = ChatSession(id="q-wait-1", bot_id=bot.id, client_id=client.id, status="closed")
    db.add(session)
    db.commit()

    t0 = datetime(2026, 8, 1, 10, 0, 0, tzinfo=UTC)
    db.add_all(
        [
            ChatAuditLog(session_id=session.id, action="handoff_requested", created_at=t0),
            ChatAuditLog(session_id=session.id, action="accepted", created_at=t0 + timedelta(seconds=90)),
        ]
    )
    db.commit()

    summary = get_queue_summary(db, bot_id=bot.id, since=t0 - timedelta(days=1))

    assert summary["avg_wait_seconds"] == 90
    assert summary["resolved_count"] == 1
    assert summary["abandoned_count"] == 0


def test_timeout_and_visitor_cancelled_count_as_abandoned(db):
    from app.db.models import Bot, ChatAuditLog, ChatSession, Client
    from app.db.repository import get_queue_summary

    client = Client(name="Abandon Co", email="abandon@test.example", api_key="key-abandon")
    db.add(client)
    db.flush()
    bot = Bot(client_id=client.id, name="B", bot_key="bot-abandon")
    db.add(bot)
    db.flush()

    s1 = ChatSession(id="q-abandon-1", bot_id=bot.id, client_id=client.id, status="closed")
    s2 = ChatSession(id="q-abandon-2", bot_id=bot.id, client_id=client.id, status="closed")
    db.add_all([s1, s2])
    db.commit()

    t0 = datetime(2026, 8, 1, 10, 0, 0, tzinfo=UTC)
    db.add_all(
        [
            ChatAuditLog(session_id=s1.id, action="handoff_requested", created_at=t0),
            ChatAuditLog(session_id=s1.id, action="timeout", created_at=t0 + timedelta(seconds=60)),
            ChatAuditLog(session_id=s2.id, action="handoff_requested", created_at=t0),
            ChatAuditLog(session_id=s2.id, action="visitor_cancelled", created_at=t0 + timedelta(seconds=30)),
        ]
    )
    db.commit()

    summary = get_queue_summary(db, bot_id=bot.id, since=t0 - timedelta(days=1))

    assert summary["abandoned_count"] == 2
    assert summary["resolved_count"] == 0
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd api && DB_URL=<test-db-url> uv run pytest tests/test_queue_analytics.py -v`
Expected: `ImportError: cannot import name 'get_queue_summary'`

- [ ] **Step 4: Write `get_queue_summary` in `repository.py`**

Add near `get_ratings_summary` in `api/app/db/repository.py`:

```python
def get_queue_summary(session, *, bot_id: int, since):
    """Live queue depth plus historical wait time, for one bot.

    Depth mirrors ``live_chat_availability_service._current_queue_size``
    exactly (``ChatSession.status == 'waiting'`` within the same staleness
    window), not ``LiveChatQueueEntry`` — see this task's own note in the
    plan for why that table is the wrong source. Wait time and outcome are
    read from ``ChatAuditLog``: each session's first ``handoff_requested``
    entry paired with its next terminal one (``accepted`` = resolved,
    ``timeout``/``visitor_cancelled`` = abandoned). A session with a
    ``handoff_requested`` and no terminal entry yet (still waiting) is
    excluded from both counts — it has not finished being answered or
    abandoned, so it belongs in ``current_depth``, not in a rate.
    """
    from datetime import UTC, datetime, timedelta

    from app.services.live_chat_availability_service import _QUEUE_STALENESS_WINDOW

    cutoff = datetime.now(UTC) - _QUEUE_STALENESS_WINDOW
    current_depth = session.execute(
        select(func.count(ChatSession.id)).where(
            ChatSession.bot_id == bot_id,
            ChatSession.status == "waiting",
            ChatSession.last_active_at >= cutoff,
        )
    ).scalar_one()

    entries = session.execute(
        select(ChatAuditLog.session_id, ChatAuditLog.action, ChatAuditLog.created_at)
        .join(ChatSession, ChatSession.id == ChatAuditLog.session_id)
        .where(
            ChatSession.bot_id == bot_id,
            ChatAuditLog.created_at >= since,
            ChatAuditLog.action.in_(["handoff_requested", "accepted", "timeout", "visitor_cancelled"]),
        )
        .order_by(ChatAuditLog.session_id, ChatAuditLog.created_at.asc())
    ).all()

    by_session: dict[str, list] = {}
    for row in entries:
        by_session.setdefault(row.session_id, []).append((row.action, row.created_at))

    wait_seconds: list[float] = []
    resolved_count = 0
    abandoned_count = 0
    for rows in by_session.values():
        handoff_at = next((ts for action, ts in rows if action == "handoff_requested"), None)
        if handoff_at is None:
            continue
        terminal = next(
            ((action, ts) for action, ts in rows if action in ("accepted", "timeout", "visitor_cancelled") and ts >= handoff_at),
            None,
        )
        if terminal is None:
            continue
        action, ts = terminal
        wait_seconds.append((ts - handoff_at).total_seconds())
        if action == "accepted":
            resolved_count += 1
        else:
            abandoned_count += 1

    avg_wait = round(sum(wait_seconds) / len(wait_seconds)) if wait_seconds else None

    return {
        "current_depth": int(current_depth or 0),
        "avg_wait_seconds": avg_wait,
        "resolved_count": resolved_count,
        "abandoned_count": abandoned_count,
    }
```

Add `ChatAuditLog` to this file's existing `from app.db.models import (...)` block if it is not already imported — check with `grep -n "^from app.db.models import" api/app/db/repository.py` first, this file is large and may already have it.

- [ ] **Step 5: Run the tests to confirm they pass**

Run: `cd api && DB_URL=<test-db-url> uv run pytest tests/test_queue_analytics.py -v`
Expected: 3 passed

- [ ] **Step 6: Add the route**

In `api/app/api/analytics_routes.py`, near `get_ratings_summary_endpoint` (`:291-305`):

```python
@router.get("/queue")
def get_queue_summary_endpoint(
    bot_id: RowId | None = Query(None),
    days: int = Query(30, ge=1, le=365),
    auth: dict = Depends(get_current_client_or_operator),
):
    """Live queue depth plus this period's average wait and abandonment."""
    try:
        _verify_bot_ownership(bot_id, auth["client_id"])
        with get_session() as session:
            since = datetime.now(UTC) - timedelta(days=days)
            return get_queue_summary(session, bot_id=bot_id, since=since)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch queue summary: {e}")
        raise HTTPException(status_code=500, detail="Failed to load queue summary.") from e
```

Add `get_queue_summary` to this file's existing `from app.db.repository import (...)` line. Note `bot_id` is required here (unlike `/visitors`, which tolerates `None` for an account-wide view) — `get_queue_summary`'s query is written for one bot; if an account-wide view turns out to be wanted later, that is a second, explicit parameter, not an implicit fallback that silently changes what the numbers mean.

- [ ] **Step 7: Guard the `None` case**

Immediately inside the `try:` block, before calling `get_queue_summary`:

```python
        if bot_id is None:
            raise HTTPException(status_code=400, detail="bot_id is required for queue analytics.")
```

- [ ] **Step 8: Lint and commit the backend half**

```bash
cd api
uv run ruff check app/db/repository.py app/api/analytics_routes.py
uv run ruff format app/db/repository.py app/api/analytics_routes.py
DB_URL=<test-db-url> uv run pytest tests/test_queue_analytics.py -v
git add app/db/repository.py app/api/analytics_routes.py tests/test_queue_analytics.py
git commit -m "feat: add queue-depth and wait-time analytics, built on the maintained signal"
```

- [ ] **Step 9: Add the client function**

`app/src/services/api.js`, near `getRatingsSummary`:

```js
export const getQueueSummary = async (botId, days = 30) => {
    try {
        const response = await api.get(`/analytics/queue?bot_id=${botId}&days=${days}`);
        return response.data;
    } catch (error) {
        console.error('API Error fetching queue summary:', error);
        throw error;
    }
};
```

`app/src/services/api.d.ts`:

```ts
export interface QueueSummary {
  current_depth: number;
  avg_wait_seconds: number | null;
  resolved_count: number;
  abandoned_count: number;
}
export function getQueueSummary(botId: number, days?: number): Promise<QueueSummary>;
```

- [ ] **Step 10: Confirm `ConversationsTab.tsx`'s exact shape before touching it**

`app/src/features/analytics/ConversationsTab.tsx:21-27` already reads:

```tsx
export function ConversationsTab({
  botId,
  range,
}: {
  botId: number | null;
  range: ResolvedRange;
}) {
```

`ResolvedRange` (`app/src/features/analytics/range.ts:65-78`) carries `days: number | null` (`null` means "all of history, no `?days=` filter"). There is no `ConversationsTab.test.tsx` yet — the sibling file to model the new one on is `JourneyFlow.test.tsx`, except that component takes its data as props and this one fetches its own, so the new test also needs the `QueryClientProvider` + `vi.mock('../../services/api', ...)` shape `LeadsPage.test.tsx` uses (Task 3, Step 9).

- [ ] **Step 11: Write the failing frontend test**

```tsx
// app/src/features/analytics/ConversationsTab.test.tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConversationsTab } from './ConversationsTab';
import type { ResolvedRange } from './range';

const api = vi.hoisted(() => ({
  getActivityStats: vi.fn(async () => ({ series: [] })),
  getQueueSummary: vi.fn(),
}));
vi.mock('../../services/api', () => api);

const range: ResolvedRange = {
  key: '30d',
  label: 'Last 30 days',
  days: 30,
  since: new Date('2026-07-22T00:00:00Z'),
  comparisonLabel: 'the previous 30 days',
  extendedDays: 60,
};

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ConversationsTab botId={1} range={range} />
    </QueryClientProvider>,
  );
}

describe('ConversationsTab — queue', () => {
  it('shows current depth and the period’s average wait', async () => {
    api.getQueueSummary.mockResolvedValue({
      current_depth: 3,
      avg_wait_seconds: 95,
      resolved_count: 10,
      abandoned_count: 2,
    });

    renderTab();

    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(await screen.findByText('1m 35s')).toBeInTheDocument();
    expect(await screen.findByText('10')).toBeInTheDocument();
    expect(await screen.findByText('2')).toBeInTheDocument();
  });

  it('reads "—" for average wait when nobody has waited yet', async () => {
    api.getQueueSummary.mockResolvedValue({
      current_depth: 0,
      avg_wait_seconds: null,
      resolved_count: 0,
      abandoned_count: 0,
    });

    renderTab();

    expect(await screen.findByText('—')).toBeInTheDocument();
  });
});
```

- [ ] **Step 12: Run it to confirm it fails**

Run: `cd app && npx vitest run src/features/analytics/ConversationsTab.test.tsx`
Expected: FAIL — `getQueueSummary` is never called, no such text on screen.

- [ ] **Step 13: Add the panel**

In `ConversationsTab.tsx`, add the import and the query, near the existing `useMessageSeries(botId)` call:

```tsx
import { useQuery } from '@tanstack/react-query';
import { getQueueSummary } from '../../services/api';
import { formatDuration } from '../../ui';
```

```tsx
const queue = useQuery({
  queryKey: ['analytics', 'queue', botId, range.days],
  queryFn: () => getQueueSummary(botId as number, range.days ?? 365),
  enabled: botId !== null,
});
```

(`range.days ?? 365` — the endpoint requires a concrete `days` value per Task 4 Step 7's `bot_id`-required guard's sibling reasoning: `get_queue_summary` needs a `since` bound to pair `ChatAuditLog` entries against, and "all of history" becomes "the last year" here rather than an unbounded scan.)

Then render a `Card` with a `StatRow`, matching the shape `JourneyTab.tsx` already uses for its own totals row (`StatRow label="..." period={...} items={[{label, value, hint?}, ...]}`):

```tsx
<Card>
  <CardBody flush>
    <StatRow
      label="Queue"
      period={range.label}
      items={[
        { label: 'Waiting now', value: formatNumber(queue.data?.current_depth ?? 0) },
        { label: 'Average wait', value: formatDuration(queue.data?.avg_wait_seconds ?? null) },
        { label: 'Resolved', value: formatNumber(queue.data?.resolved_count ?? 0) },
        { label: 'Abandoned', value: formatNumber(queue.data?.abandoned_count ?? 0) },
      ]}
    />
  </CardBody>
</Card>
```

Add `Card`, `CardBody` to the existing `from '../../ui'` import line at the top of the file if they are not already there (`ConversationsTab.tsx:3` currently imports `Button, Card, CardBody, Grid, Stack, StatRow, formatNumber` — `Card`/`CardBody`/`StatRow`/`formatNumber` are already present, so only `formatDuration` needs adding to that line).

- [ ] **Step 14: Run the test to confirm it passes**

Run: `cd app && npx vitest run src/features/analytics/ConversationsTab.test.tsx`
Expected: PASS

- [ ] **Step 15: Full checks and commit**

```bash
cd app
npx tsc --noEmit && npm run lint && npm run build
npm test
git add src/services/api.js src/services/api.d.ts src/features/analytics/ConversationsTab.tsx src/features/analytics/ConversationsTab.test.tsx
git commit -m "feat: show queue depth and wait time on the Conversations analytics tab"
```

---

## Task ordering and independence

Tasks 1 and 2 touch only `plan_entitlements_service.py` and are safe to do
in either order, or in parallel across two sessions — they do not share a
line. Task 3 must land before Task 4 in practice, even though nothing
imports across them at the code level: Task 4's historical numbers are
computed from `ChatAuditLog`, and Task 3 is where that table's shape gets
exercised and proven correct for the first time. Doing Task 4 first would
mean debugging two new things at once if the pairing logic in
`get_queue_summary` turns out to be wrong.

## What this plan deliberately does not attempt

**Account-wide queue analytics** (`bot_id=None`, summed across every bot a
workspace owns) — Task 4 rejects it explicitly rather than silently
returning a number that means something different from what the single-bot
view means. If that view turns out to be wanted, it is a second parameter on
`get_queue_summary`, not an assumption baked in now.

**Real-time queue depth updates** (a WebSocket push instead of the
`useQuery` poll Task 4's frontend step implies) — the existing
`/analytics/*` tabs all poll or fetch-on-navigation today; a live-updating
number would be a pattern change affecting every analytics panel, not a
scoped addition to one.
