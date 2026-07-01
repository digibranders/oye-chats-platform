# My Bots Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the 704-line `Chatbot.jsx` "My Bots" surface into a thin shell + focused components (`BotCard`, `CreateBotWizard`, `InstallDrawer`), with card-as-manage interaction, a dedicated install slide-over, and USD (geo) pricing — no behavior regressions, no backend.

**Architecture:** Incremental extraction — pull each unit out of `Chatbot.jsx` behind stable prop contracts, `npm run build` green + commit after every task, so the page never breaks. The shell owns data + orchestration; children are presentational and emit intents.

**Tech Stack:** React 19 · Vite · Tailwind. No JS unit-test runner → each task verifies with `npm run lint` + `npm run build` + the documented manual smoke. NO react-query, NO new deps, NO backend/migration.

**Spec:** `docs/superpowers/specs/2026-06-30-my-bots-redesign-design.md`

## Component contracts (read first)

```
// Shell (Chatbot.jsx) owns: bots list (useBotContext), create-open + which InstallDrawer bot is open,
// delete/rename orchestration, ?create= and ?tab=appearance handling.
<BotCard
  bot            // bot object
  isActive       // selectedBot?.id === bot.id
  isBotManager
  onManage       // (bot) => set active + navigate to /chatbot?tab=appearance
  onInstall      // (bot) => open InstallDrawer for this bot
  onRename       // (bot, name) => updateBot + refresh
  onDelete       // (bot) => deleteBot + refresh (card keeps the 2-tap confirm)
  onDemo         // (bot) => copy demo link + trackDemoShareClick
/>
<InstallDrawer bot={bot|null} open onClose />          // slide-over; lazy content
<CreateBotWizard open isFirstBot onClose onCreated />  // owns step + checkout state
```

UX invariants (apply throughout): match `surface-*`/`primary-*` tokens + dark mode; visible focus rings; `isBotManager` gates mutating controls; no layout shift; existing loading/empty/error states preserved.

---

## Task 1: Scaffold + move nothing (safety net)

**Files:** create dir `app/src/pages/my-bots/`

- [ ] **Step 1:** `mkdir -p app/src/pages/my-bots` and create a `.gitkeep` (or wait for Task 2 to create the first file).
- [ ] **Step 2:** `cd app && npm run build` → ✓ (no-op).
- [ ] **Step 3:** `git add -A && git commit -m "chore(app): scaffold pages/my-bots"`

---

## Task 2: Extract `InstallDrawer` (slide-over) — highest-value UX change

**Files:**
- Create: `app/src/pages/my-bots/InstallDrawer.jsx`
- Modify: `app/src/pages/Chatbot.jsx` (replace the inline accordion with a shell-level drawer opened by the existing Embed button)

- [ ] **Step 1:** Create the drawer. Move the accordion's contents (Bot Key show/copy, Preview & Share [View Demo + Copy Link], `<DomainRestrictions/>`, `<PlatformSelector/>`→`<IntegrationGuide/>`) into it verbatim, rewired to a single `bot` prop + local state (`showKey`, `selectedPlatform`, `embedTab`). Implement it as an accessible right slide-over:

```jsx
// app/src/pages/my-bots/InstallDrawer.jsx (skeleton — fill body from the old accordion)
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export default function InstallDrawer({ bot, open, onClose }) {
  const panelRef = useRef(null);
  // Esc to close + body scroll-lock while open
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);

  if (!open || !bot) return null;             // lazy content: nothing mounted when closed
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={`Install ${bot.name}`}>
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="absolute right-0 top-0 h-full w-full sm:max-w-lg bg-white dark:bg-surface-900 shadow-xl border-l border-surface-200 dark:border-surface-700 overflow-y-auto outline-none animate-slide-in-right"
      >
        <div className="sticky top-0 bg-white/95 dark:bg-surface-900/95 backdrop-blur px-5 py-4 border-b border-surface-100 dark:border-surface-800 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-surface-900 dark:text-surface-50">Install “{bot.name}”</h2>
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-surface-400 hover:text-surface-700 dark:hover:text-surface-200 hover:bg-surface-100 dark:hover:bg-surface-800"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-5">
          {/* Bot Key · Preview & Share · DomainRestrictions · PlatformSelector/IntegrationGuide — moved from Chatbot.jsx */}
        </div>
      </div>
    </div>
  );
}
```

> If `animate-slide-in-right` isn't already in the app's CSS/tailwind config, use an existing enter animation class (grep `animate-` usages) or a simple `transition` on `translate-x`; don't add new global CSS unless trivial.

- [ ] **Step 2:** In `Chatbot.jsx`, add shell state `const [installBot, setInstallBot] = useState(null)`, change the card's Embed button to `onClick={() => setInstallBot(bot)}`, delete the inline `{isExpanded && (...accordion...)}` block and the `expandedBot` state, and render `<InstallDrawer bot={installBot} open={!!installBot} onClose={() => setInstallBot(null)} />` once at the shell root. Move the copy/showKey/platform/embedTab state + helpers used only by the accordion into the drawer.
- [ ] **Step 3:** `cd app && npm run build && npm run lint` → ✓. Manual: Embed button opens the slide-over; Esc + backdrop close it; body doesn't scroll behind; key copy / demo / domains / integration guide all work; mobile = full-screen.
- [ ] **Step 4:** `git commit -m "feat(app): extract InstallDrawer slide-over for bot embed/install"`

---

## Task 3: USD (geo) pricing helper + apply to the create flow currency

**Files:**
- Create: `app/src/pages/my-bots/useBotPricing.js`
- Modify: `app/src/pages/Chatbot.jsx` (currency for the plan cards) — will move into the wizard in Task 4.

- [ ] **Step 1:** Create a small hook mirroring `PlanModal`'s rule (prefer stored USD column, else geo-convert; INR only for country IN). Fetch geo once.

```js
// app/src/pages/my-bots/useBotPricing.js
import { useEffect, useState } from 'react';
import { getBillingGeo } from '../../services/api'; // existing /subscriptions/geo helper; confirm the export name

export function useBotPricing() {
  const [geo, setGeo] = useState(null);
  useEffect(() => { getBillingGeo().then(setGeo).catch(() => setGeo(null)); }, []);
  // monthly-equivalent minor units + symbol for a plan on a cycle
  const price = (plan, cycle) => {
    const display = (geo?.display_currency || 'USD').toUpperCase();
    if (display === 'USD') {
      const usd = cycle === 'annual'
        ? (plan.annual_price_usd_cents ?? plan.monthly_price_usd_cents)
        : plan.monthly_price_usd_cents;
      if (usd != null) return { cents: cycle === 'annual' ? Math.round(usd / 12) : usd, symbol: '$' };
      const rate = Number(geo?.display_rate) || 94.67;
      const inr = cycle === 'annual' ? Math.round((plan.annual_price_cents ?? 0) / 12) : (plan.monthly_price_cents ?? 0);
      return { cents: Math.round((inr / 100 / rate) * 100), symbol: '$' };
    }
    const inr = cycle === 'annual' ? Math.round((plan.annual_price_cents ?? 0) / 12) : (plan.monthly_price_cents ?? 0);
    return { cents: inr, symbol: '₹' };
  };
  return { geo, price };
}
```

> Confirm the exact export used to call `/subscriptions/geo` in `services/api.js` (the app already calls it — grep `subscriptions/geo`) and reuse it; do not add a new endpoint.

- [ ] **Step 2:** Use `price(plan, billingCycle)` for the plan-card labels + the CTA label, replacing the `plan.currency === 'INR' ? '₹' : '$'` logic (lines ~140, ~640).
- [ ] **Step 3:** `cd app && npm run build` → ✓. Manual: paid-plan cards + CTA show `$` amounts (geo), not `₹`.
- [ ] **Step 4:** `git commit -m "feat(app): USD (geo) pricing in bot create flow"`

---

## Task 4: Extract `CreateBotWizard`

**Files:**
- Create: `app/src/pages/my-bots/CreateBotWizard.jsx`
- Modify: `app/src/pages/Chatbot.jsx`

- [ ] **Step 1:** Move the entire create-modal JSX + its state/handlers (`newBotName`, `newBotWebsite`, `createStep`, `billingCycle`, `selectedPlanSlug`, `paidPlans`, `isSubmitting`, `error`, `handleContinueToPricing`, `handleCreateFreeBot`, `handleSubscribeAndCreate`, `closeCreateAndReturnToBot1`, the plans-preload effect, `useBotPricing`) into `CreateBotWizard`. Props: `{ open, isFirstBot, onClose, onCreated }`. On success call `onCreated(botId)` (shell handles refresh + expand/select). Keep both paths (free-first-bot one-screen; 2-step Razorpay incl. dismiss handling) and the restyle (step indicator, disabled-until-valid CTAs, USD prices).
- [ ] **Step 2:** In `Chatbot.jsx`, render `<CreateBotWizard open={isCreateOpen} isFirstBot={bots.length === 0} onClose={() => setIsCreateOpen(false)} onCreated={handleCreated} />`; `handleCreated` refreshes bots and opens the InstallDrawer (or selects the new bot). Keep the `?create=true` deep-link effect in the shell (it just sets `isCreateOpen`).
- [ ] **Step 3:** `cd app && npm run build && npm run lint` → ✓. Manual: first-bot free path; 2nd-bot plan pick + Razorpay success AND dismiss; crawl-on-create still fires; `?create=true` still opens it.
- [ ] **Step 4:** `git commit -m "feat(app): extract CreateBotWizard (2-step, USD pricing)"`

---

## Task 5: Extract `BotCard` with card-as-manage + ⋯ menu

**Files:**
- Create: `app/src/pages/my-bots/BotCard.jsx`
- Modify: `app/src/pages/Chatbot.jsx`

- [ ] **Step 1:** Create `BotCard` from the current card markup, restructured per spec:
  - The **card body** is a keyboard-activatable button/link (`role`, `tabIndex=0`, Enter/Space) → `onManage(bot)`; visible focus ring + hover.
  - **Active badge** when `isActive` (badge + subtle ring); no more "Set Active" button.
  - Inline **rename** preserved (input `stopPropagation`, Enter/Escape/blur commit).
  - Right side: **Install** button (`stopPropagation` → `onInstall(bot)`) + an accessible **⋯ menu**:

```jsx
// Accessible actions menu essentials
<button aria-haspopup="menu" aria-expanded={menuOpen} onClick={(e)=>{e.stopPropagation(); setMenuOpen(v=>!v);}}>⋯</button>
{menuOpen && (
  <div role="menu" onClick={(e)=>e.stopPropagation()} /* click-outside + Esc close via effect */>
    <button role="menuitem" onClick={()=>onDemo(bot)}>Copy demo link</button>
    <a role="menuitem" href={getBotPreviewUrl(bot.bot_key, bot.website)} target="_blank" rel="noopener noreferrer">View demo</a>
    {isBotManager && <button role="menuitem" onClick={()=>onRename(bot)}>Rename</button>}
    {isBotManager && <button role="menuitem" className="text-rose-600" onClick={()=>askDelete()}>Delete…</button>}
  </div>
)}
```
   Keep the existing **two-tap delete confirm** (either inside the menu or as the current inline confirm). Menu closes on click-outside + `Esc`; items keyboard-navigable.
- [ ] **Step 2:** In `Chatbot.jsx`, replace the inline `bots.map(...)` card with `<BotCard ...>` wired to shell handlers: `onManage` = `selectBot(bot)` + `setSearchParams({ tab: 'appearance' })`; `onInstall` = `setInstallBot(bot)`; `onRename`/`onDelete`/`onDemo` = existing handlers. Remove now-dead card state/helpers from the shell.
- [ ] **Step 3:** `cd app && npm run build && npm run lint` → ✓. Manual: card click sets active + opens Bot Settings; Install opens drawer; ⋯ menu (demo/view/rename/delete-confirm) works with keyboard + click-outside; rename works; active badge correct; viewer (non-manager) sees read-only.
- [ ] **Step 4:** `git commit -m "feat(app): BotCard — card-as-manage, active badge, actions menu"`

---

## Task 6: Slim the shell + dead-code sweep

**Files:** `app/src/pages/Chatbot.jsx`

- [ ] **Step 1:** `Chatbot.jsx` should now be a thin shell: header + Add button, loading/empty/error, `bots.map(<BotCard/>)`, `<InstallDrawer/>`, `<CreateBotWizard/>`, and the `?tab=appearance` → `<BotSettings/>` branch. Remove all unused imports, state, and helpers left behind (lint will flag them). Target well under ~200 lines.
- [ ] **Step 2:** `cd app && npm run lint && npm run build` → ✓ (zero unused-var warnings from this file).
- [ ] **Step 3:** `git commit -m "refactor(app): slim Chatbot shell after My Bots extraction"`

---

## Task 7: Accessibility & polish pass

**Files:** the 3 new components.

- [ ] **Step 1:** Verify/complete: InstallDrawer focus trap (focus moves into panel on open, returns to trigger on close) + `aria-modal` + labelled heading + `Esc`/backdrop close + scroll-lock + mobile full-screen; ⋯ menu roles + keyboard + click-outside/Esc; BotCard focus ring + Enter/Space activation + `stopPropagation` on all inner controls; CreateBotWizard step indicator + disabled-until-valid + focus on first field on open. Confirm dark-mode + token consistency; no console warnings.
- [ ] **Step 2:** `cd app && npm run lint && npm run build` → ✓.
- [ ] **Step 3:** `git commit -m "polish(app): a11y + interaction polish for My Bots"`

---

## Task 8: Final verification

- [ ] **Step 1:** `cd app && npm run lint && npm run build` → green.
- [ ] **Step 2:** Full manual smoke (per spec Testing): list · card-click manage · Install slide-over (focus/Esc/backdrop/mobile) with key/demo/domains/guide · ⋯ menu · rename · delete-confirm · create both paths with USD prices · Razorpay dismiss · `?create=true` · `?tab=appearance`.
- [ ] **Step 3:** Push `development`.

---

## Self-Review notes (author)

- **Spec coverage:** componentize (T2,T4,T5,T6) · InstallDrawer slide-over (T2) · card-as-manage + active badge + ⋯ menu, Set-Active removed (T5) · CreateBotWizard restyle + 2-step + USD geo pricing (T3,T4) · a11y invariants (T7) · reuse of DomainRestrictions/PlatformSelector/IntegrationGuide (T2) · `?create`/`?tab` preserved (T4,T6) · frontend-only. All mapped.
- **CTO lens:** clear shell/child boundaries + intent props (no prop-drilling of global state); incremental build-green extraction (no big-bang); reuse over rewrite; no new deps/backend.
- **UX lens:** dedicated slide-over with full focus/scroll/mobile behavior; accessible menu; keyboard-first card; USD pricing consistency; preserved loading/empty/error + free-first-bot messaging.
- **No JS unit runner:** gate is lint+build + documented manual smoke (consistent with SP1/SP2).
- **Naming consistency:** `onManage/onInstall/onRename/onDelete/onDemo`, `installBot`, `useBotPricing().price(plan, cycle)` used uniformly across tasks.
