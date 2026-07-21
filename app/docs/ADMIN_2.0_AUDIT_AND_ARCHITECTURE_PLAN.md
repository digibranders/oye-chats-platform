# OyeChats Admin Platform 2.0 — UX & Product Architecture Audit + Implementation Plan

> **Status:** Proposal / plan. **No code has been changed.** This is the Phase-0 deliverable required by `app/CLAUDE.md` before any rebuild work begins.
> **Author lens:** Principal Product Architect (per mandate).
> **Scope:** `app/` admin dashboard only. Backend, APIs, DB models, auth are **reused, not rebuilt**.
> **Date:** 2026-07-21.

---

## 0. Executive Summary

The current admin app is a **capable but structurally overloaded SPA**: ~40 pages, ~60 components, 11 React contexts, and a deep feature set (RAG, live chat, BANT, billing, webhooks, affiliates, multi-workspace). The *engine* is strong and largely reusable. The *product architecture* is not.

Three findings define the rebuild:

1. **There is no agent-scoped information architecture.** Every operational page (`/knowledge`, `/insights`, `/leads`, `/analytics`…) silently reflects a single global `selectedBot` held in `BotContext` and persisted to `localStorage['selected_bot_id']`. The mandated model — *an AI Agent is a container with Overview / Knowledge / Experience / Channels / Analytics / Advanced* — **does not exist in any form.** This is the single largest gap and the backbone of the rebuild.

2. **The IA has been "tab-multiplexed" into incoherence.** At least 7 pages fold unrelated sub-pages behind `?tab=` (`Insights` = analytics+conversations+feedback; `Support` = live-chat+messages; `Integrations` = email+webhooks+meetings; `Chatbot` = bot-list **and**, via `?tab=appearance`, the entire per-bot settings editor). ~15 legacy redirect routes paper over prior reshuffles. Navigation carries **12+ items across two ad-hoc groups** vs. the mandate's **6**.

3. **Configuration is split-brained and, in one case, data-corrupting.** Bot settings live in three surfaces with real overlap. Two different "Live Chat" editors (account-level and bot-level) write **the same** `updateClientSettings` record → last-writer-wins drift. Two unrelated tabs are both named "Appearance" (dashboard theme vs. widget branding). "Bot Settings" has no route of its own — it is a hidden mode of the My Bots page.

**The good news (reuse surface is large):** a real design-token foundation exists (Tailwind v4 `@theme` "Voltage Paper" palette, Inter/Geist Mono, a `components/ui/*` primitive set), `WorkspaceContext` already models multi-tenant roles cleanly and maps 1:1 onto the mandated **Workspace** area, and every page's data-fetching is a thin wrapper over a stable `services/api.js`. **The rebuild is an IA + UX + shell reconstruction on top of a reused data/logic layer — not a backend rewrite.**

**Recommended approach:** a **strangler-fig migration** — stand up the new design system, app shell, and `/agents/:agentId/*` routing alongside the current app, then migrate surface-by-surface reusing the API/context layer, deleting legacy routes as each new destination goes live. Big-bang is rejected (too much live surface, billing/live-chat risk).

---

## PART A — AUDIT OF CURRENT STATE

### A1. Current Information Architecture

The app is a **flat, workspace-scoped route tree** with an **implicit single-bot selection** layered on top. There is no hierarchy expressing "this data belongs to *this* agent."

Two real tenancy levels exist in state, but only one is expressed in the URL:

| Level | Modeled by | Expressed in URL? | Maps to mandate |
|---|---|---|---|
| Workspace (client identity, roles, `X-Workspace-Id`) | `WorkspaceContext` | ❌ No (switcher pill only) | ✅ **Workspace** area |
| Agent / Bot (the actual product unit) | `BotContext.selectedBot` (global, localStorage) | ❌ **No** (sidebar dropdown only) | 🔴 **AI Agents** (missing) |

Everything below the workspace is a **flat list of feature routes** that each read the ambient `selectedBot`:
`/` (Dashboard) · `/build` · `/knowledge` · `/insights` · `/leads` · `/qualification` · `/integrations` · `/chatbot` · `/support` · `/team` · `/billing` · `/settings` · `/affiliate` — plus ~15 redirect aliases.

**Consequence:** the user's mental model ("I'm working on Agent X") is never reinforced by the IA. Switching agents is a global side-effect fired from a dropdown in the sidebar chrome; the URL, breadcrumbs, and page titles never change. Deep links can't target "Agent X's knowledge."

### A2. Current Navigation

Source: `layouts/Sidebar.jsx`, `layouts/AdminLayout.jsx`, `layouts/TopBar.jsx`, `components/CommandPalette.jsx`, `components/SettingsDropup.jsx`.

- **Two ad-hoc groups**, "Main" and "Configure", totaling **12+ primary items** (role/entitlement-dependent):
  - *Main:* Overview, Sources, Insights, Support, Leads, Qualification, Integrations
  - *Configure:* My Bots (with children All Bots / Bot Settings), Team, Affiliate (conditional), Billing
  - *Bottom:* Settings
- **Global bot switcher dropdown** sits in the sidebar masthead — the only way to change agent context.
- **Heavy conditional rendering:** operator vs. bot-manager vs. client vs. affiliate-only vs. free-plan produce materially different sidebars, with per-item `locked`/`lockedIntent` upsell wiring inline in the nav component.
- **"Settings" is overloaded three ways:** the `/settings` page, the `SettingsDropup` (which only opens a *feedback* modal — goes nowhere near settings), and per-bot "Bot Settings".
- A `CommandPalette` (⌘K) and a contextual `PageHeader`/`TopBar` system already exist and are reusable primitives.

**Verdict:** the nav is a symptom of the IA problem — feature-flat, not object-oriented. It mixes agent-scoped data pages, workspace tools, and account settings at one level.

### A3. Current User Flows

The product supports these primary journeys today; each is spread across multiple routes/shells:

- **Create → train → deploy an agent:** `/build` (Build Studio, 4 milestones) OR `CreateBotWizard` modal (a *second, parallel* creation path with a different mental model). See A4.
- **Manage knowledge:** `/knowledge` (upload + crawl + recrawl + source list; 1,828-line page).
- **Operate conversations:** `/support?tab=live-chat` (operator console, 2,910-line monolith) and `/support?tab=messages` (offline inbox).
- **Work leads:** `/leads` (table + detail + CSV + BANT tiers, 1,423 lines) and `/qualification` (BANT config + scorecard + funnel).
- **Understand performance:** `/insights?tab=analytics|conversations|feedback` — a shell over three unrelated pages, one of which (`Analytics`) nests *its own* second tab bar (double-nested tabs).
- **Configure the widget:** `/chatbot?tab=appearance` → `BotSettings` (7 tabs + nested Advanced).
- **Run the workspace:** `/team`, `/billing`, `/settings`, `/integrations`.

**Cross-cutting flow problem:** because "which agent" is ambient, the *same* flow means different things depending on a selection made elsewhere, with no in-page reminder of scope.

### A4. Current Onboarding Flow

Source: `pages/build/*`, `components/StudioResumeCard.jsx`, `App.jsx` `RootRedirect`.

- **Build Studio** is a deliberate, well-crafted **"prove-it-first" 4-milestone flow** (`Connect → Prove → Personalize → Go live`) on a dedicated full-screen shell, with a live widget preview and an "aha" front-loaded at **step 2 (Prove)** — the agent answers a question from the user's own crawled site in ~20–30s via a fast-path "trained on 1 page" latch.
- **Gating/resume:** forward steps lock beyond `maxReached`; furthest step persisted to `localStorage['oc_studio_resume_m']`; completion is server-derived via `me.onboarding_complete`.
- **Reused engine:** `BotContext`, `CrawlContext`, `previewChatStream` (real SSE), `PlatformSelector`, `IntegrationGuide`, `WidgetChatPreview`, and a rich `recordActivationEvent` funnel.

**Pain points / gaps vs. mandate's 8-step Launch Studio:**
- 🔴 **No "Review Knowledge" step** — the user never sees *what* was learned (pages/chunks/gaps), only a count.
- ⚠️ **Analyze / Train / Test are not separable** — all collapsed inside "Prove".
- ⚠️ **Customize is thin** — name + one accent color only; welcome message, avatar, logo, tone all punted to Settings, so the widget that goes live is mostly default-branded.
- ⚠️ **Verify is passive/merged** into Go-live; the user can finish **unverified** (widget may never actually be live).
- 🔴 **Crawl-only, no upload fallback** — JS-rendered sites (`no_content`) and site-less users hit a dead-end; a large, common failure class can't onboard at all.
- ⚠️ **Two parallel creation paths** (Studio website-first/free vs. `CreateBotWizard` name-first/paid) present inconsistent mental models.

Per mandate, this flow is a **logic/API reference only** — Launch Studio is rebuilt to the 8-step spec, but the aha-first instinct and the reused engine are keepers.

### A5. Current AI Agent Management Flow

There is **no unified agent workspace.** "Managing an agent" today means:
- **List/create/delete/rename:** `/chatbot` (the My Bots page). "Manage" swaps the whole page to `BotSettings` via `?tab=appearance` — a router-in-a-page.
- **Configure the widget:** `BotSettings` 7 tabs (General, Personality, Appearance, Messages, Behavior→Advanced, Leads, Live Chat).
- **Its knowledge, analytics, leads, conversations:** live on *global* routes that happen to reflect the selected bot.
- **Its install/embed:** `InstallDrawer` (opened from a bot card) — but embed instructions *also* appear in Dashboard quick-actions and inside Build Studio.

So a single agent's surface area is **scattered across ≥6 routes with no container, no per-agent URL, and no consistent in-page context.** This is exactly what the mandate's `AI Agents → Overview/Knowledge/Experience/Channels/Analytics/Advanced` container is meant to fix.

### A6. Current Workspace Management

This is the **healthiest area** and the closest to the mandate. `WorkspaceContext` cleanly models: one owned workspace + N invited-operator memberships, roles (owner/admin/operator), atomic switching with in-flight request abort, `X-Workspace-Id` scoping, and access-denied recovery. Workspace-level surfaces exist but are **scattered**, not consolidated:
- Members/operators/departments → `/team` (legacy "Operators/Departments" naming).
- Billing/credits/plan/seats/invoices → `/billing` (5 tabs).
- API keys → buried in `Settings → Workspace` tab (a stub of link-cards).
- Security (password/2FA) → `Settings → Security`.
- Integrations (webhooks/email/meetings) → `/integrations` (mixed agent- and workspace-level).
- Profile/notifications/theme → `Settings`.

The pieces exist; they need to be **gathered under one Workspace area** with correct scoping.

### A7. Current Settings Organization

Three overlapping surfaces, all bot-config ultimately persisting through **one fat endpoint** (`updateClientSettings(payload, botId)`):

- **A) Account/Workspace — `Settings.jsx` + `pages/settings/*`:** Profile, Security, Notifications (push), Appearance (**dashboard theme**), Live Chat, Workspace (stub), Contact.
- **B) Per-bot — `BotSettings.jsx` + `pages/bot-settings/*`:** General, Personality, Appearance (**widget branding**), Messages, Behavior (+ nested Advanced), Leads, Live Chat.
- **C) `Chatbot.jsx`** hosts B as a hidden `?tab=appearance` mode.

**Concrete defects:**
- 🔴 **Two Live Chat editors write the same record** (`live_chat_queue_timeout_seconds`, `live_chat_max_queue_size`) via the same API → guaranteed drift, no indication they're the same field.
- 🔴 **Account-level Live Chat silently depends on `selectedBot`** — a "workspace" page whose meaning changes based on a bot selected elsewhere, with no bot indicator.
- ⚠️ **Two "Appearance" tabs** (theme vs. widget) — a name collision that causes wrong clicks.
- ⚠️ **Advanced is nested inside Behavior**, making "never expose Advanced during onboarding" impossible to enforce cleanly.
- ⚠️ **`WorkspaceTab` is a dead-end** of link-cards + an orphaned API-key widget + a "config moved" apology card — a fossil of a half-finished prior migration.
- ⚠️ **Notification model is split** — browser push (account) vs. lead emails (bot Leads).

### A8. UX Pain Points (consolidated)

| # | Pain point | Where | Severity |
|---|---|---|---|
| 1 | No agent-scoped IA; agent context is an invisible global | whole app | 🔴 Critical |
| 2 | Two Live Chat editors corrupt the same record | Settings + BotSettings | 🔴 Critical |
| 3 | Onboarding dead-ends on JS-rendered/site-less accounts; no upload fallback | Build Studio | 🔴 Critical |
| 4 | "Bot Settings" has no route; reached by hijacking My Bots | Chatbot | 🟠 High |
| 5 | Tab-multiplexing hides pages 2–3 levels deep (page→shell→tab, sometimes double-nested) | Insights, Support, Integrations, Analytics | 🟠 High |
| 6 | Dashboard does 4+ jobs and duplicates Analytics | Dashboard | 🟠 High |
| 7 | Technical jargon exposed to users (BANT/MEDDIC weights, HMAC, relevance_threshold, credit-ledger types) | Qualification, Webhooks, Advanced, Billing | 🟠 High |
| 8 | Terminology drift: Bot/Agent, Sources/Knowledge, Insights/Analytics, Support/Inbox, Operators/Members, Appearance×2 | whole app | 🟠 High |
| 9 | 12+ nav items in two ad-hoc groups; complex role/lock conditionals inline in nav | Sidebar | 🟡 Medium |
| 10 | Monolith pages (LiveChat 2,910 · KnowledgeBase 1,828 · Billing 1,489 · Leads 1,423) | multiple | 🟡 Medium (eng) |
| 11 | Install/embed instructions duplicated in 3+ places | InstallDrawer, Dashboard, Studio, Chatbot | 🟡 Medium |
| 12 | No "review what the AI learned" surface post-training | Knowledge/Onboarding | 🟡 Medium |

### A9. Duplicate Flows (explicit inventory)

- **Install/embed:** `InstallDrawer` + `Dashboard` quick-actions + `Chatbot` + Build Studio Go-live (demo-link copy + `trackDemoShareClick` duplicated in 3 files).
- **Analytics:** `Dashboard` and `Analytics` both render Top Questions, lead funnel/BANT pie, stat cards from overlapping APIs.
- **Lead data:** `Leads` + `Analytics` leads tab + `Qualification` funnel + `Dashboard` funnel — four surfaces over `getLeadStats`.
- **Feedback + offline messages:** shown in `Dashboard` activity feed **and** their dedicated pages.
- **Bot config split-brain:** `BotSettings` (notification emails, meeting toggle) vs. `Integrations` (writes the same via `updateBot`); meeting toggle mirrored read-only into the BotSettings draft.
- **Quick replies / canned responses:** standalone `CannedResponses` + embedded in `TeamManagement` + old `/canned-responses` redirect.
- **Two creation paths:** Build Studio vs. `CreateBotWizard`.
- **Two "Settings":** `Settings` (workspace) vs. `BotSettings` (per-bot).

### A10. Technical Constraints (what bounds the rebuild)

1. **Reuse mandate is hard:** backend APIs, DB models, auth (`X-API-Key`/`X-Bot-Key`/`X-Operator-Key`/`X-Workspace-Id`), and business logic must not break. The rebuild is UI/IA-only.
2. **`selectedBot` is a global singleton in localStorage.** Introducing `/agents/:agentId/*` means deriving agent scope from the **URL** and refactoring `BotContext` into a URL-aware `AgentContext` **without** breaking the many pages that read `selectedBot` today (compatibility shim required during migration).
3. **`X-Workspace-Id` axios interceptor + abort-on-switch** is load-bearing — the new shell must preserve workspace switching semantics and the `oyechats:workspace-switched` event contract.
4. **Deep provider tree (11 contexts)** — `Workspace → Notification → Bot → Push → PageHeader` plus app-level `Toast → Confirm → UpgradeModal → Currency → Crawl`. New shell must re-host these; order matters (Bot reads Workspace; Crawl/Currency are route-scoped).
5. **JS stack, not TS** — 692 documented arbitrary `text-[Npx]` literals; no typecheck gate. Mandate wants TS-grade rigor → **incremental TypeScript adoption** for new code (design system + shell first).
6. **Role/entitlement gating is pervasive** — operator vs. client vs. free-plan branching and `requestUpgrade` upsell wiring must be re-expressed as a clean, centralized policy layer, not inline `if`s in nav/pages.
7. **Real-time/live-chat WebSocket + push service-worker deep-links** land on `/support?...` — new Inbox routes must preserve or redirect these targets (SW posts `target_path`).
8. **CommandPalette, PageHeader, TrialBanner, Verify/Push banners, WorkspaceAccessDenied modal** are cross-cutting shell citizens to carry forward.
9. **Vite 8 SPA on Vercel** — client-side routing; SSR not in play. Code-splitting is currently minimal (monolith pages) → a rebuild opportunity, not a constraint.

---

## PART B — GAP ANALYSIS: CURRENT vs. VISION

| Mandate requirement | Current reality | Gap size |
|---|---|---|
| 6-item sidebar (Home, AI Agents, Inbox, Leads, Analytics, Workspace) | 12+ items, two groups, global bot switcher | 🔴 Large |
| AI Agent = container (Overview/Knowledge/Experience/Channels/Analytics/Advanced) | No container; scattered across ≥6 flat routes; no per-agent URL | 🔴 Large |
| Each page answers exactly one question | Multiple pages do 3–5 jobs; `?tab=` multiplexing; double-nested tabs | 🔴 Large |
| Launch Studio = temporary 8-step onboarding, then gone | 4-milestone Build Studio (good instincts) missing Review-Knowledge & explicit Verify; crawl-only | 🟠 Medium |
| Workspace area = Members/Billing/Usage/Security/API Keys/Integrations/Settings | Pieces exist but scattered across Team/Billing/Settings/Integrations | 🟠 Medium |
| No agent config in Workspace; no standalone Settings | `Settings` mixes account + (bot-scoped!) live-chat; agent config in 3 places | 🟠 Medium |
| Shared design system (11 named components) | Token foundation + `ui/*` primitives exist; composite components (Insight/Action/Agent/Conversation cards, Stepper, Timeline) mostly absent; 692 arbitrary literals | 🟡 Medium |
| Premium/minimal visual language; avoid purple overload | Volt-violet-heavy brand, gradients on switcher/feedback tab — tension with "avoid purple overload" | 🟡 Medium |
| Progressive disclosure; hide Advanced | Advanced nested in Behavior; jargon exposed throughout | 🟡 Medium |
| Type-safe, modular, no tech debt | JS, no typecheck, 4 monolith pages >1,400 lines | 🟡 Medium (eng) |

---

## PART C — THE PROPOSAL

### C1. New Navigation Hierarchy

**Exactly six primary destinations** (the mandate's sidebar), with the agent as a first-class object:

```
🏠  Home              /                      "How is my business doing today?"
🤖  AI Agents         /agents                index → /agents/:id/overview
💬  Inbox             /inbox                 live chat + offline messages (Operations)
👥  Leads             /leads                 captured leads + qualification funnel
📊  Analytics         /analytics             cross-agent performance
⚙   Workspace        /workspace             members, billing, usage, security, keys, integrations, settings
```

- **Agent context is a URL, not a global.** Inside an agent, a compact **agent switcher** in the sub-header (not the global sidebar) changes `:agentId`. Home/Inbox/Leads/Analytics can offer an "All agents / filter by agent" control where meaningful, but their canonical scope is workspace-wide.
- **Launch Studio is NOT in the sidebar.** It's a full-screen route (`/launch` or `/agents/:id/launch`) entered on first-run and exited to Home on completion.
- **Account/user settings** (theme, profile, notifications) move to a **user menu** in the top bar — not a sidebar item, not mixed into Workspace.
- **Upsell/lock state** becomes a centralized `useEntitlements`-driven policy consulted by a `<Gate>` component, not inline branching in the nav.

### C2. New Routing Structure

```
/                                   Home (workspace overview)
/launch                             Launch Studio (full-screen, no shell chrome)  ← replaces /build
/launch/:step                       (connect|analyze|train|review|test|customize|deploy|verify)

/agents                             AI Agents index (agent cards + Create)
/agents/:agentId                    → redirect to overview
/agents/:agentId/overview           "Is my AI healthy?"
/agents/:agentId/knowledge          "What does my AI know?"      (sources, upload, crawl, review)
/agents/:agentId/experience         "What will visitors see?"    (branding, messages, personality, preview)
/agents/:agentId/channels           "Where is my AI connected?"  (website/install, WhatsApp, Messenger, API, meetings)
/agents/:agentId/analytics          "How is my AI performing?"
/agents/:agentId/advanced           "Technical behaviour"        (RAG scope, timeouts, webhooks, feature flags)

/inbox                              Operations: conversations
/inbox/:conversationId              conversation detail (live or offline)
/leads                              Operations: leads
/leads/:leadId                      lead detail (BANT tier, transcript)
/analytics                          Operations: cross-agent analytics

/workspace                          → redirect to /workspace/members
/workspace/members                  team (owners/admins/operators/departments)
/workspace/billing                  plan, seats, invoices, payment methods
/workspace/usage                    credits ledger, consumption
/workspace/security                 password, 2FA, sessions
/workspace/api-keys                 client API key(s)
/workspace/integrations             webhooks, meeting providers, email routing (workspace-level)
/workspace/settings                 workspace name, business-hours default, branding footer

(top-bar user menu, not sidebar)
/account/profile · /account/notifications · /account/appearance(theme)

/affiliate                          (conditional, unchanged behavior)
```

**Legacy redirects:** every current route + `?tab=` alias maps forward (e.g. `/chatbot?tab=appearance → /agents/:id/experience`, `/insights?tab=analytics → /analytics`, `/support?tab=live-chat → /inbox`, `/build → /launch`, `/settings → /account/profile` or `/workspace/*`). SW push `target_path` values remapped to `/inbox?...`.

### C3. New Folder Structure

Reorganize `src/` **by feature domain**, with a shared design system and a thin app shell. (Reused files move; they are not rewritten wholesale.)

```
src/
  app/
    App.tsx                      route tree only
    router.tsx                   route definitions + lazy() code-splitting
    providers.tsx                the provider tree (Workspace→…→Crawl), one place
  shell/
    AppShell.tsx                 sidebar + topbar + content outlet (replaces AdminLayout)
    Sidebar.tsx                  6 items, data-driven from nav config
    TopBar.tsx                   agent/workspace context, user menu, ⌘K, banners
    nav.config.ts                single source of nav truth (icon, label, route, gate)
    CommandPalette.tsx
  design-system/                 THE shared system (see C4)
    primitives/                  Button, Input, Select, Dialog, Drawer, Tabs, Badge, Card…
    components/                   SectionHeader, MetricCard, InsightCard, StatusBadge,
                                  ActionCard, ProgressStepper, KnowledgeSourceCard,
                                  ConversationCard, AgentCard, QuickAction, ActivityTimeline
    tokens.css                   @theme (migrated, de-purpled, literals codemodded)
    index.ts
  features/
    home/                        Home dashboard (workspace overview)
    launch-studio/               8 steps, each a component; reuses crawl/preview engine
      steps/ (Connect, Analyze, Train, Review, Test, Customize, Deploy, Verify)
    agents/
      AgentsIndex.tsx            list + create
      AgentLayout.tsx            per-agent shell: header + 6 tabs + agent switcher
      overview/ knowledge/ experience/ channels/ analytics/ advanced/
    inbox/                       live chat console + offline messages, split from monoliths
    leads/                       leads table/detail + qualification funnel
    analytics/                   cross-agent analytics
    workspace/                   members, billing, usage, security, api-keys, integrations, settings
    account/                     profile, notifications, appearance(theme)
    auth/                        login, register, verify, oauth, invites (unchanged logic)
  contexts/                      Workspace, Agent(new, URL-aware), Notification, Push,
                                 Crawl, Currency, Toast, Confirm, UpgradeModal, PageHeader
  hooks/                         useEntitlements, useInstallPrompt, useAgent(:id), …
  services/                      api.ts (reused verbatim), ws, push
  lib/                           utils, currency, countries, razorpay
```

Migration is a **move + re-slice**, not a rewrite: `KnowledgeBase.jsx` → `features/agents/knowledge/*` (broken into upload / crawl / source-list / **review** sub-components); `LiveChat.jsx` (2,910 lines) → `features/inbox/*` decomposed; `BotSettings` tabs redistributed across Experience/Channels/Advanced.

### C4. New Component Architecture (the Design System)

**Principle:** one shared system; pages compose it; page-specific components only when unavoidable.

- **Layer 1 — Tokens** (`design-system/tokens.css`): migrate the existing `@theme` Voltage-Paper palette; **codemod the 692 `text-[Npx]` literals** onto named rungs; **reduce purple saturation** in chrome (per "avoid purple overload") — keep volt-violet as *accent*, not surface. Add semantic tokens (`--surface-raised`, `--border-subtle`, `--text-muted`) so light/dark and density are systematic.
- **Layer 2 — Primitives** (mostly exist in `ui/*`, promote + type them): Button, Input, Select, Textarea, Toggle, Checkbox, Dialog, Drawer, Tabs, Badge, Card, Avatar, Progress, Skeleton, Tooltip, DataTable, EmptyState, Toast.
- **Layer 3 — Mandated composites** (the 11 named in `app/CLAUDE.md`; build these once):
  `SectionHeader` · `MetricCard` (evolve `StatCard`) · `InsightCard` · `StatusBadge` (evolve `Badge`) · `ActionCard` · `ProgressStepper` (extract from Build Studio) · `KnowledgeSourceCard` · `ConversationCard` · `AgentCard` · `QuickAction` · `ActivityTimeline`.
- **Layer 4 — Feature components:** compose Layer 2–3 only.
- **Governance:** a lightweight `design-system/README` + Storybook-style preview route; new code may not use arbitrary px literals or raw hex; `any` is disallowed in DS/shell TS.

### C5. New Feature Organization (where each current surface lands)

| Current surface | New home | Notes |
|---|---|---|
| `Dashboard` (global) | `features/home` + `agents/overview` | Split: workspace Home vs. per-agent Overview. Kill Analytics duplication. |
| `build/*` (Build Studio) | `features/launch-studio` | Rebuild to 8 steps; **add Review Knowledge + explicit Verify + upload fallback**; reuse crawl/preview engine. |
| `Chatbot` (My Bots list) | `agents/AgentsIndex` | Just the list + create. No hidden settings mode. |
| `CreateBotWizard` | `agents` create flow | Unify with Launch Studio entry; one mental model. |
| `KnowledgeBase` | `agents/:id/knowledge` | Decompose; add "what was learned" review. |
| `BotSettings` General/Personality/Appearance/Messages | `agents/:id/experience` | The visitor-facing surface, with live preview. |
| `BotSettings` Behavior/Advanced + `relevance_threshold` | `agents/:id/advanced` | Un-nest Advanced to top level; progressive disclosure; plain-language. |
| `InstallDrawer` + `Integrations` (meetings/email) + `Webhooks` | `agents/:id/channels` (+ workspace/integrations for workspace-level) | "Where is my AI connected?"; per-channel cards (Website/WhatsApp/Messenger/API). |
| `Analytics` (per-bot) | `agents/:id/analytics` | Single, un-nested. |
| `Insights` shell | dissolve | `analytics`→Analytics; `conversations`→Inbox; `feedback`→Inbox/Analytics. |
| `Support`/`LiveChat`/`OfflineMessages` | `features/inbox` | One Inbox; decompose the 2,910-line console. |
| `CannedResponses` | `inbox` (macros) | Agent-side quick replies live with the console, not Team. |
| `Leads` + `Qualification` funnel/scorecard | `features/leads` | Merge; hide BANT jargon behind plain "Lead quality". |
| `Qualification` Configuration tab | `agents/:id/advanced` (or Leads settings) | It's config, not an operational view. |
| `TeamManagement` | `workspace/members` | Rename Operators→Members where user-facing. |
| `Billing` (5 tabs) | `workspace/billing` + `workspace/usage` | Split plan/seats/invoices from credit-ledger/usage. |
| `Settings` Security/Workspace/API-key | `workspace/security` · `workspace/settings` · `workspace/api-keys` | Correct scoping. |
| `Settings` LiveChat (bot-scoped!) | `agents/:id/channels` | **Fix the split-brain**: one Live Chat editor, agent-scoped. |
| `Settings` Profile/Notifications/Appearance(theme) | `account/*` (top-bar user menu) | Personal, not workspace. |
| `SettingsDropup` (feedback) | top-bar Help/Feedback menu | Rename; stop calling it "Settings". |

### C6. Migration Strategy (strangler-fig, phased to the mandate)

**Guiding rules:** never break auth/APIs; migrate behind the reused data layer; delete a legacy route only when its replacement is live; keep `selectedBot` working via a shim until agent-scoped routing is proven.

**Phase 1 — Foundations (Design System · Shell · Routing · Agent context).**
- Stand up `design-system/` (tokens migrated + de-purpled, primitives promoted to TS, the 11 composites built, literal codemod).
- Build `AppShell` + 6-item data-driven `Sidebar` + `TopBar` user menu + centralized `<Gate>` entitlement policy.
- Introduce **`AgentContext`** that reads `:agentId` from the URL and exposes the agent; refactor `BotContext` to delegate to it, with a compatibility shim so existing `selectedBot` readers keep working during migration.
- New `router.tsx` with the full route tree + **all legacy redirects** wired from day one (so nothing 404s).
- *Exit criteria:* new shell renders, ⌘K/banners/workspace-switch intact, one throwaway demo page proves agent-scoped routing.

**Phase 2 — Launch Studio.** Rebuild to 8 steps; add the missing **Review Knowledge** + explicit **Verify Installation** + **document-upload fallback**; reuse crawl/preview/activation engine; redirect `/build → /launch`.

**Phase 3 — Home.** Split global Dashboard into workspace **Home** (recommended actions, cross-agent health, activity) and remove Analytics duplication.

**Phase 4 — AI Agent container (the core).** Ship `AgentLayout` + the six tabs in order (Overview → Knowledge → Experience → Channels → Analytics → Advanced), migrating and decomposing `KnowledgeBase`, `BotSettings`, `Analytics`, install/integrations. Retire `/chatbot?tab=appearance`. **Resolve the Live Chat split-brain here.**

**Phase 5 — Operations + Workspace.** Build `Inbox` (decompose LiveChat monolith), `Leads` (merge Qualification funnel), cross-agent `Analytics`; consolidate `Workspace/*` (members/billing/usage/security/api-keys/integrations/settings) and move personal settings to `account/*`.

**Phase 6 — Polish.** Accessibility (WCAG 2.2), performance (route-level code-splitting now that pages are decomposed), motion consistency, empty/loading/error states, final terminology sweep (Bot→Agent, Operators→Members, kill "Appearance×2").

**Sequencing note:** Phases 3–5 each go live behind the Phase-1 shell; legacy routes are deleted per-surface as replacements ship. Each phase follows the mandate's per-screen 8-step process (Analyze → Explain → Design → IA → Components → Implement → Self-review → Refactor) and passes the pre-completion checks (`lint`/`build`).

---

## Decisions (LOCKED 2026-07-21)

1. ✅ **Agent-scoping model** — **URL-scoped `/agents/:agentId/*`** with a URL-derived `AgentContext`. `BotContext` delegates to it behind a compatibility shim so existing `selectedBot` readers keep working during migration. *(Backbone decision — everything downstream builds on this.)*
2. ✅ **TypeScript adoption** — **incremental TS for new code**: design system + shell + all new features are TypeScript; legacy JS is converted per-surface as each is migrated. `any` disallowed in DS/shell.
3. ✅ **Migration cadence** — **strangler-fig behind the same running app** (recommended default; not the parallel `/v2` prefix). Legacy routes deleted per-surface as replacements ship.
4. ✅ **Brand intensity** — **volt-violet as accent only**: primary actions, active states, and brand moments stay violet; surfaces/nav/chrome go warm-neutral (paper/ink). Codemod dials back the violet-heavy chrome.
5. ✅ **Multi-channel scope** — Channels renders WhatsApp/Messenger/API as **visible "coming soon" channel cards** (disabled state); only Website is functional today.

---

*End of Phase-0 deliverable. Decisions above are locked.*

---

## Implementation Log

### Phase 1 — Foundation ✅ SHIPPED (2026-07-21)

Application foundation built in **incremental TypeScript**, coexisting with the legacy app via strangler-fig (legacy `App.jsx` + pages untouched on disk; `main.jsx` now boots the new root). **No pages built** — every route renders a placeholder Page Container.

**Toolchain:** added `typescript` + `typescript-eslint` + `tsconfig.json` (typechecks new `.ts/.tsx` only; legacy `.jsx` excluded); ESLint extended with a TS block (react-refresh scoped to `.tsx`); added `typecheck` script.

**Delivered (`app/src/`):**
- `design-system/tokens.css` — semantic token layer, volt-violet as **accent only**, warm-neutral chrome, full light/dark.
- `design-system/theme/` — `ThemeProvider` (light/dark/system via `useSyncExternalStore`) + `useTheme`.
- `design-system/primitives/` — `Button`, `Card` (+ Header/Title/Content/Footer), `StatusBadge`, `Skeleton`.
- `design-system/components/` — `PageContainer`, `SectionHeader`, `EmptyState`, `Breadcrumbs` + `lib/cn` + barrel `index.ts`.
- `shell/` — `AppShell` (responsive global layout), `Sidebar` (the 6-item nav, icon-collapsible/mobile-drawer), `TopBar` (breadcrumbs + ⌘K + theme + notifications + account), `nav.config.ts` (single nav source of truth), `useBreadcrumbs` (route-handle-driven), `CommandPalette` (placeholder), `NotificationCenter` (placeholder).
- `app/` — `routes.tsx` (full IA: `/`, `/agents/:agentId/{overview,knowledge,experience,channels,analytics,advanced}`, `/inbox`, `/leads`, `/analytics`, `/workspace/{members,billing,usage,security,api-keys,integrations,settings}`, `/launch`), `App.tsx` (root), `PagePlaceholder`.

**Checks:** `tsc --noEmit` ✓ · `eslint .` ✓ (0 errors) · `vite build` ✓ (2,113 modules). **Browser-verified:** shell/sidebar/topbar render, deep-route breadcrumbs (Home › AI Agents › Agent › Knowledge), active-state, and command palette all work; zero app-level console errors.

**Deferred to later phases (intentionally):** auth-gating + data contexts (Workspace/Agent/Notifications) wired when pages arrive; `AgentContext` (URL-param) lands with Phase 4 agent pages; token codemod of the 692 legacy `text-[Npx]` literals; account-menu dropdown.

### Phase 2a — Launch Studio structure ✅ SHIPPED (2026-07-21)

Full-screen 8-step onboarding replacing legacy `/build`. UX scaffolded and fully navigable; **backend wiring deferred to Phase 2b** (seams marked `TODO(phase-2b)`).

- **New shared components:** `ProgressStepper` (mandated), `Input` + `Progress` primitives.
- **`features/launch-studio/`:** `LaunchStudioLayout` (full-screen shell outside app chrome — step rail · content · live-preview panel), `StepShell` (shared step chrome + Back/Continue), `LaunchStudio` (URL-driven state machine: forward-gating, resume via `localStorage`, finish → `/`), `steps.config`, and 8 step scaffolds.
- **Mandate gaps closed:** **Review Knowledge** is now its own step (legacy had none); **Verify Installation** is standalone (legacy merged it into deploy); Connect includes a **document-upload fallback** (legacy was crawl-only).
- **Routing:** `/launch → /launch/connect`, `/launch/:step → LaunchStudio`.
- **Checks:** tsc ✓ · eslint ✓ (0 errors) · build ✓. **Browser-verified:** stepper done/current/locked states, forward-gating, step advance (Connect→Analyze), zero console errors.

**Phase 2b (next):** wire the engine — createBot/updateBot, `CrawlContext` discovery+training, `getDocuments` for Review, `getSeedQuestions`+`previewChatStream` for Test (live preview panel), real embed snippet, `widget_installed_at` polling for Verify, `completeOnboarding` on finish. Requires standing up the auth + data-context layer.

---

## Reconciliation with Master Execution Plan (2026-07-21)

Cross-checked the shipped work against the user's master execution plan. Gaps found and how they're addressed:

### G1 — ⚪ WAIVED by user (2026-07-21)
Master plan Session 2 said *"the old application should continue functioning while the new shell is introduced."* User decided to **keep the new shell as the boot default** and explicitly waived this requirement. `main.jsx` stays pointed at the new root; legacy `App.jsx` + pages remain on disk (for per-surface migration) but are not runtime-mounted in this working copy. No coexistence flag needed.

### G2 — ✅ RESOLVED (2026-07-21) — Launch Studio now 9 steps
Adopted the master plan's flow: **Welcome · Create Agent · Connect Website · AI Training · Knowledge Review · Test Agent · Customize Widget · Deploy · Verification**. Added `WelcomeStep` + `CreateAgentStep`; folded website analysis into `TrainStep`; removed the standalone `AnalyzeStep`; updated `steps.config`, the container map, and the `/launch` index redirect (`→ welcome`). Checks green (tsc/eslint/build).

### G3 — ✅ ADOPTED (2026-07-21) — Code Reviewer gate
Standing process change: **every phase ends with a Code Reviewer subagent pass** (correctness · type-safety · accessibility · consistency · performance · CLAUDE.md compliance) before commit. Retro-active review of Phase 1 + 2a run via two parallel reviewer subagents; findings triaged and fixed.

### G4 — 🟡 Separate governance docs
Master structure lists `PRODUCT_VISION.md`, `UX_PRINCIPLES.md`, `REBUILD_ROADMAP.md`. Currently consolidated into `app/CLAUDE.md` + this doc. **Optional:** split into the named files if the user prefers that layout.

### G5 — 🟡 "Working Rules" verbatim
Content is integrated into `app/CLAUDE.md` (paraphrased). **Optional:** mirror the verbatim block.

**Standing process change:** every phase now ends with a Code Reviewer subagent pass (G3) before commit.
