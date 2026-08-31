# Plan — Admin PWA + Web Push Coverage Gaps

**Scope:** `platform/app/` (React admin dashboard) + `platform/api/` (FastAPI backend)
**Goal:** Make the operator experience feel like a real installable app, and close the coverage holes in the existing Web Push implementation so no operator misses a chat.

> **Status: SHIPPED** (verified against source 2026-08-31). Retained as the decision record
> — particularly the "do not install `vite-plugin-pwa` / Workbox" constraint and the
> non-goals — not as a plan of work. Every phase is present in the tree:
>
> | Phase | Evidence |
> |---|---|
> | 1 — installable shell | `app/public/manifest.webmanifest`; `app/public/icons/{icon-192,icon-512,icon-maskable-192,icon-maskable-512,apple-touch-icon-180}.png`; manifest + `apple-touch-icon` + `theme-color` wired in `app/index.html` |
> | 2 — offline shell | `app/public/sw.js` — `BUILD_ID = '__OYECHATS_BUILD_ID__'`, `PRECACHE_ASSETS`, `CACHE_PREFIX = 'oyechats-shell-v'`, `IS_BUILT` guard; `app/public/offline.html` |
> | 3.1 — multi-process presence | `worker/tasks.py:1868,2166,2232` use `operator_presence_service.get_online_operator_ids`, not `manager.operator_connections` |
> | 3.2 — offline-form push | `task_dispatch_offline_message_push` (`worker/tasks.py:2206`), registered in `worker/settings.py` |
> | 3.3 — transfer push | `chat_transferred` (`live_chat_service.py:1203`, `push_service.py:336`) |
> | 3.4 — notification prefs | `push_service.filter_operators_by_push_prefs` (`:415`), consulted per dispatch |
> | 3.5 — router extraction | `api/app/api/push_routes.py` |
>
> One number in §1.2 did not survive: `theme_color` shipped as `#010B23`, not the `#0b0f19`
> proposed here. `app/index.html` and `manifest.webmanifest` agree with each other, which is
> the invariant that mattered.

---

## Context — what already exists (do not rebuild)

| Layer | Already built |
|---|---|
| Backend | `services/push_service.py`, `OperatorPushSubscription` table, VAPID config in `config.py`, `POST/DELETE /operators/push/subscribe`, `GET /operators/push/vapid-public-key`, ARQ tasks `task_dispatch_handoff_push` + `task_handoff_escalation` |
| Frontend | `public/sw.js` (hand-written SW), `hooks/usePushNotifications.js`, `context/PushContext.jsx`, `PushPermissionBanner`, `NotificationBell`, `settings/NotificationsTab.jsx`, deep-link routing on `notificationclick` |
| Layering | In-page WS handles tab-open (beep + native `Notification` when `document.hidden`); Web Push handles tab-closed |

**Do not** install `vite-plugin-pwa` or Workbox. Vite 8-beta is hard-pinned via `overrides` in `package.json`; the plugin has no Vite-8 support. Extend the existing hand-rolled SW instead.

---

## Phase 1 — Installable PWA shell (frontend only)

**Outcome:** operators can install the dashboard as a standalone app on macOS, Windows, iOS, Android. This is the "feels like Linear, not a tab" delta.

### 1.1 Generate proper icon assets

Current `public/` has brand images (`oye_favicon_cropped.png` is 236KB, not square-optimized) but no PWA icon set.

Deliverable: add to `platform/app/public/`:
- `icons/icon-192.png` (192×192, square, safe area)
- `icons/icon-512.png` (512×512, square, safe area)
- `icons/icon-maskable-192.png` (192×192, 20% safe padding for Android adaptive icons)
- `icons/icon-maskable-512.png` (512×512, 20% safe padding)
- `icons/apple-touch-icon-180.png` (180×180, no transparency)

Source of truth: crop `oye_new_final.png` to square, export at each size. Total added weight ~80KB (vs today's 236KB single mis-sized asset).

### 1.2 Create `public/manifest.webmanifest`

```json
{
  "name": "OyeChats Support",
  "short_name": "OyeChats",
  "description": "Live chat + bot management for OyeChats operators",
  "start_url": "/support",
  "scope": "/",
  "display": "standalone",
  "orientation": "portrait-primary",
  "background_color": "#0b0f19",
  "theme_color": "#0b0f19",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-maskable-192.png", "sizes": "192x192", "type": "image/png", "purpose": "maskable" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "shortcuts": [
    { "name": "Live chat queue", "url": "/support", "description": "Jump straight to waiting chats" },
    { "name": "Team", "url": "/team" }
  ]
}
```

Notes:
- `start_url: "/support"` — installers land directly on the live-chat queue (the reason they installed).
- `theme_color` must match `<meta name="theme-color">` in `index.html`.
- Confirm final `background_color` / `theme_color` against `ThemeProvider` default (may be light for some users — dark is a safer default for the splash frame since most operator use is heads-down).

### 1.3 Update `platform/app/index.html`

Add inside `<head>`:
```html
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#0b0f19" />
<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-180.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="OyeChats" />
```

Remove the current `apple-touch-icon` pointing at the 236KB `oye_favicon_cropped.png`.

### 1.4 Vercel serving check

`vercel.json` has a catch-all rewrite `/(.*) → /index.html`. Static files in `public/` are served before the rewrite (already true for `sw.js`), so `manifest.webmanifest` and `icons/*` will resolve. Verify with `curl -I` after deploy. **No config change expected.**

### 1.5 Verification

- Chrome DevTools → Application → Manifest: no errors, icons present, "Installability" ✅
- Chrome address bar shows install icon
- `Lighthouse → PWA` category: installable ✅
- iOS Safari → Share → Add to Home Screen: standalone launch, no Safari chrome
- Installed app on macOS opens with correct icon in Dock

---

## Phase 2 — Offline shell (careful, deploy-safe extension of existing SW)

**Outcome:** app reload is instant, network blips show a proper offline screen instead of a broken page. Historically avoided because of the "stale JS after deploy" risk — the current `sw.js` explicitly documents that fear. Solve it properly with versioning.

### 2.1 Strategy

Extend `public/sw.js` (do not replace it — it holds critical push logic). Add:

- **Precache versioned by build hash** — inject `__BUILD_ID__` at build time via a tiny Vite plugin (or a `postbuild` script that string-replaces a placeholder). Cache name: `oyechats-shell-v${BUILD_ID}`.
- **Navigation-fallback strategy: network-first with 3s timeout, cached shell as fallback.** This prevents ever serving stale JS while online — only degrades to cached shell when the network really fails.
- **Precache targets:** `/`, `/index.html`, root `/manifest.webmanifest`, `/icons/*`, top-level CSS/JS emitted by Vite (globbed at build time and passed into the SW). Do **not** precache API responses.
- **On `activate`:** delete all `oyechats-shell-v*` caches that don't match the current `__BUILD_ID__`. This is the "cleanup on deploy" that removes the stale-JS concern.

### 2.2 Build wiring

Add a Vite plugin in `vite.config.js`:
- After bundle emit, read the manifest of emitted assets.
- Read `public/sw.js`, replace `__BUILD_ID__` and `__PRECACHE_MANIFEST__` placeholders, write to `dist/sw.js`.
- Keep source `public/sw.js` clean of build details; the placeholders are the only build-time coupling.

### 2.3 Offline fallback UI

Add `public/offline.html` — minimal branded page ("You're offline. Reconnecting…"). SW navigation handler falls back to it only when both network and shell cache fail (rare).

### 2.4 Deploy-freshness invariant (address the SW author's original concern)

Document in the SW header comment:
> Shell cache is versioned by build ID. A new deploy invalidates the old cache on `activate`. Network-first for navigations means online users always get the current build; only true network failures fall through to cache. Never precache API responses.

### 2.5 Verification

- Load app, take offline in DevTools → refresh → shell loads from cache, app boots, sockets show reconnecting state
- Deploy new build → hard refresh → old cache purged in `activate`, no stale JS served
- Chrome DevTools → Application → Storage → confirm cache name matches current build hash

---

## Phase 3 — Close Web Push coverage gaps (backend)

Five real gaps the investigation found. In priority order:

### 3.1 [P0] Multi-process presence check — `worker/tasks.py` L1099

**Problem:** `task_dispatch_handoff_push` decides whether to skip push for an operator by reading `manager.operator_connections` — but `manager` is a module-level singleton **in the ARQ worker process**, which is a different process from the FastAPI API. In prod (gunicorn + separate worker), the worker's `operator_connections` is always empty → **every operator is treated as off-WS → every connected operator gets both a WS toast and a push**. Double-notification, and no delivery skip works as designed.

**Fix:** Replace the `operator_connections` check with `operator_presence_service.get_online_operator_ids()` (Redis-backed, shared across processes). Add a `PUSH_WS_GRACE_SECONDS` (already in config, 30s) leeway — if an operator went online <30s ago, still push, to avoid a race where they haven't fully wired up their WS listeners.

**Verify first:** run one prod push and check logs — if you see operators getting both channels today, this bug is live. High confidence it is.

### 3.2 [P0] Offline-form submission → no push — `offline_message_routes.py` L79–119

**Problem:** When a visitor submits the out-of-hours offline form, backend sends **email only**. If the workspace has push-enabled operators or the client owner, they get nothing on their phone/desktop until they check email.

**Fix:** After the email enqueue, also enqueue a push task (new: `task_dispatch_offline_message_push`) that fans out to eligible operators for the bot's client + always to the client owner (mirrors `send_push_to_client` pattern). Payload: `type="offline_message_received"`, `title="New offline message"`, `body=<visitor name + preview>`, `tag=f"offline:{message_id}"`, `target_path=/support?tab=offline&id=<id>`. Frontend deep-link already handled by existing SW `notificationclick`.

### 3.3 [P1] Chat transfer to off-WS operator → no push — `live_chat_service.py` L840–867

**Problem:** `transfer_chat()` sends `"chat_accepted"` over WS only. If the transfer target is off-WS, they don't know a chat was moved to them.

**Fix:** In `_transfer_chat_inner()`, after the WS send, if the target operator id is not in Redis presence (or not delivered), enqueue `send_push_to_operator` with `type="chat_transferred"`, `tag=f"transfer:{session_id}"`, `requireInteraction=true` (matches SW's asymmetric rule for critical events).

### 3.4 [P1] `Operator.notification_preferences` not honored

**Problem:** JSONB `notification_preferences` field exists on `Operator` but no push code path consults it. No per-operator quiet hours / channel opt-out possible.

**Fix:** Add `filter_operators_by_push_prefs(operator_ids, event_type, now)` helper in `push_service.py`. Consult it in every dispatch task before calling `send_push_to_operators`. Define the schema now (v1 minimal):
```json
{
  "push": {
    "enabled": true,
    "quiet_hours": { "start": "22:00", "end": "07:00", "tz": "Asia/Kolkata" },
    "events": { "handoff_request": true, "visitor_message": true, "offline_message": true, "chat_transferred": true }
  }
}
```
Missing prefs → default to all-enabled (backward compat). Add a Settings→Notifications UI in a follow-up.

### 3.5 [P2] Push endpoints bolted onto `operator_routes.py`

**Problem:** `/push/*` endpoints live at L2037–2133 of a 2000+ line file.

**Fix:** Extract to `api/push_routes.py`, register in `main.py`. No behavior change, pure hygiene. Do this last, in a separate PR, so it doesn't gate the P0 fixes.

---

## Phase 4 — QA + rollout

### 4.1 Manual QA matrix

| Scenario | Expected |
|---|---|
| Install app on macOS Chrome | App in Dock, opens standalone, correct icon |
| Install on iOS Safari (Add to Home Screen) | Standalone launch, no Safari chrome, splash color matches theme |
| Cold reload while offline | Shell loads from cache, "reconnecting" state |
| Deploy new build, hard refresh | New JS served, old cache purged in `activate` |
| Op logged out on desktop, chat waits → push arrives on phone (installed) | ✅ Push arrives, click deep-links to `/support?session=<id>`, login-bounce preserves next param |
| Op online on WS → new handoff | WS toast **only** (no double push — validates 3.1 fix) |
| Offline form submitted at 2am | Push AND email fire to workspace owner + eligible operators |
| Chat transferred from A to B (B offline) | B gets push tagged `transfer:<sid>` |
| Op sets `push.enabled=false` in prefs | No push, WS still works |

### 4.2 Metrics to add (observability)

- Log `push_dispatched_total{event_type, delivered, skipped_reason}` for the 3 dispatch tasks
- Log `push_subscription_pruned_total` (410-Gone deletions) — already implicit in `_send_push_to_rows`
- Sentry breadcrumb on every push send outcome

### 4.3 Rollout

- Phase 1 (manifest) — ship independently, low risk
- Phase 2 (offline shell) — ship behind a small feature flag or after Phase 1 bakes 48h; the SW change is the highest-risk piece here
- Phase 3.1 (presence fix) — ship ASAP if double-push confirmed in prod, standalone PR
- Phase 3.2–3.4 — one PR each
- Phase 3.5 — hygiene, last

---

## Non-goals (explicitly out of scope)

- PWA for the widget (`platform/widget/`) — SW scope conflicts with host sites, not doing it
- PWA for landing page (`oyechats-website/`) — no user value
- Push for visitors — separate design problem
- Replacing the existing `sw.js` with Workbox — Vite 8-beta compatibility risk
- Client (non-operator) push polish — the client subscribe path exists; audit and improve later, not gating this plan

---

## Effort estimate

| Phase | Rough effort |
|---|---|
| 1. Installable PWA shell | 0.5 day (mostly icon generation + testing on real devices) |
| 2. Offline shell w/ versioned cache | 1 day (Vite plugin + SW changes + verification across a deploy) |
| 3.1 Presence fix | 0.5 day + prod verification |
| 3.2 Offline-form push | 0.5 day |
| 3.3 Transfer push | 0.25 day |
| 3.4 Notification prefs filter (backend only, no UI yet) | 0.5 day |
| 3.5 Push router extraction | 0.25 day |
| 4. QA + rollout | 0.5 day |
| **Total** | **~4 days** |

Front-loaded on Phase 1 + 3.1 for the biggest visible/reliability wins in the first day.
