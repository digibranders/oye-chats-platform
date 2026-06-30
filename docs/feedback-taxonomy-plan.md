# Plan: Feedback Taxonomy — Type / Area / Severity + Context & Multi-Screenshot

**Status:** Designed (approved in brainstorming 2026-06-30)
**Created:** 2026-06-30
**Spans:** `api/` (backend) · `app/` (customer dashboard) · `oyechats-admin/` (superadmin)
**Builds on:** [feedback-resolution-plan.md](./feedback-resolution-plan.md) (status loop, already shipped)

## Goal

Replace the single free-string `category` on platform feedback with a structured
taxonomy so feedback can be triaged fast and reported on:

- **Type** (intent): `bug | feature_request | question | other`
- **Area** (where): `billing | bots | knowledge | live_chat | dashboard | widget | other`
- **Severity** (bugs only): `low | medium | high | critical`
- **Context** (auto-captured at submit): page URL, app version, plan tier, browser/user-agent
- **Attachments**: multiple screenshots per submission, with upload **and** paste-from-clipboard

The existing `status` lifecycle (`open → in_progress → resolved → closed`) and the
resolution loop (admin response + in-app notification) are unchanged.

## Decisions (locked)

1. **Migration:** add `type`/`area`/`severity`/`context`/`attachments`; **keep** the
   legacy `category` column (deprecated, read-only for historical rows). Backfill
   `type` from `category`: `bug→bug`, `feature→feature_request`, **everything else
   (`ui_ux`, `performance`, `other`, null) → `other`** (lossless — `category` is retained).
2. **Metadata:** capture now via a nullable `context` JSONB column.
3. **Enums:** the screenshot values **plus an `other` escape hatch on Area**.
4. **Form rules:** `type` + message required; `area`/`severity` optional; **severity is
   shown and persisted only when `type=bug`** (silently nulled otherwise — not a 400).
5. **Re-classification:** superadmins may edit `type`/`area`/`severity` on `PATCH` during
   triage (captured in the existing audit `before`/`after`).
6. **Attachments:** multiple per submission, stored as an `attachments` JSONB array;
   the first URL is mirrored into the legacy `attachment_url` for back-compat. Paste
   works anywhere in the modal; each attachment shows a thumbnail preview.

## Canonical vocabularies (single source of truth)

```
FEEDBACK_TYPES      = ("bug", "feature_request", "question", "other")
FEEDBACK_AREAS      = ("billing", "bots", "knowledge", "live_chat", "dashboard", "widget", "other")
FEEDBACK_SEVERITIES = ("low", "medium", "high", "critical")
# status unchanged: ("open", "in_progress", "resolved", "closed")
```

---

## 1. Data model (backend) — `api/app/db/models.py` (`PlatformFeedback`)

Add five columns; keep `category`:

| Column | Type | Notes |
|--------|------|-------|
| `type` | `String(20)`, NOT NULL, `server_default "other"`, indexed | one of `FEEDBACK_TYPES` |
| `area` | `String(20)`, nullable, indexed | one of `FEEDBACK_AREAS` |
| `severity` | `String(10)`, nullable | one of `FEEDBACK_SEVERITIES`; bug-only |
| `context` | `JSONB`, nullable | `{ page_url, app_version, plan_tier, user_agent }` |
| `attachments` | `JSONB`, nullable | array of `{ url, name?, content_type? }` |

`attachment_url` (legacy, single) stays; new submissions set it to `attachments[0].url`.

### Alembic migration
- `op.add_column` for the 5 columns (`type` NOT NULL server_default `"other"`).
- Backfill `type`: `UPDATE platform_feedback SET type = CASE category WHEN 'bug' THEN 'bug' WHEN 'feature' THEN 'feature_request' ELSE 'other' END`.
- `op.create_index` on `type` and `area`.
- Reversible `downgrade` (drop indexes + columns). No `attachments` backfill needed — the
  serializer coalesces `attachments` from the legacy `attachment_url` when null.

---

## 2. Backend endpoints

Canonical tuples live in one module (`app/api/superadmin_routes.py` already holds
`FEEDBACK_STATUSES`; add the new tuples next to it and import where needed, or lift all
feedback enums into a small `app/core/feedback.py` constants module — preferred, since
both `client_routes` and `superadmin_routes` need them).

**`POST /client/feedback`** (`client_routes.py`) — extend `PlatformFeedbackCreate`:
- `message` (required, unchanged), `type` (optional, default `"other"`, validated),
  `area` (optional, validated), `severity` (optional, validated), `context` (optional dict,
  whitelisted keys only), `attachments` (optional `list[{ url, name?, content_type? }]`,
  built by the app from each upload response + the `File` metadata; a bare `list[str]` of
  URLs is also accepted and normalized to `[{ "url": u }]`).
- `category` still accepted for back-compat.
- Rules: persist `severity` only when `type == "bug"` (else store `None`); set
  `attachment_url = attachments[0].url` when attachments present.
- `save_platform_feedback` (`repository.py`) accepts the new fields.

**`GET /client/feedback`** — serialize `type`, `area`, `severity`, `context`,
`attachments` (coalesced) in addition to existing fields.

**`GET /superadmin/platform-feedback`** — serialize the new fields; add optional
`type` / `area` / `severity` filters (alongside `status`). 400 on invalid filter value.

**`PATCH /superadmin/platform-feedback/{id}`** — extend `PlatformFeedbackUpdate` with
optional `type`/`area`/`severity` (re-classification). Validate enums (400 on bad value).
Re-apply the bug-only severity rule (clear severity if resulting type ≠ bug). Existing
`record_audit` `before`/`after` snapshots gain the three fields. Resolution/notification
behavior unchanged.

Shared serializer `_serialize_platform_feedback` (repository.py) is the one place that
emits the new fields + attachment coalescing, used by both client and superadmin reads.

---

## 3. Customer app — `app`

**`services/api.js`**
- `submitPlatformFeedback(payload)` — switch to a single options object:
  `{ message, type, area, severity, context, attachments }`. Update both callers
  (`layouts/AdminLayout.jsx`, `components/SettingsDropup.jsx`).
- `uploadFeedbackAttachment(file)` unchanged (per-file). The modal uploads each
  selected/pasted image and collects the returned URLs into an array.

**`components/FeedbackModal.jsx`** — "Send Feedback" tab:
- **Type** chips (required): Bug / Feature request / Question / Other.
- **Area** dropdown (optional): the 7 areas.
- **Severity** chips (optional) — rendered only when Type = Bug: Low / Med / High / Critical.
- **Attachments**: multiple. Paste listener moved to the modal root (paste-anywhere);
  each attachment renders a **thumbnail preview** with a remove button; enforce per-file
  10 MB and a small max-count (e.g. 5).
- **Context** captured at submit: `page_url = window.location.pathname + search`,
  `app_version` from build env (`import.meta.env.VITE_APP_VERSION` ?? `"unknown"`),
  `plan_tier` best-effort from entitlements/`/auth/me`, `user_agent = navigator.userAgent`.
- On submit, send the structured payload; on success drop the user on **My Feedback**.

**"My Feedback" tab** — show Type / Area / Severity badges next to the Status badge, and
render attachment thumbnails (gallery) per item.

**`components/NotificationBell.jsx`** — unchanged (the `feedback_resolved` type already
landed in the resolution-loop work).

---

## 4. Superadmin — `oyechats-admin`

**`src/lib/types.ts`** (append): `FeedbackType`, `FeedbackArea`, `FeedbackSeverity`
unions; extend `PlatformFeedbackRow` with `type`, `area`, `severity`, `context`
(`Record<string,string> | null`), `attachments` (`{ url: string; name?: string }[]`);
extend `PlatformFeedbackUpdate` with the three classifier fields.

**`src/lib/api.ts`**: `platformFeedback.list` params gain `type`/`area`/`severity`
(plus existing `status`); `update` body already passes through.

**`src/app/(dashboard)/feedback/page.tsx`** (Platform Feedback tab):
- Table: add **Type** (badge), **Area** (badge), **Severity** (badge, bugs only) columns,
  all sortable; keep `categoryLabel()` only for the deprecated legacy display if needed.
- Filters: add Type / Area / Severity filter controls next to the existing Status tabs.
- Resolve drawer: show captured **context** metadata (page URL, app version, plan tier,
  browser) and an **attachments gallery**; add Type / Area / Severity selectors so a
  superadmin can re-classify alongside Status + response (single `PATCH`).

---

## 5. Tests (backend)

- **Migration backfill**: `bug→bug`, `feature→feature_request`, `ui_ux/performance/null→other`.
- **POST validation**: invalid `type`/`area`/`severity` → 422/400; `severity` dropped when
  `type≠bug`; `attachments[0]` mirrored into `attachment_url`; `context` whitelisting.
- **GET /client/feedback**: includes new fields; `attachments` coalesced from legacy
  `attachment_url` for old rows.
- **PATCH re-classify**: updates `type`/`area`/`severity`; bug-only severity rule on
  re-classify; audit `before`/`after` include the new fields; invalid value → 400.
- **Superadmin filters**: `type` / `area` / `severity` filter the list; invalid → 400.

## 6. Verification gates (per CLAUDE.md)

- Backend: `cd api && uv run ruff check . && uv run ruff format . && uv run pytest`.
- Admin: `cd oyechats-admin && npx tsc --noEmit && npm run lint && npm run build`.
- App: `cd app && npm run lint && npm run build`.

## 7. Sequencing

1. Backend: constants module + model + Alembic migration (+ backfill).
2. Backend: POST/GET/PATCH + repository serializer/filters + validation.
3. Backend tests + gates.
4. Customer app: api.js payload + FeedbackModal (type/area/severity, multi-attachment
   paste + thumbnails, context capture) + My Feedback badges/gallery + callers.
5. Superadmin: types + api + table columns/filters + drawer (context, gallery, reclassify).
6. Full gates; commit on `development` (both repos); push.

## Out of scope (tracked separately)

- Per-area routing/assignment, SLA timers by severity, analytics dashboards over the new
  dimensions, and email digests — future work once the taxonomy is populated.
