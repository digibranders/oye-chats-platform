# Plan: Superadmin Dashboard Remediation

**Status:** Planned (not yet implemented)
**Created:** 2026-06-30
**Spans:** `oyechats-admin/` (superadmin) · `api/` (backend) · occasionally `app/` (customer dashboard)
**Companion doc:** [`feedback-resolution-plan.md`](feedback-resolution-plan.md) (feedback status loop — referenced from P1.3 below)

Consolidates every issue found in the multi-agent re-audit of the superadmin dashboard. Organised by priority: **P0** accuracy/bugs (small, ship first), **P1** incomplete features, **P2** missing feature pages (backend data exists, no UI). Each item lists the problem, the fix, the files, and whether new backend work is required.

Verification gates for every phase (per CLAUDE.md): admin `npx tsc --noEmit && npm run lint && npm run build`; backend `uv run ruff check . && uv run ruff format . && uv run pytest`; app `npm run lint && npm run build`. Commit on `development`, push, PR.

---

## P0 — Accuracy & correctness fixes (small, high-value)

### P0.1 Remove synthetic `Math.sin()` charts
- **Problem:** Command Center renders fake 30-day revenue + 7-day message series via `Math.sin()` / `syntheticSeries()` presented as live metrics (`oyechats-admin/src/app/(dashboard)/page.tsx:41–56, 78–119`); Revenue page does the same (`revenue/page.tsx:18–24`).
- **Fix (choose one):**
  - **(a) Real data** — add backend timeseries: `GET /superadmin/stats/timeseries?metric=revenue|messages|signups&days=30` returning `[{date, value}]` (group by day from invoices/messages/clients). Wire both pages + the StatCard sparklines to it.
  - **(b) Interim** — if timeseries is deferred, delete `syntheticSeries`/`Math.sin` usage and show an honest empty/"trend coming soon" state. Do **not** ship fabricated numbers.
- **Recommendation:** (a). Remove `syntheticSeries` from `src/lib/utils.ts` once unused.
- **Backend:** new endpoint (option a). **Effort:** ~1 day.

### P0.2 Drive `/integrations` statuses from real health
- **Problem:** `integrations/page.tsx:9–16` hardcodes every integration `status: "connected"`.
- **Fix:** fetch `api.health.full()` and map each integration's status from the health snapshot (database, redis, worker, storage, razorpay; Brevo/OpenAI/Gemini/Sentry/Langfuse if exposed). Add missing service checks to `GET /superadmin/system/health/full` as needed. Show "configured/unknown" rather than a false "connected".
- **Backend:** extend health/full to report the listed services. **Effort:** ~0.5 day.

### P0.3 Contract drift fixes
- **`GET /superadmin/clients`** (`api/app/api/superadmin_routes.py:96–115`) omits `suspended_at` and `superadmin_role` that `ClientSummary` expects → list can't show suspension/role. Add both to the return dict (the v2 detail endpoint already has them).
- **`GET /superadmin/llm/usage`** (`superadmin_routes_v2.py`) never returns `error_count` though `LLMUsageRow` declares it. Either wire it up from `LLMCallLog` or drop it from the type.
- **Effort:** ~15 min.

### P0.4 Revenue cohort placeholder
- **Problem:** `revenue/page.tsx:100–105` shows "Cohort table will render here" though `/cohorts` works and `api.stats.cohorts()` exists.
- **Fix:** render the cohort data inline (reuse the `/cohorts` table component) or remove the dead section.
- **Effort:** ~0.5 day.

### P0.5 Feedback page mis-wiring → covered by companion plan
- The `/feedback` page is wired to the wrong endpoint and dumps raw JSON. Full fix (two-tab page, status/resolve, customer loop, feedback **type taxonomy** — see P1.3) is specified in [`feedback-resolution-plan.md`](feedback-resolution-plan.md).

---

## P1 — Incomplete features

### P1.1 Permissions RBAC (make it actionable)
- **Problem:** `permissions/page.tsx` only lists clients filtered by `is_superadmin`; no promote/demote/role-edit. `PATCH /superadmin/clients/{id}` already accepts `superadmin_role`/`is_superadmin`.
- **Fix:** add promote-to-superadmin, demote, and role selector (owner/admin/readonly) actions wired to the existing PATCH, with confirms + audit. Guard against self-demotion of the last owner.
- **Backend:** likely none (PATCH exists) — verify it accepts `is_superadmin` toggles safely. **Effort:** ~1 day.

### P1.2 Settings — make it data-driven (or clearly static)
- **Problem:** `settings/page.tsx` is fully hardcoded (rate limits, CORS, email, integrations) with "inline editing coming soon".
- **Fix:** the tunable subset already lives in `/superadmin/pricing-config` + `/superadmin/feature-flags`; surface those as editable here, and clearly label the rest as read-only env-derived config (optionally a `GET /superadmin/system/config` that echoes non-secret effective settings). Don't present static values as editable.
- **Backend:** optional read-only config endpoint. **Effort:** ~1 day.

### P1.3 Feedback system: status loop + type taxonomy
- **Status loop** (resolve + customer notification): see [`feedback-resolution-plan.md`](feedback-resolution-plan.md).
- **Type taxonomy hardening** (this audit's addition — current `category` is an unconstrained free string; the app mixes *type* with *area*):
  - Normalise to a small **type** enum: `bug | feature_request | question | other` (rename the existing `ui_ux`/`performance` choices into an **area** dimension instead).
  - Add optional **area** (billing, bots, knowledge, live_chat, dashboard, widget, other) and, for bugs, **severity** (low/med/high/critical) — user-set or admin-triaged.
  - Auto-capture context metadata on submit (page URL, app version, plan tier, browser/UA) into `metadata` JSONB to speed triage.
  - Superadmin: filter/group by type + area + status; admin can re-classify.
  - Constrain values at the schema layer (`PlatformFeedbackCreate`) and add a CHECK or app-level validation.
- **Backend:** migration adds `feedback_type`, `area`, `severity`, `metadata` (+ the status fields from the companion plan). **Effort:** rolled into the feedback feature (~3–4 days total).

---

## P2 — Missing feature pages (backend data exists; UI absent)

Each needs an admin page + `api.*`/types, and most need a **new backend superadmin endpoint** (none exist today). Grouped by priority.

### P2 — Tier 1 (critical)
| Page | Entity | New backend endpoint(s) | What the superadmin does |
|------|--------|-------------------------|--------------------------|
| **Usage Records** | `usage_records` | `GET /superadmin/usage-records?client_id=&period=` | Monthly usage vs plan limits, overage tracking, per-client drill-down |
| **Offline Messages** | `offline_messages` | `GET /superadmin/offline-messages`, `PATCH …/{id}` (mark read/replied) | Inbox of visitor messages left while operators offline; filter by `fallback_reason`; transcript view |
| **Create Client** | `clients` | `POST /superadmin/clients` (already exists, unused) | "New client" form on the Clients page (name/email/password/website) |

### P2 — Tier 2 (high)
| Page | Entity | New backend endpoint(s) | Notes |
|------|--------|-------------------------|-------|
| **Departments** | `departments` | `GET/POST/PATCH/DELETE /superadmin/departments` | Operator grouping, per-dept business hours, routing |
| **Canned Responses** | `canned_responses` | `GET/POST/PATCH/DELETE /superadmin/canned-responses` | Operator quick-replies oversight |
| **BANT / Qualification Signals** | `bant_signals` | `GET /superadmin/bant-signals?session_id=` | Audit signal quality by dimension/confidence |
| **Outbound Webhook Registrations** | `webhooks` (vs deliveries) | `GET /superadmin/webhook-registrations`, toggle enable/disable, test-fire | Distinct from existing `/webhooks` deliveries view |

### P2 — Tier 3 (medium)
| Page | Entity | New backend endpoint(s) | Notes |
|------|--------|-------------------------|-------|
| **Payment Methods** | `payment_methods` | `GET /superadmin/payment-methods?client_id=` | Read-only, masked card/UPI/bank; default + expiry |
| **Meeting Bookings** | `meeting_bookings` | `GET /superadmin/meeting-bookings` | Calendly/Zcal bookings per bot, status, sync health |
| **OAuth Accounts** | `oauth_accounts` | `GET /superadmin/oauth-accounts?client_id=`, `DELETE …/{id}` (unlink) | Debug login/linked providers |
| **Failed Webhooks (DLQ)** | `failed_webhooks` | `GET /superadmin/failed-webhooks`, `POST …/{id}/replay` | Billing dead-letter replay with signature re-verify |
| **Referral Conversions** | `referral_conversions` | `GET /superadmin/referral-conversions?affiliate_id=` | Snapshot terms at conversion (feeds v2 payouts) |

### P2 — Tier 4 (low / enhancements)
- In-app Notifications viewer (`notifications`), Operator Push Subscriptions, Processed Webhooks (idempotency log), Bot Growth Events, Visitor-event per-session timeline (enhance `/visitors`), Platform Feedback export. Per-model/per-client LLM cost breakdown (enhance `/llm`).

### P2 — Superadmin CRUD gaps on existing entities (backend missing too)
A full superadmin tier should also be able to act on resources clients own. New endpoints to consider:
- `PATCH /superadmin/bots/{id}` (rename/deactivate), `DELETE /superadmin/bots/{id}`
- `POST/PATCH/DELETE /superadmin/operators` (provision/modify/deactivate operators)
- `DELETE /superadmin/sessions/{id}` (GDPR/test-data removal)

---

## Suggested sequencing

1. **P0** (1–2 days total): synthetic charts, integrations health, contract drift, cohort placeholder. Pure quality wins, low risk.
2. **Feedback feature** (P0.5 + P1.3) per companion plan (~3–4 days).
3. **P1.1 / P1.2** (permissions RBAC, settings) (~2 days).
4. **P2 Tier 1** (usage records, offline messages, create-client) (~1 week).
5. **P2 Tier 2 → Tier 3 → Tier 4** as capacity allows; each page is independent and shippable on its own.

## Notes
- Every new backend endpoint uses `Depends(get_superadmin)` (+ the write-guard for mutations) and `record_audit` on mutations, matching the conventions in `superadmin_routes_v2.py` / `superadmin_ops_routes.py`.
- New admin pages reuse `@/components/ui/*`, `PageHeader`, react-query, sonner, and `formatCents` (USD) — and must ship with loading + empty states (no stubs).
- Money stays USD-canonical via `core.pricing.display_price` / the admin's `planUsdCents`/`toUsdCents` helpers.
