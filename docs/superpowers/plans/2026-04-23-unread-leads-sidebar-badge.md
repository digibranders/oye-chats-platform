# Unread Leads — Proper "Needs Your Attention" Tracking

**Date:** 2026-04-23
**Owner:** admin@digibranders.com
**Status:** Draft — awaiting approval

---

## Context

The admin sidebar badge on `/leads` is wrong.

- **Symptom:** Workspace has 2 leads, sidebar shows `Leads (4)`.
- **Root cause:** `platform/app/src/layouts/Sidebar.jsx:35` computes `newLeads = stats.cold + stats.unqualified`, but `platform/api/app/api/lead_routes.py:133` returns `"cold": counts["unqualified"]` — the two are **aliases for the same number**, so every unqualified lead is counted twice.
- **Design flaw beyond the arithmetic:** even with the bug fixed, the current formula conflates "BANT-low" (cold / unqualified) with "needs your attention". A lead can sit at `unqualified` for weeks. Showing it as a persistent red badge is spam, not signal. A red badge should mean *"there is something new here the team hasn't looked at yet"* — the same contract Support's badge already honors (new offline messages).

**Goal:** Replace the tier-sum heuristic with a real `unread` count mirroring how `OfflineMessage` already tracks read/unread, so:
1. Badge reflects leads the team has not yet viewed.
2. Opening a lead's detail drawer clears that lead from the badge.
3. A bulk "Mark all read" exists for clearing noise after a burst.
4. The badge decrements to 0 once the team has triaged everything — and stays at 0 until a genuinely new lead arrives.

Scope is intentionally narrow: match `OfflineMessage` semantics (global, not per-operator). Per-operator unread (Gmail-style per-seat inboxes) is explicitly out of scope; if requested later, it's a clean v2 on top of this design.

---

## Current state (what exists)

| Concern | Today |
|---|---|
| Lead record | `ChatSession` row (one session = one lead); optional 1:1 `LeadInfo` for captured contact |
| Lead identity | Keyed by `ChatSession.id` (string session_id) |
| Read/viewed tracking | **None** — no `viewed_at`, `seen_at`, or equivalent column on `ChatSession` or `LeadInfo` |
| Stats endpoint | `GET /leads/stats` returns tier counts + aliases: `cold = unqualified`, `warm = mql`, `hot = sal`, `qualified = sql` |
| Sidebar badge source | Polls `getLeadStats` every 60s, sums `cold + unqualified` (wrong) |
| Offline-message pattern (the template) | `OfflineMessage.status` ∈ `{new, read, replied}` with `read_at`/`replied_at` timestamps; PATCH `/offline-messages/{id}` flips state; CHECK constraint enforces enum |
| Auth | `get_current_client_or_operator` resolves `{client_id, operator_id?}` — operator tracking available but not used by OfflineMessage (which is global) |

Critical files:
- `platform/api/app/db/models.py` — `ChatSession` (210-263), `LeadInfo` (192-208), `OfflineMessage` (428-447)
- `platform/api/app/api/lead_routes.py` — list/stats/export (1-200)
- `platform/api/app/services/lead_service.py` — `build_lead_response`, tier classifier
- `platform/api/app/api/offline_message_routes.py` — PATCH pattern to mirror (202-230)
- `platform/api/alembic/versions/c3d4e5f6a7b8_live_chat_security_hardening.py` — recent migration template
- `platform/app/src/pages/Leads.jsx` — list + detail drawer, no viewed interaction today
- `platform/app/src/layouts/Sidebar.jsx:22-44` — the badge
- `platform/app/src/services/api.js` — `getLeadStats`, `getLeads`, `getLeadDetail`, `exportLeadsCsv`

---

## Design

### Data model — one column, one index

Add to `ChatSession`:

```python
lead_viewed_at = Column(DateTime(timezone=True), nullable=True, index=False)
```

Index for the hot sidebar query (count unviewed leads scoped by bot):

```sql
CREATE INDEX ix_chat_sessions_bot_id_lead_viewed_at
  ON chat_sessions (bot_id)
  WHERE lead_viewed_at IS NULL;
```

A **partial index** is the right shape here: the cardinality of unviewed rows is the minority (after steady state) and we only ever query `WHERE bot_id = ? AND lead_viewed_at IS NULL`.

**Why `ChatSession`, not `LeadInfo`:** the backend treats every session as a potential lead and iterates `ChatSession` rows in `/leads/stats` — `LeadInfo` is optional (only present when the visitor left contact info). Putting viewed state on ChatSession keeps the query a single table scan.

**Why not a junction table:** a per-operator `lead_views(session_id, operator_id, viewed_at)` would be correct for a per-seat inbox UX, but (a) `OfflineMessage` already chose global state and we want parity, (b) adds a JOIN to the hottest query in the app (the polling sidebar), and (c) is easy to layer on later without re-migrating.

**Backfill:** Set `lead_viewed_at = created_at` for all existing rows in the migration's `op.execute(...)` step. This starts every existing lead in the "already seen" state — the correct behavior for an existing workspace that doesn't want a 500-badge on rollout.

### Backend API

**1. `GET /leads/stats` — add `unread` field**

```python
unread = (
    session.query(func.count(ChatSession.id))
    .filter(ChatSession.bot_id.in_(bot_ids), ChatSession.lead_viewed_at.is_(None))
    .scalar()
) or 0
return {
    "total": total,
    "unread": unread,
    **counts,
    "cold": counts["unqualified"],   # kept as alias — DO NOT remove this release
    "warm": counts["mql"],
    "hot": counts["sal"],
    "qualified": counts["sql"],
    "avg_score": round(total_score / total) if total > 0 else 0,
}
```

Keep the legacy aliases — they ship to the Leads page's tier tiles. Deprecate in a follow-up PR after confirming no other consumers.

**2. `GET /leads/{session_id}` — expose `unread` on the lead**

Update `build_lead_response()` in `lead_service.py`:

```python
return {
    ...,
    "unread": s.lead_viewed_at is None,
    "lead_viewed_at": s.lead_viewed_at.isoformat() if s.lead_viewed_at else None,
}
```

This lets the list page show a visual unread indicator (dot/bold) per row.

**3. `POST /leads/{session_id}/view` — single mark-as-viewed**

```python
@router.post("/{session_id}/view", status_code=204)
def mark_lead_viewed(session_id: str, auth = Depends(get_current_client_or_operator)):
    with get_session() as session:
        lead = session.get(ChatSession, session_id)
        if not lead or not _client_owns_session(auth, lead):
            raise HTTPException(404, "Lead not found")
        if lead.lead_viewed_at is None:
            lead.lead_viewed_at = datetime.now(UTC)
            session.commit()
        return Response(status_code=204)
```

Idempotent — calling twice is a no-op. Returns 204 so the frontend can fire-and-forget without parsing a body.

**4. `POST /leads/mark-all-viewed?bot_id=<id>` — bulk clear**

```python
@router.post("/mark-all-viewed", status_code=204)
def mark_all_leads_viewed(bot_id: int | None = Query(None), auth = Depends(...)):
    bot_ids = _resolve_bot_ids(auth, bot_id)
    with get_session() as session:
        session.execute(
            update(ChatSession)
            .where(ChatSession.bot_id.in_(bot_ids), ChatSession.lead_viewed_at.is_(None))
            .values(lead_viewed_at=datetime.now(UTC))
        )
        session.commit()
    return Response(status_code=204)
```

UI surfaces this as a "Mark all as read" button next to the page header, same as Support.

**Not adding** an "unmark" endpoint in v1. `OfflineMessage` doesn't have one either. A stale lead can be re-surfaced by BANT-tier filters or the "Cold" tile on the Leads page itself — the sidebar badge is explicitly just "new things".

### Frontend

**Sidebar.jsx** — trivial swap:

```js
setNewLeads(leadsData.value?.unread || 0);   // was: (cold || 0) + (unqualified || 0)
```

Keep the 60s polling for now; WS push for lead arrivals is out of scope (tracked as follow-up).

**Leads.jsx** — two touch points:

1. When the detail drawer opens for a lead, call `markLeadViewed(sessionId)` fire-and-forget; optimistically set `lead.unread = false` in local state so the row indicator clears immediately.
2. Add a "Mark all as read" button (enabled when any row is unread) that calls `markAllLeadsViewed(botId)` and refetches the list + stats.

**Row UI** — small blue dot or `font-semibold` when `lead.unread === true`. Match whatever Support uses for unread messages to keep the language consistent.

**api.js** — add:
```js
export const markLeadViewed = (sessionId) => api.post(`/leads/${sessionId}/view`);
export const markAllLeadsViewed = (botId) =>
    api.post(`/leads/mark-all-viewed${botId ? `?bot_id=${botId}` : ''}`);
```

### Out-of-scope (explicit non-goals)

- **Per-operator unread.** Global state matches OfflineMessage; revisit only if ops team asks.
- **Auto-re-unread on new activity.** A viewed lead that later gets a new chat message stays "viewed". Matches OfflineMessage; ops can sort by `last_active_at` for recent activity.
- **WS push for badge refresh.** 60s polling is fine for v1; live push is a generic "real-time admin" follow-up that should cover leads + offline messages + operator presence together.
- **Removing legacy `cold`/`warm`/`hot`/`qualified` aliases.** Deprecate in a separate PR with a grep-first audit.

---

## Implementation order (TDD)

1. **Backend test** — write failing test: `lead_stats` returns `unread` count; mark-viewed endpoint sets timestamp & is idempotent; mark-all clears for a bot.
2. **Alembic migration** — add column + partial index + backfill (`lead_viewed_at = created_at`). Run `alembic upgrade head` locally; verify with `\d chat_sessions` in psql.
3. **Backend** — add column to model, implement `/view` + `/mark-all-viewed` routes, extend `build_lead_response` and `/stats`. Tests go green.
4. **Backend regression test** — existing aliases (`cold`, `warm`, `hot`, `qualified`, `total`, `avg_score`) unchanged.
5. **Frontend api.js** — add `markLeadViewed`, `markAllLeadsViewed`.
6. **Frontend Sidebar.jsx** — swap to `stats.unread`.
7. **Frontend Leads.jsx** — row indicator, drawer-open hook, "Mark all as read" button.
8. **Playwright/manual QA** — see Verification below.

---

## Verification

**Backend**
```bash
cd platform/api && uv run ruff check . && uv run ruff format --check . && uv run pytest
```
Expect: existing 275 tests + new lead-unread tests, all green.

**Frontend (admin)**
```bash
cd platform/app && npm run lint && npm run build
```

**Manual E2E** — log in as `gaurav@fynix.digital` / `Gaurav@1432` at http://localhost:5174:

1. Fresh state: badge should read `0` (post-migration backfill set everyone viewed).
2. Have a visitor send a chat message via the widget → within 60s, badge ticks to `1`.
3. Open `/leads`, click the new row → drawer opens → badge drops back to `0` within the poll tick (or immediately, via optimistic update).
4. Generate 3 more leads quickly → badge shows `3` → click "Mark all as read" → badge `0`, all row indicators cleared.
5. Verify legacy tier tiles on `/leads` (Total/Cold/Warm/Hot/Qualified) still show correct numbers — no regression.
6. Check Support badge still works independently (offline message flow unaffected).
7. Switch between bots in the bot selector — badge refetches scoped to selected bot.

**Migration safety**
- `ALTER TABLE chat_sessions ADD COLUMN lead_viewed_at TIMESTAMPTZ` — O(1) on Postgres for nullable columns; no table rewrite.
- Backfill `UPDATE chat_sessions SET lead_viewed_at = created_at` — needs a batched update if the table is large. Check row count first; if > ~100k, wrap in a loop of `LIMIT 5000` updates.
- Partial index creation is also cheap.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Backfill locks `chat_sessions` on a large table | Check `SELECT count(*) FROM chat_sessions;` before migration; batch if > 100k |
| Poll + optimistic update race (badge flickers to old count) | Optimistic state in React is the source of truth until the next poll; accept 60s eventual consistency |
| Stats query regression (added `COUNT WHERE lead_viewed_at IS NULL`) | Partial index covers it; add EXPLAIN ANALYZE check to the PR |
| Legacy consumers depending on `cold`/`unqualified` | Keep aliases this release; audit + deprecate in follow-up |
| Frontend calls `/view` on every drawer open — spam | Endpoint is idempotent; also guard client-side: skip call if `lead.unread === false` |

---

## Files to touch

| File | Change |
|---|---|
| `platform/api/app/db/models.py` | Add `lead_viewed_at` column to `ChatSession` |
| `platform/api/alembic/versions/<new>_lead_viewed_at.py` | Migration + partial index + backfill |
| `platform/api/app/services/lead_service.py` | `build_lead_response` includes `unread` + `lead_viewed_at` |
| `platform/api/app/api/lead_routes.py` | Add `unread` to `/stats`; new `/view` + `/mark-all-viewed` routes |
| `platform/api/tests/test_lead_routes.py` (new or extend) | Tests for all four behaviors |
| `platform/app/src/services/api.js` | `markLeadViewed`, `markAllLeadsViewed` |
| `platform/app/src/layouts/Sidebar.jsx` | Badge reads `stats.unread` |
| `platform/app/src/pages/Leads.jsx` | Row indicator, drawer-open hook, bulk button |

---

## Rollout

1. Merge to `development`.
2. Run migration in staging → verify `\d chat_sessions` shows column + index.
3. Manual QA in staging using the checklist above.
4. PR `development → main`; user merges.
5. Run migration in prod; watch `/leads/stats` p99 for the first hour (should be unchanged or slightly faster thanks to the partial index).

---

## Stopgap (ship this week, independent of the above)

If the full plan is too much for this sprint, ship the **one-line hotfix** on its own PR: change `Sidebar.jsx:35` from `(s?.cold || 0) + (s?.unqualified || 0)` to `(s?.unqualified || 0)`. This removes the double-count immediately without any backend or migration work. The badge will then accurately reflect "unqualified leads" — which is still a product-definition question, but at least not arithmetically wrong.
