# OyeChats — Product, UX, UI & Engineering Audit

> **Date:** 2026-07-16 · **Scope:** `oye-chats-platform/app` (React 19 / Vite 8 / Tailwind v4 admin dashboard) + supporting `api` (FastAPI) onboarding surface · **Mode:** read-only audit, no code changed · **Branch:** `development`
>
> Reviewed as a combined CEO / CTO / CPO / VP Design / Staff UX / Principal Designer / Frontend Architect / DS Architect lens. Findings are grounded in real `file:line` evidence gathered across five parallel deep-dives (frontend architecture & design system, onboarding/Build Studio, dashboard & app UX, auth & global systems, backend onboarding APIs).

---

## 0. Context: what changed since the last audit (2026-07-13)

This is **not** a rehash. Since the prior full-app audit, the product materially moved:

- The **"Prove-it-first" onboarding was actually built and shipped** (Connect → Prove → Personalize → Go live) — it was only an approved plan at the last audit. It's now the default ("Build Studio").
- **IA was consolidated** — many legacy routes (`webhooks`, `analytics`, `users`, `live-chat`, `interface`, `canned-responses`…) now redirect into tabbed parent pages.
- **Security holes were fixed** (operator-handoff IDOR, operator→superadmin escalation, per-IP credit-drain rate limiting) — not re-flagged here.
- **Two onboarding bugs were fixed** (infinite-crawl latch, duplicate-bot create) — verified sound at both layers.

So the app is in materially better shape than the last audit implies. The findings below target the **current** state.

---

## 1. Executive Summary

**Overall product maturity: ~7.5/10 — "premium, honest, well-engineered core with concentrated resilience and activation gaps."**

OyeChats is a genuinely strong, modern SaaS admin app. It is more polished and more *honest* than most products at this stage: there is no fabricated data, the design foundation (tokens, dark mode, focus/reduced-motion baseline) is real, cross-tenant isolation is carefully guarded, and the recently-rebuilt onboarding uses textbook activation sequencing (single-input entry, aha before naming/branding/install). The engineering shows unusual discipline — self-documenting comments, defensive backend validation, idempotency guards.

It is held back by a small number of **systemic, cross-cutting gaps** that punch above their weight because they touch trust, activation, and perceived performance:

### Biggest strengths (preserve these)
- **Data honesty** — explicit code-level refusal to fake charts/metrics (`Dashboard.jsx:349-352`).
- **Cross-tenant safety** — workspace-scoped `AbortController` cancels in-flight requests on workspace switch (`api.js:79-99`).
- **A11y baseline** — zero-specificity global `:focus-visible` + reduced-motion honoring (`index.css:355-424`); focus-trapped modals; roving-tabindex tabs/menus.
- **Onboarding sequencing** — one URL field, everything else inferred; aha deferred correctly (`ConnectStep.jsx`).
- **Backend defensiveness** — strong pydantic validation, SSRF-hardened URL checks, real server-side install detection (`bot_routes.py:390-402`), per-client crawl locks.

### Biggest risks
1. **Resilience is thin.** One app-wide error boundary renders a bare unstyled `<p>` (`main.jsx:36`); **no unsaved-changes guard exists anywhere** (silent data loss on the app's most complex forms).
2. **Time-to-first-value is gated by a full-site crawl** and two **synchronous LLM/embedding calls on the request path** (seed-questions, brand-tone) — the aha can be minutes of spinner.
3. **A broken resume experience** dumps returning onboarders on a blank step 1.
4. **No install-detection failure path** — a correctly-installed-but-undetected widget spins "Waiting…" forever.
5. **Performance debt** — zero code-splitting (all ~43k lines of pages in the initial bundle) and no data-fetch caching (5× `/auth/me` on dashboard load).

### Enterprise readiness verdict
**Conditionally ready.** The security/tenancy/data-integrity fundamentals are enterprise-grade. The gaps are in *resilience polish* (error boundaries, unsaved guards), *activation speed*, and *design-system consistency at scale* — all fixable without redesign, mostly in the frontend.

### 8 systemic root causes (everything below rolls up to these)
1. **No resilience layer** — missing error boundaries + unsaved-changes guard + retry UX.
2. **Synchronous work on the onboarding request path** — LLM/embeds block the aha.
3. **Thin/inconsistent API data contract** — pushed correctness burden onto the frontend (source of the recent bugs).
4. **No client data-fetch cache** — redundant fan-out, spinner flashes.
5. **No bundle strategy** — everything loads upfront.
6. **Design-token discipline erodes at scale** — 733 arbitrary text sizes, no radius/spacing scale, hardcoded hex.
7. **IA/terminology drift** — Settings vs Bot Settings, bot/chatbot/agent.
8. **Activation stops before proof** — resume/verify/next-action guidance incomplete after the first bot.

---

## 2. Product Journey Map (current state)

```
Landing (marketing site — separate repo)
  │
  ▼
Register  ──POST /auth/register──►  writes auth bundle (admin_is_verified:false)
  │                                  → /verify-email (?next preserved)
  ▼
Verify email  ──POST /auth/verify-email (6-digit OTP, paste/auto-submit)──►  /build
  │
  ▼
Login (returning)  ──❗operator-login FIRST (always 401 for clients) → admin-login──►  RootRedirect
  │                                                                        │
  │   RootRedirect fires /auth/me (again) + full-screen spinner ◄─────────┘
  ▼
BUILD STUDIO (full-screen, no sidebar)  ◄── auto-entered when bot_count==0 & !onboarding_complete
  │
  ├─ ① Connect  "Point me at your site"
  │     1 input (URL) → POST /bots (idempotent reuse) → bot created, name auto-derived
  │
  ├─ ② Prove  "Watch it learn — then prove it"     ◄── THE AHA
  │     auto-crawl (❗FULL SITE) → POST /crawl (202 + poll /crawl/progress)
  │     latch "trained" on crawl done → seed-question chips (❗sync LLM+embeds first call)
  │     tap chip → previewChat (❗non-streaming, 60s timeout) → answer in widget preview
  │
  ├─ ③ Personalize  "Make it yours"
  │     name pre-filled + accent color auto-detected from site (❗detect_brand_tone sync LLM)
  │
  └─ ④ Go live  "Put it live"
        PlatformSelector (14 platforms) + IntegrationGuide snippet (prod/dev)
        copy snippet → install → widget bootstrap stamps widget_installed_at (server-side)
        poll every 5s → "live on {host} 🎉"   (❗no failure path if never detected)
        finish() → completeOnboarding() (❗fires even if never installed)
  │
  ▼
DASHBOARD  greeting + Resume-setup nudge (self-hides on complete) + 4 stat cards +
           4 Quick Actions + Lead Funnel (real chart on paid / upgrade card on Free)
  │
  ▼
App shell: Build · Knowledge · Insights · Leads · Qualification · Integrations ·
           Chatbot(=Bot Settings) · Support · Team · Billing · Settings · Affiliate
```

❗ = friction/risk point detailed below.

---

## 3. UX Audit Report

### 🔴 Critical
- **No unsaved-changes guard anywhere.** `grep beforeunload|isDirty|useBlocker` → 0 hits. `BotSettings.jsx` (7 tabs, ~40 fields) and `Integrations.jsx` (Email/Meetings) silently discard edits on bot-switch (`BotSettings.jsx:219-221`, `Integrations.jsx:187-204,458-465`), sidebar nav, or workspace switch. Perceived as "the app ate my changes." *(3 of 5 deep-dives independently flagged this.)*
- **Onboarding aha gated behind a full-site crawl.** `ProveStep.jsx:140-160` crawls **every** discovered page (`maxPages: orderedUrls.length`) and only latches `trained` on `status==='done'` (`:176-184`). On a 50–200 page site with RPM-bound embeddings, that's minutes of spinner before any value.
- **Resume is broken.** `StudioResumeCard.jsx:91` links to bare `/build` → always step 1; `ConnectStep` doesn't prefill the known website (`ConnectStep.jsx:35`) and `canSubmit` blocks until re-typed (`:38`). "Pick up where you left off" delivers "start over."
- **Install-detection has no failure path.** If `Origin`/`Referer` is stripped (auth-walled site, CSP, privacy config), the banner spins "Waiting to detect your widget…" forever (`GoLiveStep.jsx:105-112`) — no timeout, no "Verify now," no troubleshooting.

### 🟠 High
- **Preview answer is non-streaming with a 60s blocking timeout** (`api.js:1156-1165`). The highest-trust moment is *less* alive than the real widget, and a slow-but-OK model throws into a **false** "The agent could not answer that" (`BuildStudio.jsx:121-125`).
- **Login fires a guaranteed-failing operator login first on every client sign-in** (`Login.jsx:69-108`) — doubles perceived latency, pollutes auth logs/rate limiters with expected 401s.
- **`/auth/me` fan-out: 5 uncoordinated calls on dashboard load** (`App.jsx` RootRedirect, `VerifyEmailBanner:56`, `useTrialStatus:39`, `TopBar:194`, `Sidebar:145`) with no shared cache; `RootRedirect` also re-fetches + full-screen spinner on every `/` visit.
- **Prove conversation is wiped on any navigation** (`BuildStudio.jsx:102-104` `goTo` resets `previewMessages`). Go back to re-test → proof evaporates.
- **`finish()` completes onboarding even if the widget was never installed** (`GoLiveStep.jsx:78-83`) — non-installers silently lose the resume nudge.
- **Weak next-action guidance after the first bot.** Resume nudge disappears; Quick Actions are static, not progress-aware; no "your widget isn't live yet" signal, no activation checklist (`Dashboard.jsx:260-307`).

### 🟡 Medium
- **"Settings" vs "Bot Settings" naming collision** (`Settings.jsx:37`, `Sidebar.jsx:244-247`) — two destinations, opposite sidebar ends, different scopes. Code comment even points users between them.
- **Bot Settings has no stable, bot-scoped route** — it's a query-param mode of `Chatbot.jsx` (`?tab=appearance`), not linkable/bookmarkable per bot.
- **Terminology drift: bot / chatbot / agent** across sidebar, buttons, onboarding.
- **No pre-submit URL validation at Connect** (`ConnectStep.jsx:38`) — typos cost a full create+discover round-trip.
- **Forward-jumping stepper is unguarded** (`BuildStudio.jsx:44-46,180`) — can skip to Go-live before training.
- **TopupModal renders a blank body on zero packs** (`TopupModal.jsx:138-214`).
- **Save "success" is a 3s flash, not a persistent state** (`BotSettings.jsx:496-497`, `Integrations.jsx:230`).
- **Inconsistent loading:** real `SkeletonLoader` on data pages, bare spinners on ~33 pages; auth transitions full-screen spin.
- **Silent-failure endpoints** — `getCrawlProgress`→`{idle}`, `getMyOperatorStatus`→`null` swallow errors with no user affordance (`api.js:415,1531`).
- **"Progress saved" badge overpromises** — `?m=` step position isn't persisted (`BuildStudio.jsx:168-170`).

### 🟢 Low / strengths
- Single-input onboarding entry, warm confident copy, human error messages, comprehensive per-step state coverage, `BotCard` accessibility, lock-in-place upsell (no dead-end 403s), dismissible resume nudge, honest empty states everywhere.

---

## 4. UI Audit Report

### 🔴 Critical
- **Type scale bypassed 733× with arbitrary `text-[Npx]`** — including core UI (`DataTable.jsx:60`, `StatCard.jsx:69-108`, `Tabs.jsx:55`, `Avatar.jsx:4-8`, `Badge.jsx:22-23`). `index.css:46-54` acknowledges a promised codemod that hasn't shipped. Single biggest consistency debt.

### 🟠 High
- **No radius or spacing token** — corner radius is a free-for-all: `rounded-xl`(340), `rounded-lg`(298), `rounded-2xl`(164), `rounded-md`(68)… even within `ui/` (Button `lg/xl`, Card `2xl`, Input `xl`, Badge `/md/lg`).
- **137 hardcoded hex + 11 arbitrary `bg-[#…]`** outside `ui/` — e.g. `AdminLayout.jsx:210` hardcodes `from-[#a21caf] to-[#86198f]` + raw `rgba(...)` shadow that already exist as `--color-primary-600/700`.
- **97 inline `style={{…}}` blocks** — many static styling that belongs in classes.

### 🟡 Medium
- **Only 2 of 16 UI components use CVA** (Button, Badge). Card/Dialog/Drawer/Alert/StatCard/Toggle/Select/Tabs use ad-hoc `size`/`variant`/`type`/`color` maps — inconsistent variant contract.
- **Input has no size/variant/state coverage** (fixed `h-10`) — can't align with Button's xs–xl in a row.
- **3 competing toast systems** — `components/Toast.jsx` (dead) + `context/ToastContext.jsx` (canonical) + `sonner`.
- **No Tooltip/Menu/Popover primitive** — bespoke dropdowns re-implemented (`SettingsDropup`, `IntegrationMenu`, `RecrawlMenu`).
- **`dark:` coverage inconsistent** — 29/133 files have zero `dark:`; `Insights.jsx` + `Support.jsx` are real app surfaces with hardcoded hex and no dark handling (light-on-light risk).
- **Contrast risks** — `--text-muted`=`surface-400` on white; `DataTable` headers `surface-500` on `surface-50`; `StatCard` captions `surface-400` @11px — likely < 4.5:1.
- **Save-button placement inconsistent** — top app-bar (BotSettings) vs bottom (Integrations, Settings).

### 🟢 Low
- Dead code: `ThemeSelector.jsx` (0 imports), `App.css` (Vite boilerplate, unimported), `components/Toast.jsx`, `assets/react.svg`. Stale "retained one release" affiliate cruft in `App.jsx:15-18`.

---

## 5. Technical Audit Report

### Frontend
- 🔴 **No code splitting / lazy loading** — `React.lazy`/`Suspense` = 0 hits; all pages static-imported (`App.jsx:24-43`), incl. `LiveChat.jsx` (2,910 lines), `KnowledgeBase` (1,810), `Billing` (1,489), `Leads` (1,423). No `manualChunks` (`vite.config.js:13`).
- 🔴 **Single top-level error boundary**, bare `<p>` fallback (`main.jsx:36`) — any render error white-screens the SPA (this already bit prod via the RootRedirect crash).
- 🟠 **No data-fetch/cache layer** — hand-rolled `useState`/`useEffect` everywhere; no react-query/swr; duplicate `/auth/me`, `/entitlements`, `/bots` across navigations.
- 🟠 **Mega-pages** mix fetch + logic + presentation (LiveChat/KnowledgeBase/Billing/Leads) — hard to test/lazy-load.
- 🟡 **`services/api.js` is a 2,706-line monolith** — split by domain.
- 🟢 **Strong:** centralized API client with header injection + workspace `AbortController` + `buildApiError` FastAPI-shape unwrapping; solid session handling; Sentry wired correctly (env-gated, PII off, prod `console` drop).

### Backend (onboarding path)
- 🔴 **Seed-questions first call blocks on sync LLM (≤~180s worst case) + up to 5 sequential rate-limited embeds, DB session held** (`bot_routes.py:1543-1571`, `seed_questions_service.py:58-93`). Biggest TTFV risk.
- 🔴 **Seed-questions cache-poisoning race** — `[]` computed before ingestion finishes is permanently cached (`is not None` = hit); bot stuck "no sample questions" unless `?force=true` (`seed_questions_service.py:69`, `bot_routes.py:1566-1570`).
- 🟠 **`POST /bots` returns a thin 4-field envelope, not `BotResponse`** (`:1283-1288`) — forced the frontend to re-fetch and *directly enabled* the duplicate-bot bug.
- 🟠 **No server-side idempotency on bot create** — reuse logic lives only in the frontend; a double-submit → confusing 402.
- 🟠 **Crawl completion is a client-scoped, self-expiring, poll-only signal** — no durable per-bot "trained/N chunks" fact; `/crawl/progress` omits `bot_id` (`document_routes.py:476`). This is the *shape* behind the infinite-crawl illusion (backend was actually correct — per-client lock → 429 on re-fire).
- 🟠 **Inconsistent error/success envelopes** — `detail` is sometimes string, sometimes `{error,metric,message}`, sometimes a list; success shapes vary per endpoint. Onboarding client must special-case each.
- 🟠 **`detect_brand_tone` is a second sync LLM call in a sync endpoint** (`bot_routes.py:1509-1540`) — same threadpool-starvation shape.
- 🟡 **`update_bot` collapses all failures to a generic 500** (`:1774-1776`) — no field context for the settings UI.
- 🟡 **Crawl page-limit docstrings conflict** (75/300/750/5000 vs "20-page allowance" vs CLAUDE.md 20) — real limits come from DB, but the inline numbers mislead.
- 🟢 **Strong:** 202+poll crawl offload, real server-side install detection with internal-host exclusion, SSRF-hardened URL validation, per-client crawl lock.

### Accessibility (cross-cutting)
- 🟠 **Modals/drawers don't restore focus to the trigger on close** (WCAG 2.4.3) — `Dialog.jsx`, `Drawer.jsx`.
- 🟠 **Custom `Select` omits `aria-activedescendant`** — keyboard highlight invisible to screen readers (`Select.jsx`).
- 🟠 **Auth forms lack label associations** — `htmlFor`=0 in Login/VerifyEmail/ForgotPassword; no `id`/`aria-invalid`/`aria-describedby`.
- 🟡 Focus-trap includes hidden/disabled nodes; muted-token contrast (see UI).

---

## 6. Design System Audit

| Area | State | Action |
|---|---|---|
| **Color tokens** | ✅ Full `primary` 50–900 + `surface` 50–950 + semantic accents + dark-flipping CSS vars | Keep; migrate 137 hex + 11 `bg-[#…]` onto them |
| **Type scale** | ⚠️ `--text-2xs` exists but bypassed 733× | Ship codemod; add `text-3xs`/`text-md` rungs; lint-ban `text-[Npx]` |
| **Radius/spacing** | ❌ No token | Add `--radius-sm/md/lg`; map components |
| **CVA variants** | ⚠️ Only Button + Badge | Standardize Card/Alert/Input on CVA |
| **Missing primitives** | ❌ Tooltip, Menu/Dropdown, Popover | Extract shared `Menu`/`Popover`/`Tooltip` |
| **Input variants** | ❌ Single fixed size/state | Add sm/lg + success/disabled + error via CVA |
| **Toasts** | ⚠️ 3 systems | Delete `components/Toast.jsx`; standardize on `ToastContext` (wraps sonner) |
| **Dark mode** | ✅ Real + reachable (toggle + settings) | Fix `Insights`/`Support` coverage |
| **Focus/motion** | ✅ Global `:focus-visible` + reduced-motion | Keep; add focus-restore on modal close |
| **Dead components** | `ThemeSelector`, `Toast`, `App.css`, `react.svg` | Delete |

---

## 7. Product Recommendations

### Quick Wins (low effort · high impact)
1. **Resume: deep-link `?m=<step>` + prefill Connect from `bots[0].website`.** *(FE, ~½ day)* — recovers every mid-flow skipper.
2. **Install-verify: after ~30s of no detection, show "Verify now" + troubleshooting panel.** *(FE, ~½ day)*
3. **Branded, resettable error-boundary fallback** (logo + reload + support link) replacing the bare `<p>`. *(FE, ~½ day)*
4. **Stop caching `[]` seed-questions when bot has 0 documents.** *(BE, ~2 hrs)* — one-line correctness fix.
5. **Return full `BotResponse` from `POST /bots`.** *(BE, ~2 hrs)* — removes a round-trip + a bug class.
6. **TopupModal zero-pack empty state; keep resume nudge until `widget_installed_at`; honest "Progress saved" copy.** *(FE)*
7. **Delete dead code; standardize `showToast` arg order + lint.** *(FE)*

### Medium-Term (architectural)
1. **Onboarding fast-path crawl** — crawl homepage + top nav first, latch `trained` in ~20-30s, background the rest with "still learning N pages." *(BE+FE)*
2. **Move seed-questions + brand-tone off the request path** (ARQ at end-of-ingestion; Prove polls cached read). *(BE)*
3. **Stream the preview answer (SSE)** like the real widget; kill the false "could not answer." *(FE+BE)*
4. **Unsaved-changes guard** — reusable `useUnsavedGuard(dirty)` (`useBlocker` + `beforeunload`) on BotSettings + Integrations. *(FE)*
5. **Route-based code splitting** (`React.lazy` + `Suspense`), starting with LiveChat/Billing. *(FE)*
6. **`useCurrentUser()` shared cache** — collapse the 5× `/auth/me` fan-out; render dashboard optimistically. *(FE)*
7. **Durable per-bot ingestion state** (status + chunk count + completed_at; `bot_id` in progress). *(BE)*
8. **Server-side idempotent bot create.** *(BE)*
9. **Standardize the API error envelope** (`detail.error` code + `detail.message`). *(BE)*
10. **Route-level error boundaries** around `<Outlet/>`. *(FE)*

### Long-Term Vision (best-in-class activation)
- **Instant, demonstrated aha** — auto-ask the first seed question, streamed, on a homepage-only fast index, so the user *sees* it work in ~20s without lifting a finger.
- **Activation checklist as a first-class dashboard object** keyed off real signals (docs ✓ / embed pageview ✓ / first conversation ✓), replacing static Quick Actions.
- **Design-system enforcement in CI** — lint-ban arbitrary `text-[Npx]`/hex, enforce token usage, so consistency doesn't erode again at scale.
- **Data-fetch cache (TanStack Query) app-wide** — dedup, stale-while-revalidate, skeletons over spinners everywhere.
- **Decompose mega-pages + split `api.js` by domain** for testability and lazy-loading.

---

## 8. Prioritized Roadmap (v2 — rebuilt from scratch, effort-first)

> Rebuilt 2026-07-16 from the raw findings only, independent of any prior roadmap/doc. Prioritized by **(impact ÷ effort × confidence)**, with cheap high-value fixes front-loaded so we ship value in week 1. Effort: XS (≤2h) · S (≤½ day) · M (1–3 days) · L (3–5 days). Every item traces to a finding in §3–§6.

### Phase 0 — Same-day quick wins (ship first, low risk)
**Goal:** remove the sharpest edges immediately; each is XS/S and independently shippable.
| # | Item | Layer | Effort | Lever | Finding |
|---|---|---|---|---|---|
| 0.1 | Stop caching `[]` seed-questions when bot has 0 docs (cache-poison) | BE | XS | TTFV/correctness | F2 |
| 0.2 | Return full `BotResponse` from `POST /bots` | BE | S | Correctness | F3 |
| 0.3 | Server-side idempotent/reuse bot create | BE | S | Correctness | F4 |
| 0.4 | Fix resume: deep-link `?m=<step>` + prefill Connect from `bots[0].website` | FE | S | Activation | 5.1 |
| 0.5 | Install-detect: timeout → "Verify now" + troubleshooting panel | FE | S | Activation | 4.4 |
| 0.6 | Keep resume nudge until `widget_installed_at` set | FE | S | Activation | 4.5 |
| 0.7 | Branded, resettable error-boundary fallback (replace bare `<p>`) | FE | S | Trust | F11 |
| 0.8 | Pre-submit URL validation/normalize at Connect | FE | S | Activation | 3.3 |
| 0.9 | TopupModal zero-pack empty state | FE | XS | Polish | §3 |
| 0.10 | Delete dead code (`ThemeSelector`, `App.css`, `Toast.jsx`, `react.svg`); standardize `showToast` arg order | FE | S | Maintainability | §5/F8 |
| 0.11 | Reconcile crawl page-limit docstrings | BE | XS | Clarity | F7 |

### Phase 1 — Kill the activation killers (the TTFV story)
**Goal:** make the aha land in ~20–30s, streamed and demonstrated, on durable state.
| # | Item | Layer | Effort | Lever |
|---|---|---|---|---|
| 1.1 | Durable per-bot ingestion state (status + chunk count + completed_at) + `bot_id` in `/crawl/progress` | BE | M | Trust/correctness (unblocks 1.2) |
| 1.2 | Fast-path crawl: homepage + top nav first, latch `trained` early, background the rest | BE+FE | L | Time-to-value |
| 1.3 | Move seed-questions to ARQ at end-of-ingestion; Prove polls a cached read | BE | M | Time-to-value |
| 1.4 | `detect_brand_tone` async/backgrounded | BE | S | Time-to-value |
| 1.5 | Stream the preview answer (SSE); fix false "could not answer" on slow model | FE+BE | M | Trust/Activation |
| 1.6 | Auto-ask the first seed question so the aha is *shown* | FE | S | Activation |
| 1.7 | Persist Prove conversation across navigation; guard forward stepper jumps | FE | S | Activation |
| 1.8 | Login: stop the always-failing operator-login-first | FE/BE | S | Activation/latency |

### Phase 2 — Trust & resilience
**Goal:** no silent data loss, no white-screens, no silent degradation.
| # | Item | Layer | Effort | Lever |
|---|---|---|---|---|
| 2.1 | Reusable `useUnsavedGuard(dirty)` (`useBlocker` + `beforeunload`) on BotSettings + Integrations | FE | M | Trust |
| 2.2 | Route-level error boundaries around `<Outlet/>` | FE | S | Trust |
| 2.3 | Surface silent-failure endpoints (crawl-progress, operator-status) + basic retry UX | FE | M | Trust |
| 2.4 | Persistent saved/dirty indicator (replace 3s flash) | FE | S | Trust |
| 2.5 | A11y: focus-restore on modal/drawer close; `Select` `aria-activedescendant`; focus-trap excludes hidden/disabled | FE | M | Accessibility |
| 2.6 | Auth form labels (`htmlFor`/`id`/`aria-invalid`/`aria-describedby`) + field-level errors | FE | M | Accessibility/Activation |

### Phase 3 — Performance & scale
**Goal:** cut initial load and redundant fetches; make the codebase scale.
| # | Item | Layer | Effort | Lever |
|---|---|---|---|---|
| 3.1 | Route code-splitting (`React.lazy` + `Suspense`), starting LiveChat/Billing | FE | M | Performance |
| 3.2 | `useCurrentUser()` shared cache (collapse 5× `/auth/me`) + optimistic dashboard | FE | M | Performance |
| 3.3 | Standardize API error envelope (`detail.error` code + `detail.message`); field-level errors from `update_bot` | BE | M | Maintainability |
| 3.4 | Split `api.js` (2,706 lines) by domain | FE | M | Maintainability |
| 3.5 | Decompose mega-pages (LiveChat/KnowledgeBase/Billing/Leads) | FE | L | Maintainability |
| 3.6 | Broader data-fetch cache (TanStack Query) — optional, after 3.2 proves the pattern | FE | L | Performance |

### Phase 4 — Design system & IA hardening
**Goal:** lock consistency + navigation clarity so they don't erode again.
| # | Item | Layer | Effort | Lever |
|---|---|---|---|---|
| 4.1 | Type-scale codemod + lint-ban arbitrary `text-[Npx]` (733 sites) | FE | M | Consistency |
| 4.2 | Radius/spacing tokens + hex→token migration (137 hex) | FE | M | Consistency |
| 4.3 | CVA standardization (Card/Alert/Input) + Input size/state variants | FE | M | Consistency |
| 4.4 | Extract Tooltip/Menu/Popover primitives | FE | M | Consistency |
| 4.5 | IA: rename Settings-vs-Bot-Settings collision; bot-scoped `/bots/:id/settings` route; unify bot/chatbot/agent | FE | M | Clarity |
| 4.6 | Dashboard activation checklist (docs ✓ / embed pageview ✓ / first chat ✓) | FE | M | Retention |
| 4.7 | Insights/Support dark-mode coverage + muted-token contrast audit | FE | S | Polish |

**Sequencing note:** 0.2/0.3 (create contract + idempotency) and 1.1 (durable trained state) are backend prerequisites that make the frontend activation work clean — do them before 1.2/1.5. Everything in Phase 0 is parallelizable and non-blocking.

---

## Success criteria mapping
Every roadmap item maps to ≥1 target metric:
- **Activation / TTFV:** fast-path crawl, resume fix, install-verify, streamed aha, auto-ask, login fix.
- **Trust:** error boundary, unsaved guard, durable trained state, honest copy, a11y.
- **Performance:** code splitting, `useCurrentUser` cache.
- **Consistency / Maintainability:** type/radius tokens, CVA, error-envelope, mega-page decomposition, dead-code removal.
- **Enterprise readiness:** a11y (WCAG 2.4.3, labels, aria), IA clarity, resilience.

*No item is cosmetic-only; each has a measurable product or engineering benefit.*
