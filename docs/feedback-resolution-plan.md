# Plan: Platform Feedback Resolution & Status Loop

**Status:** Planned (not yet implemented)
**Owner:** TBD
**Created:** 2026-06-30
**Spans:** `api/` (backend) · `app/` (customer dashboard) · `oyechats-admin/` (superadmin)

## Goal

Let a superadmin triage and **resolve** customer-submitted platform feedback/issues, and let the submitting customer **see the status and the admin's response** inside the app — closing the loop so a user knows their issue was handled.

## Decisions (locked)

- **Notify the user via:** in-app **status + written response** (a "My Feedback" view) **and** an in-app **notification/toast** when status changes to resolved. **No email.**
- **Superadmin layout:** one Feedback page with **two tabs** — *Platform Feedback / Issues* (manage + resolve) and *Visitor Ratings* (CSAT, read-only).
- These are kept distinct because they are two different systems (see Background).

## Background — current state (why this is needed)

There are **two unrelated feedback systems** in the codebase:

1. **Visitor ratings** — `ChatMessage.feedback` (👍/👎 on bot replies) + `trace_id`. Submitted by widget visitors via `POST /chat/feedback/{message_id}` (`api/app/api/chat_routes.py:677`). Read by superadmin via `GET /superadmin/feedback` → `repository.get_global_feedback_data` (`api/app/api/superadmin_routes.py:131`). This is CSAT analytics — no "resolved" concept needed.

2. **Platform feedback / issues** — `PlatformFeedback` table (`api/app/db/models.py:1523`). Submitted by customers from the app (`app/src/components/FeedbackModal.jsx` → `POST /client/feedback`, `api/app/api/client_routes.py:126`, with optional attachment upload). Read by superadmin via `GET /superadmin/platform-feedback` → `repository.get_all_platform_feedback` (`api/app/api/superadmin_routes.py:170`).

**Three concrete problems today:**

1. **Superadmin page is mis-wired.** [`oyechats-admin/src/app/(dashboard)/feedback/page.tsx`](../../oyechats-admin/src/app/(dashboard)/feedback/page.tsx) calls `api.feedback()` → `/superadmin/feedback` (visitor ratings) and renders raw JSON in a `<pre>`. The customer platform feedback endpoint `/superadmin/platform-feedback` is **never called anywhere** in the admin.
2. **No status model.** `PlatformFeedback` has only `id, client_id, message, attachment_url, category, created_at` — no `status`, no `admin_response`, no `resolved_at/by`, and **no update endpoint**.
3. **No customer-side loop.** The app submits feedback and never reads it back — there is no `GET /client/feedback` and no "My Feedback" view, so the user can never see a status or response.

---

## Implementation

### 1. Data model (backend) — `api/app/db/models.py`

Extend `PlatformFeedback`:

| Column | Type | Notes |
|--------|------|-------|
| `status` | `String(20)`, default `"open"`, server_default `"open"`, not null, indexed | `open` \| `in_progress` \| `resolved` \| `closed` |
| `admin_response` | `Text`, nullable | superadmin's written reply shown to the customer |
| `resolved_at` | `DateTime(timezone=True)`, nullable | set when status → resolved/closed |
| `resolved_by` | `Integer` FK `clients.id` ON DELETE SET NULL, nullable | which superadmin actioned it |

**Alembic migration:** add the 4 columns; backfill existing rows to `status="open"`. Add index on `status`. (Use `op.add_column` + `op.create_index`; reversible `downgrade`.)

### 2. Backend endpoints

**Superadmin** (`api/app/api/superadmin_routes.py` or a new `superadmin_feedback_routes.py`):
- `PATCH /superadmin/platform-feedback/{feedback_id}` — body `{status?, admin_response?}`. Validates `status` enum; on transition to `resolved`/`closed` set `resolved_at=now()` + `resolved_by=superadmin.id`. **Audit-log** (`record_audit`, action `platform_feedback.update`). On transition **into `resolved`**, enqueue an in-app notification + a `feedback_resolved` event for the owning `client_id` (see §4). Returns the updated row.
- Update `repository.get_all_platform_feedback` to include the 4 new fields, and accept an optional `status` filter (and maybe `category`).

**Customer-facing** (`api/app/api/client_routes.py`):
- `GET /client/feedback` — list the **logged-in client's own** feedback (`client_id == client.id`), newest first, including `status`, `admin_response`, `resolved_at`, `created_at`, `category`, `attachment_url`. (Reuse `get_current_client`.)
- (Existing `POST /client/feedback` unchanged; new rows default to `status="open"`.)

### 3. Superadmin UI — `oyechats-admin`

- **Rewire + restructure** `src/app/(dashboard)/feedback/page.tsx` into a **two-tab** page (use the existing Tabs/SegmentedControl pattern; see other multi-view pages):
  - **Tab 1 — Platform Feedback / Issues:** table from `api.platformFeedback.list()` (client, category, message preview, attachment link, submitted date, **status badge**). Row → drawer/modal showing full message + attachment, a **status selector** (open/in-progress/resolved/closed) and an **admin response** textarea, wired to `PATCH /superadmin/platform-feedback/{id}` via `useMutation` + toast + query invalidation. Status filter control.
  - **Tab 2 — Visitor Ratings (CSAT):** the existing `/superadmin/feedback` data, but rendered as a real table (rating, comment, client, date) instead of raw JSON `<pre>`.
- **`src/lib/api.ts`** (append): `platformFeedback: { list: (params?) => tryGet<PlatformFeedbackRow[]>("/superadmin/platform-feedback", [], params), update: (id, body) => patch<PlatformFeedbackRow>("/superadmin/platform-feedback/${id}", body) }`. Keep `api.feedback` (rename mentally to "visitor ratings" or add `api.visitorRatings`).
- **`src/lib/types.ts`** (append): `PlatformFeedbackRow` (id, client_id, client_name, client_email, message, attachment_url, category, status, admin_response, resolved_at, created_at) and `FeedbackStatus` union.

### 4. Customer app UI + notification — `oye-chats-platform/app`

- **"My Feedback" view:** add history to `FeedbackModal.jsx` (a tab or a list under the form) OR a small `pages/Feedback.jsx`. Fetch `GET /client/feedback` via `services/api.js` (`getMyFeedback()`); render each item with a **status badge** (Open / In progress / Resolved) and, when present, the **admin response** in a callout. Show resolved date.
- **In-app notification/toast:** the platform already has a `notifications` table + notification service. On resolve (§2), create a `Notification` for the client (type e.g. `feedback_resolved`, with feedback id + snippet). The app's existing notification bell/toast surfaces it; clicking deep-links to the My Feedback item. (Confirm the notification create path in `api/app/services/` + how the app polls/receives them; reuse that wiring — no new transport.)

### 5. Tests (backend)

- `PlatformFeedback` migration smoke (columns exist, default `open`).
- `PATCH /superadmin/platform-feedback/{id}`: status transitions set `resolved_at/by`; invalid status → 400; audit row written; notification enqueued on resolve.
- `GET /client/feedback`: returns only the caller's rows, includes status + response; auth required.
- Enum/serialisation in `get_all_platform_feedback`.

### 6. Verification gates (per CLAUDE.md)

- Backend: `cd api && uv run ruff check . && uv run ruff format . && uv run pytest` (+ run the new tests).
- Admin: `cd oyechats-admin && npx tsc --noEmit && npm run lint && npm run build`.
- App: `cd app && npm run lint && npm run build`.

### 7. Sequencing

1. Model + Alembic migration.
2. Backend endpoints (superadmin PATCH, client GET) + repository update + notification-on-resolve.
3. Backend tests + gates.
4. Superadmin two-tab page + api/types.
5. Customer app My-Feedback view + notification surfacing.
6. Full gates, commit on `development` (both repos), push, PR.

---

## Appendix — unrelated accuracy fixes found during the audit (fold in or separate PR)

These are small contract drifts found while auditing; not part of the feedback feature but cheap to fix:

1. `GET /superadmin/clients` (list, `superadmin_routes.py:96`) omits `suspended_at` and `superadmin_role` that `ClientSummary` (admin `types.ts`) expects — the list view can't show suspension/role. Add both fields to the return dict.
2. `GET /superadmin/llm/usage` (`superadmin_routes_v2.py`) never returns `error_count` though `LLMUsageRow` declares it optional — wire it up or drop it from the type.

## Appendix — out of scope (tracked separately)

Other gaps the re-audit surfaced (NOT this feature): Command-center/Revenue synthetic `Math.sin()` charts; hardcoded `/integrations` statuses; read-only `/permissions` (no RBAC mutation); and missing admin pages for Usage Records, Offline Messages, Departments, Canned Responses, BANT Signals, Meeting Bookings, Payment Methods, Outbound Webhook registrations.
