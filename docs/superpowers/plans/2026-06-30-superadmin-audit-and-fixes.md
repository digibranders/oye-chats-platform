# Superadmin App — Production-Readiness Audit + Fix Plan

**Date:** 2026-06-30
**Scope:** Entire `oyechats-admin` superadmin app (~55 routes) vs the FastAPI backend.
**Method:** 3 parallel audits — (1) `api.ts` ↔ backend endpoint reconciliation, (2) pages A–L, (3) pages M–Z + Command Center.
**Deliverable:** report + implementation plan (no code changes in this pass).

## Headline

The app is in **strong shape**: every `api.ts` call resolves to a **real backend route** (0 missing endpoints), **35 of 37 mutations genuinely persist**, all pages fetch **real data** (no synthetic/`Math.sin` fakes remain — the earlier Command-Center/Revenue chart fakes and the usage-records stale-plan bug are fixed), and loading/empty/error states are consistently handled.

The gaps are a **small, well-defined set**: one stub mutation, one un-wired CRUD surface, two no-op buttons, and a few polish/deploy items.

---

## Findings by severity

### 🔴 P0 — Broken action (silent failure, misleads the admin)

**1. `clients.resetPassword` is a STUB.**
`POST /superadmin/clients/{id}/reset-password` (`superadmin_routes_v2.py` `reset_password`) records an audit entry and returns `{"ok": true}` — but **never resets the password and never sends an email**. The client-detail page shows a success toast; nothing actually happens.
- *Impact:* a superadmin believes they reset a customer's password; the customer gets nothing and their password is unchanged.

### 🟠 P1 — Real capability gaps (backend works; UI doesn't use it)

**2. Coupons: no create/edit/delete in the UI.**
`/coupons` renders the list read-only and the **"New coupon" button no-ops** (`coupons/page.tsx:67`) — yet the backend has full CRUD: `POST/PATCH/DELETE /superadmin/coupons[/{id}]` (all persist, confirmed). So coupons **cannot be managed from the app** despite complete backend support.

**3. "Email all" buttons no-op.**
On `clients` (list header) and `clients/[id]` the "Email all"/email button has **no handler and no backend** — clicking does nothing.

### 🟡 P2 — Correctness / polish

**4. Enforcement-side usage staleness (separate from the display fix already shipped).**
`UsageRecord` limits are frozen per period and not resynced on plan change, so a **mid-period upgrade doesn't raise the *enforced* limit** until next period. (The superadmin *display* now shows the live plan; the *enforcement* path still uses the snapshot.)

**5. Minor:** `llm/page.tsx:82` hardcodes a `fallbackCount > 100` warning threshold with no comment; `feedback` attachment rendering doesn't guard a missing `url`; `feature-flags` endpoints delegate to `pricing-config` (works — architecture note only).

### 🟢 P3 — Deployment (not bugs)

Several pages (`system`, `workers`, `webhooks` deliveries, `sessions/[id]`, `observability`) show graceful "not deployed yet" fallbacks. The endpoints **exist in code on `development`** — they just need the API deployed to populate in prod. No code fix; ship the release.

---

## What's verified GOOD (so it's on record)

- **Reads:** all ~40 read endpoints exist and pages render them correctly (USD currency via `formatCents`, correct dates, no fabricated data).
- **Working mutations (persist confirmed):** clients create/update/delete/impersonate/grantCredits · plans create/update/delete · subscriptions update · coupons create/update/delete (backend) · invoices refund/mark-paid · feedback resolve/update · flags toggle · pricing-config update · model-config update · permissions promote/demote/role · offline-messages status · webhook-registrations toggle/test · webhooks replay · failed-webhooks replay · documents reindex · oauth unlink · api-key rotate · affiliates invite/update/remove/revoke.
- **Guards:** every mutation writes an audit entry; `_require_write` blocks read-only superadmins; permissions page protects the last owner.

---

## Implementation Plan (prioritized)

### Task 1 (P0) — Make `reset-password` real
**File:** `api/app/api/superadmin_routes_v2.py` (`reset_password`).
- Decide the flow: **(a)** generate a secure temp password, set `hashed_password`, and email it via `email_service` (Brevo); OR **(b)** trigger the existing customer password-reset OTP email (`/auth/request-password-reset` flow) for that client's email; OR **(c)** if neither is wanted now, return `501`/change the button to reflect reality.
- **Recommended:** (b) — reuse the existing reset-OTP email so the customer sets their own password; keep the audit entry; return a truthful message.
- Add a pytest asserting the password actually changes (or the reset email is dispatched).
- Frontend: keep the button; update the success copy to match (“Password-reset email sent”).

### Task 2 (P1) — Wire Coupons CRUD in the UI
**Files:** `oyechats-admin/src/app/(dashboard)/coupons/page.tsx` (+ a `CouponFormDialog`).
- Add create (wire "New coupon" → dialog → `api.coupons.create`), edit (`api.coupons.update`), delete (`api.coupons.delete`), and an is_active toggle. Backend already supports all of these.
- Fields: code, percent_off | amount_off_cents (one required), max_redemptions, expires_at, applies_to_plan_ids, is_active. Reuse the `CreateClientDialog`/`PlanFormDialog` patterns.
- Gate: verify the CRUD payload shape matches `CouponPatch`/create model; show redemptions read-only.

### Task 3 (P1) — Resolve the "Email all" buttons
**Files:** `clients/page.tsx`, `clients/[id]/page.tsx`.
- Either **build** a bulk/individual email path (new `POST /superadmin/clients/email` via Brevo + a compose dialog) or **remove/disable** the buttons until that exists. Recommended: remove now (avoid a dead control); revisit as a dedicated "broadcast" feature.

### Task 4 (P2) — Usage enforcement resync (optional, larger)
**Files:** `api/app/services/plan_service.py` + subscription-change flow.
- On subscription plan change, update the client's current-period `UsageRecord.plan_id` + `*_limit` columns to the new plan so **enforced** limits lift immediately on upgrade. Add tests. (Display already correct.)

### Task 5 (P2) — Minor polish
- `llm/page.tsx:82`: add a comment for the 100 threshold (or make it config-driven).
- `feedback` attachment cell: guard missing `url`.
- Optionally rename/document the feature-flags→pricing-config delegation.

### Task 6 (P3) — Deploy
- Merge `development` → `main` and deploy the API so the endpoints behind the "not deployed yet" fallbacks (system health, workers, webhooks, session detail, observability) return live data in prod.

## Suggested order
1 (P0 reset-password) → 2 (coupons CRUD) → 3 (email buttons) → 6 (deploy) → 4/5 (enforcement + polish).

## Notes
- Frontend gate: `npm run lint` + `npm run build`. Backend: `ruff` + `pytest`. All on `development`.
- No missing endpoints and no data-fabrication remain — this plan closes the *last* functional gaps for a fully-working superadmin.
