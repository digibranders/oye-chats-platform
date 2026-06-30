# Feedback Taxonomy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the free-string `category` on platform feedback with a structured Type/Area/Severity taxonomy plus auto-captured context and multi-screenshot attachments, across backend, customer app, and superadmin.

**Architecture:** Add columns to `PlatformFeedback` (keep `category`/`attachment_url` for back-compat); centralize enum tuples in `app/core/feedback.py`; extend the existing POST/GET/PATCH + shared serializer; rebuild the customer `FeedbackModal` compose form; extend the admin table/filters/drawer.

**Tech Stack:** FastAPI · SQLAlchemy 2.0 · Alembic · pytest (Postgres throwaway DB) · React 19 (app: JS/Vite; admin: TS/Next).

**Spec:** [feedback-taxonomy-plan.md](./feedback-taxonomy-plan.md)

---

## Phase 1 — Backend constants, model, migration

### Task 1: Enum constants module
**Files:** Create `api/app/core/feedback.py`

- [ ] **Step 1:** Create the single source of truth:
```python
"""Canonical vocabularies for platform feedback classification."""

FEEDBACK_TYPES = ("bug", "feature_request", "question", "other")
FEEDBACK_AREAS = ("billing", "bots", "knowledge", "live_chat", "dashboard", "widget", "other")
FEEDBACK_SEVERITIES = ("low", "medium", "high", "critical")
FEEDBACK_STATUSES = ("open", "in_progress", "resolved", "closed")
FEEDBACK_RESOLVED_STATES = ("resolved", "closed")

# Old free-string category -> new type. Anything not mapped becomes "other".
CATEGORY_TO_TYPE = {"bug": "bug", "feature": "feature_request"}

# Keys we persist from the client-supplied context blob (ignore everything else).
CONTEXT_KEYS = ("page_url", "app_version", "plan_tier", "user_agent")
```
- [ ] **Step 2:** Update `superadmin_routes.py` to import `FEEDBACK_STATUSES`/`FEEDBACK_RESOLVED_STATES` from `app.core.feedback` (remove the local duplicates).
- [ ] **Step 3:** Commit.

### Task 2: Model columns
**Files:** Modify `api/app/db/models.py` (`PlatformFeedback`)

- [ ] Add after `category`:
```python
type = Column(String(20), nullable=False, default="other", server_default="other", index=True)
area = Column(String(20), nullable=True, index=True)
severity = Column(String(10), nullable=True)
context = Column(JSONB, nullable=True)
attachments = Column(JSONB, nullable=True)  # [{url, name?, content_type?}]
```
- [ ] Commit.

### Task 3: Alembic migration
**Files:** Create `api/alembic/versions/<rev>_feedback_taxonomy.py` (down_revision = `b3c8d1e4f7a9`)

- [ ] upgrade: add 5 columns (`type` NOT NULL server_default `"other"`); backfill
  `UPDATE platform_feedback SET type = CASE category WHEN 'bug' THEN 'bug' WHEN 'feature' THEN 'feature_request' ELSE 'other' END`;
  create indexes `ix_platform_feedback_type`, `ix_platform_feedback_area`.
- [ ] downgrade: drop indexes + 5 columns.
- [ ] **Verify:** scratch DB `alembic upgrade head` then `downgrade -1`; assert columns + backfill.
- [ ] Commit.

## Phase 2 — Backend endpoints + repository

### Task 4: Repository serializer + queries
**Files:** Modify `api/app/db/repository.py`

- [ ] `_serialize_platform_feedback` emits `type`, `area`, `severity`, `context`,
  and `attachments` coalesced: `fb.attachments or ([{"url": fb.attachment_url}] if fb.attachment_url else [])`.
- [ ] `save_platform_feedback` accepts `type_="other"`, `area=None`, `severity=None`,
  `context=None`, `attachments=None`; apply bug-only severity + `attachment_url = attachments[0]["url"]`.
- [ ] `get_all_platform_feedback(session, status=None, type_=None, area=None, severity=None)` — add `where` clauses.
- [ ] Commit.

### Task 5: POST /client/feedback
**Files:** Modify `api/app/api/client_routes.py`

- [ ] Extend `PlatformFeedbackCreate`: `type: str = "other"`, `area/severity: str | None`,
  `context: dict | None`, `attachments: list | None`; `field_validator`s validate enum membership
  and normalize `attachments` (str → `{"url": str}`), whitelist `context` keys.
- [ ] Pass new fields to `save_platform_feedback`.
- [ ] Commit.

### Task 6: GET filters + PATCH re-classify
**Files:** Modify `api/app/api/superadmin_routes.py`

- [ ] GET `/superadmin/platform-feedback`: add `type`/`area`/`severity` query params (400 on invalid),
  pass to `get_all_platform_feedback`.
- [ ] Extend `PlatformFeedbackUpdate` with `type`/`area`/`severity`; validate in handler (400);
  apply to row; re-apply bug-only severity (clear if type≠bug); include in `record_audit` before/after
  and in the returned dict.
- [ ] Commit.

### Task 7: Backend tests
**Files:** Create `api/tests/test_feedback_taxonomy.py` (mirror `test_platform_feedback_resolution.py` harness)

- [ ] Migration backfill mapping (raw SQL on `db`): bug→bug, feature→feature_request, ui_ux/performance/null→other.
- [ ] POST: invalid type/area/severity rejected; severity dropped when type≠bug; attachments[0] → attachment_url; context whitelisted.
- [ ] GET /client/feedback: new fields present; attachments coalesced from legacy attachment_url.
- [ ] PATCH reclassify: updates type/area/severity; bug-only rule; audit before/after carry fields; invalid → 400.
- [ ] Superadmin filters type/area/severity.
- [ ] **Verify:** `DB_URL=... .venv/bin/python -m pytest tests/test_feedback_taxonomy.py -q` (8+ pass); then full suite + ruff check/format.
- [ ] Commit.

## Phase 3 — Customer app

### Task 8: api.js payload + callers
**Files:** Modify `app/src/services/api.js`, `app/src/layouts/AdminLayout.jsx`, `app/src/components/SettingsDropup.jsx`

- [ ] `submitPlatformFeedback({ message, type, area, severity, context, attachments })` → POST body.
- [ ] Update both `handleFeedbackSubmit` callers to pass the object through from the modal's `onSubmit`.
- [ ] Commit.

### Task 9: FeedbackModal compose form
**Files:** Modify `app/src/components/FeedbackModal.jsx`

- [ ] Replace category chips with **Type** chips (required: bug/feature_request/question/other).
- [ ] Add **Area** dropdown (optional, 7 areas) and **Severity** chips (only when type=bug).
- [ ] Multi-attachment: state `attachments: []`; move paste listener to modal root (paste-anywhere);
  each item uploads via `uploadFeedbackAttachment`, store `{url,name,content_type}`; thumbnail preview grid with remove; cap 5, 10MB each.
- [ ] Capture context at submit (`page_url`, `app_version` from `import.meta.env.VITE_APP_VERSION ?? "unknown"`, `plan_tier` best-effort, `user_agent`).
- [ ] `onSubmit(payload)` sends object; submit disabled until type + message set.
- [ ] My Feedback list: render type/area/severity badges + attachment thumbnail gallery.
- [ ] **Verify:** `cd app && npm run lint && npm run build`.
- [ ] Commit.

## Phase 4 — Superadmin

### Task 10: types + api
**Files:** Modify `oyechats-admin/src/lib/types.ts`, `oyechats-admin/src/lib/api.ts`

- [ ] `FeedbackType`/`FeedbackArea`/`FeedbackSeverity` unions; extend `PlatformFeedbackRow`
  (`type`, `area`, `severity`, `context: Record<string,string>|null`, `attachments: {url:string;name?:string}[]`)
  and `PlatformFeedbackUpdate` (`type?`,`area?`,`severity?`).
- [ ] `platformFeedback.list` params add `type/area/severity`.
- [ ] Commit.

### Task 11: feedback page — columns, filters, drawer
**Files:** Modify `oyechats-admin/src/app/(dashboard)/feedback/page.tsx`

- [ ] Table: Type/Area/Severity badge columns (sortable); helpers for labels + tones.
- [ ] Filters: Type/Area/Severity selectors alongside Status tabs (drive the list query key).
- [ ] Drawer: context metadata block (page URL/app version/plan tier/browser); attachments gallery
  (thumbnails → open in new tab); Type/Area/Severity selectors (severity shown only when type=bug)
  saved in the same PATCH as status + response.
- [ ] **Verify:** `cd oyechats-admin && npx tsc --noEmit && npm run lint && npm run build`.
- [ ] Commit.

## Phase 5 — Finalize
- [ ] Re-run all gates (backend ruff+pytest full; admin tsc+lint+build; app lint+build).
- [ ] Push `development` in both repos.

---

## Self-review notes
- Spec coverage: Tasks 1–11 cover every spec section (model, migration, POST/GET/PATCH, app form + multi-attachment + context, admin columns/filters/drawer, tests).
- Back-compat: legacy `category` + `attachment_url` retained; serializer coalesces attachments; POST still accepts `category`.
- Type consistency: enum tuples defined once in `app/core/feedback.py`; admin unions mirror them.
