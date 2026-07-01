# Design: My Bots Redesign

**Date:** 2026-06-30
**Status:** Approved (design)
**App:** `oye-chats-platform/app`
**Sub-project:** 3 of 3 in the Configure-area IA redesign (after Settings and Bot Settings editor)

## Context

`Chatbot.jsx` (704 lines) is the "My Bots" surface and does three unrelated jobs in one file: the **bot list**, the **create wizard** (2-step, Razorpay), and a heavy inline **embed/install accordion** (~516 lines of composed UI: Bot Key, Preview & Share, `DomainRestrictions` 281L, `PlatformSelector`→`IntegrationGuide` 235L). It also hosts the `?tab=appearance` → Bot Settings redirect (from SP2).

Two UX problems: (1) the install UI is crammed into an accordion row; (2) the "active bot" is switchable **two ways** — the sidebar dropdown *and* a per-card "Set Active" button — which is redundant.

**Frontend-only.** All flows use existing APIs (`createBot`, `createBotCheckout`/`verifyBotCheckout`, `crawlWebsite`, `deleteBot`, `updateBot`, domain/embed components, `/subscriptions/geo` + plan USD columns). The global active-bot model (BotContext `selectedBot`, used app-wide by Insights/Leads/Knowledge/Support/Bot Settings) is **out of scope** — we only remove the card-level redundancy.

## Goal

Rebuild My Bots as a clean, componentized list where a card is the manage affordance, install lives in a dedicated slide-over, and the create wizard is restyled with USD (geo) pricing.

## Decisions (approved)

1. **Componentize** `Chatbot.jsx` → thin page shell + `pages/my-bots/{BotCard,CreateBotWizard,InstallDrawer}.jsx`. Keep the SP2 `?tab=appearance` → `<BotSettings/>` branch in the shell.
2. **Card = manage:** clicking a card **sets it active AND opens Bot Settings** (`/chatbot?tab=appearance`). Clear **Active** badge on the active bot. Right-aligned: an explicit **Install** button (opens the slide-over) + a **⋯ actions menu** (View Demo, Copy Demo Link, Rename, Delete). Inline rename preserved. Remove the per-card **"Set Active"** button (card-click sets active; sidebar dropdown remains the explicit switcher).
3. **Install slide-over** (`InstallDrawer.jsx`): right-side drawer opened per bot; contains Bot Key (show/copy), Preview & Share (View Demo + Copy Link), `DomainRestrictions`, and the Platform Integration Guide (`PlatformSelector`→`IntegrationGuide`) — reused as-is.
4. **Create wizard** (`CreateBotWizard.jsx`): restyled, **2-step logic kept** (details → plan+Razorpay; free-first-bot one-screen), componentized, prices shown in **USD via the geo display rule** (`/subscriptions/geo` `display_currency` + `monthly_price_usd_cents`/`annual_price_usd_cents`, mirroring `PlanModal`) instead of raw `₹ plan.currency`.

## UX requirements (senior UI/UX)

- **Slide-over:** focus-trapped, `Esc` to close, backdrop click to close, body scroll-lock while open, mobile = full-screen sheet, `role="dialog"` + `aria-modal` + labelled heading; content lazy-mounted (only when open). Smooth enter/leave transition consistent with existing modals.
- **⋯ menu:** accessible (button `aria-haspopup`/`aria-expanded`, `role="menu"`/`menuitem`, click-outside + `Esc` to dismiss, keyboard navigable); destructive Delete separated with a confirm step (keep the existing two-tap confirm pattern).
- **Card:** whole card is a button/link with visible focus ring + hover state; inner interactive controls (Install, ⋯, rename input) `stopPropagation`. Active state is unambiguous (badge + subtle ring). Keyboard-activatable (Enter/Space).
- **States:** preserve/upgrade loading (skeleton over spinner), empty (`EmptyState` + Create CTA), and error (retry) states already present.
- **Create wizard:** clear step indicator, disabled-until-valid CTAs, currency shown as `$` for international (geo), the free-first-bot messaging intact, Razorpay-dismiss handled gracefully.
- Match the app's Tailwind tokens (`surface-*`, `primary-*`) and dark-mode; no layout shift; respect `isBotManager` gating (viewers see read-only).

## Engineering requirements (CTO)

- **Clear boundaries:** the shell owns data (bots list, create/delete orchestration, which drawer is open). `BotCard` is presentational + emits intents (`onManage`, `onInstall`, `onRename`, `onDelete`, `onDemo`). `InstallDrawer` receives `{ bot, open, onClose }`. `CreateBotWizard` receives `{ open, isFirstBot, onClose, onCreated }` and owns its own step/checkout state.
- **No behavior regressions:** create (free + paid/Razorpay + crawl-on-create), delete, rename, set-active, demo/preview, domain restrictions, embed guide all keep working. `?create=true` deep-link + `?tab=appearance` redirect preserved.
- **No prop-drilling of global state:** consume `useBotContext()` where needed; don't thread `selectedBot` through many layers.
- **Reuse, don't rewrite:** `DomainRestrictions`, `PlatformSelector`, `IntegrationGuide`, `EmptyState`, `PageHeader` reused unchanged.
- **Incremental & safe:** extract one component at a time, `npm run build` green after each, commit per step; the page never breaks mid-refactor.
- **No new dependencies; no react-query.** No backend/migration.

## File structure

```
app/src/pages/Chatbot.jsx                 # thin shell (list + orchestration + ?tab redirect)
app/src/pages/my-bots/
  BotCard.jsx            # one bot row: identity, active badge, rename, Install btn, ⋯ menu
  CreateBotWizard.jsx    # 2-step create modal (USD pricing, Razorpay)
  InstallDrawer.jsx      # slide-over: key, preview/share, domains, integration guide
  useBotPricing.js       # (optional) geo + USD price helper for the wizard
```
(`DomainRestrictions.jsx`, `PlatformSelector.jsx`, `IntegrationGuide.jsx` remain in `components/`, composed by `InstallDrawer`.)

## Testing

- Frontend gate: `npm run lint` + `npm run build`.
- Manual smoke: list renders; card-click sets active + opens Bot Settings; Install opens the slide-over (focus trap, Esc/backdrop close, mobile sheet) with working key copy / demo / domains / integration guide; ⋯ menu (demo, rename, delete-with-confirm); create wizard both paths (free first bot; paid via Razorpay incl. dismiss) with USD prices; `?create=true` and `?tab=appearance` deep-links.

## Rollout / non-goals

- All on `development`; normal deploy; no backend.
- Non-goals: re-architecting the global active-bot model; changing the bot editor (SP2) or billing backend.
