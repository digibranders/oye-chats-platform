# Admin 2.0 - Design Reconciliation & Plan Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the last mile of the Admin 2.0 rebuild - make the app *look* as premium as it already *is*, and make every page plan-aware - without regressing the shell, IA, or backend contracts.

**Architecture:** Five independent, individually-shippable workstreams. Each lands on its own short-lived branch off `development`, passes the full gate (`typecheck` · `lint` · `build` + browser check), and merges before the next begins. No workstream depends on an unmerged sibling except where the sequencing table says so. Backend is untouched throughout - we consume existing endpoints only.

**Tech Stack:** Vite · React 18 · TypeScript (incremental - new code is `.tsx`) · Tailwind CSS v4 (`@theme`) · `--ds-*` semantic CSS tokens · react-router-dom · lucide-react · Recharts.

**Verification gate (every workstream, non-negotiable - from `../CLAUDE.md`):**
```bash
cd oye-chats-platform/app
npm run typecheck   # tsc --noEmit - zero errors
npm run lint        # eslint . - zero errors
npm run build       # vite build - succeeds
```
Plus a manual browser pass on `npm run dev` (localhost:5173) against the workstream's acceptance criteria. **A workstream is not "done" until all four are green and reported.**

---

## CTO Sign-off Summary

| WS | Title | Priority | Risk | Effort | Depends on |
|----|-------|----------|------|--------|------------|
| **0** | Foundation & guardrails | - | Low | 0.5d | - |
| **1** | Design-system reconciliation (violet + hairline focus + token layers + leak sweep) | P0 | Low–Med | 1.5–2d | WS-0 |
| **2** | Agent-tab padding/alignment fix | P0 | Low | 0.25d | WS-0 |
| **3** | Settings → bottom sidebar zone; split Workspace(admin)/Settings(prefs) | P1 | Med | 1d | WS-0 |
| **4** | Plan-entitlement wiring (provider · gates · meters) | P1 | Med–High | 2.5–3d | WS-3 (sidebar zone) |
| **5** | Honesty & hygiene (honest empty states · 404 · delete orphaned legacy) | P2 | Low | 1d | WS-1, WS-4 |

**Recommended merge order:** WS-0 → WS-1 → WS-2 → WS-3 → WS-4 → WS-5.
**Rationale:** color first (biggest perceived-quality jump, unblocks everything visually); trivial padding fix rides alongside; nav restructure before entitlements because entitlements adds sidebar lock affordances that touch the same file; legacy deletion last because WS-4 must *read* the legacy `useEntitlements`/`FeatureGate` before they can be safely removed.

**Total estimate:** ~6.5–7.5 engineer-days. Each WS is a reviewable PR.

**Guardrails that make this CTO-approvable:**
- Backend/API/auth contracts are **read-only**. No endpoint, model, or auth-header change.
- Each WS is independently revertable (`git revert <merge-sha>`) with zero cross-contamination.
- No visual regression to the shell/IA that the shell audit rated strong.
- Warm "paper" neutrals are **preserved** (brand-consistent with the live website); only the accent hue changes.

---

## File Structure (what each workstream owns)

**WS-1 - Design system**
- Modify: `src/design-system/tokens.css` (accent family, ring, add radius/spacing/type/motion token layers)
- Modify: `src/index.css` (Tailwind `@theme` primary ramp)
- Modify: `src/design-system/primitives/buttonVariants.ts` (radius → token, focus ring → hairline, hover lift)
- Modify: `src/design-system/primitives/Input.tsx` (focus ring → hairline)
- Modify: focus-ring consumers - `AgentCard.tsx`, `QuickAction.tsx`, `ActionCard.tsx`, `Modal.tsx`, `Tabs.tsx`, `DataTable.tsx` (any `ring-2 … ring-offset-2`)
- Modify (leak sweep): `src/features/analytics/chart-theme.ts`, `src/components/ui/charts.jsx`, `src/features/agents/experience/ExperiencePage.tsx`, `src/features/launch-studio/steps/CustomizeStep.tsx`, `src/features/workspace/billing/TopupModal.tsx`

**WS-2 - Tab alignment**
- Modify: `src/features/agents/AgentLayout.tsx` (own the horizontal padding once)
- Modify: `src/features/agents/channels/ChannelsPage.tsx`, `src/features/agents/analytics/AgentAnalyticsPage.tsx` (remove per-page padding override)

**WS-3 - Settings nav**
- Modify: `src/shell/nav.config.ts` (add `SECONDARY_NAV`)
- Modify: `src/shell/Sidebar.tsx` (bottom-anchored secondary zone)
- Modify: `src/app/routes.tsx` (promote `/settings`, keep `/workspace/*` admin tabs)
- Create: `src/features/settings/SettingsLayout.tsx`, `src/features/settings/index.ts`
- Move: workspace `SettingsPage.tsx` → `features/settings/` (preferences); Workspace keeps Members/Billing/Usage/Security/API Keys/Integrations
- Modify: `src/features/workspace/WorkspaceLayout.tsx` (drop the Settings tab)

**WS-4 - Entitlements**
- Create: `src/context/EntitlementsContext.tsx`, `src/hooks/useEntitlements.ts` (typed port), `src/design-system/components/FeatureGate.tsx`, `src/design-system/components/UpgradeModal.tsx`, `src/design-system/components/QuotaMeter.tsx`, `src/design-system/components/PlanBadge.tsx`
- Modify: `src/shell/AppShell.tsx` (mount `EntitlementsProvider` + `UpgradeModalProvider`)
- Modify: `src/shell/Sidebar.tsx` (plan pill / lock affordance in secondary zone)
- Modify (gates): `AgentsPage.tsx`, `channels/ChannelsPage.tsx`, `inbox/InboxPage.tsx`, `advanced/AdvancedPage.tsx`, `experience/ExperiencePage.tsx`, `workspace/MembersPage.tsx`, `knowledge/KnowledgePage.tsx`, `home/HomePage.tsx`, `workspace/UsagePage.tsx`

**WS-5 - Honesty & hygiene**
- Modify: `src/features/inbox/LiveChatPanel.tsx`, `src/features/workspace/SecurityPage.tsx` (honest single empty state, no fake metrics)
- Create: `src/features/system/NotFoundPage.tsx`; Modify `src/app/routes.tsx` (real 404)
- Delete: `src/App.jsx`, `src/layouts/`, non-auth `src/pages/*` (strangler-fig cleanup)

---

## Workstream 0 - Foundation & guardrails

**Goal:** A clean starting line and a safety net so every later WS can be verified and reverted independently.

**Files:** none (branch + baseline only).

- [ ] **Step 1: Create the integration branch off `development`**

```bash
cd /Users/a12345/Desktop/AI/OyeChats/oye-chats-platform
git checkout development && git pull --ff-only
git checkout -b feat/admin2-design-wiring
```

- [ ] **Step 2: Confirm the gate is green on a clean tree** (so later failures are provably ours)

```bash
cd app && npm run typecheck && npm run lint && npm run build
```
Expected: all three succeed. If `typecheck`/`lint` already fail on `development`, STOP and record the pre-existing failures - do not absorb them into this work.

- [ ] **Step 3: Start the dev server for browser verification**

```bash
cd app && npm run dev
```
Expected: serves on `http://localhost:5173`. Leave running in a background shell for the visual checks in each WS.

- [ ] **Step 4: Capture a visual baseline** - screenshot Home, an Agent Overview tab, Channels tab, and Workspace → Billing at current `#a21caf` magenta, for before/after comparison. Save to `app/docs/plans/assets/baseline/`.

---

## Workstream 1 - Design-system reconciliation (P0)

**Goal:** The whole app reads as the finalized violet system (Linear/Vercel/Stripe feel) via a bounded token change - accent hue, hairline focus rings, and the missing radius/spacing/type token layers - then a mechanical sweep of the ~30 hardcoded color leaks. **Warm paper neutrals are preserved.**

**Files:** listed under WS-1 in File Structure.

**Branch:** `feat/admin2-ws1-design-system` (off `feat/admin2-design-wiring`).

### Task 1.1 - Swap the accent family (light + dark)

- [ ] **Step 1: Edit `src/design-system/tokens.css`** - replace the magenta accent tokens with the finalized violet family. In the `:root` (light) block:

```css
/* Accent - violet #7C3AED, used sparingly (primary actions, active state) */
--ds-accent: #7C3AED;
--ds-accent-hover: #6D28D9;
--ds-accent-fg: #ffffff;
--ds-accent-soft: rgba(124, 58, 237, 0.08);
--ds-accent-text: #5B21B6;
```
And the light focus ring:
```css
--ds-ring: #7C3AED;
```

- [ ] **Step 2: Edit the `.dark { … }` block in the same file** - violet that clears WCAG AA on dark surfaces:

```css
--ds-accent: #7C3AED;
--ds-accent-hover: #8B5CF6;
--ds-accent-fg: #ffffff;
--ds-accent-soft: rgba(139, 92, 246, 0.16);
--ds-accent-text: #A78BFA;
--ds-ring: #8B5CF6;
```

- [ ] **Step 3: Edit `src/index.css`** - repoint the Tailwind `@theme` primary ramp so `--color-primary-600` and neighbors are the violet family (600 `#7C3AED`, 700 `#6D28D9`, 800 `#5B21B6`, 500 `#8B5CF6`, 400 `#A78BFA`, 50 `#F5F3FF`, 100 `#EDE9FE`, 200 `#DDD6FE`). Leave `--color-surface-*` (warm paper) UNCHANGED.

- [ ] **Step 4: Verify contrast** - white on `#7C3AED` ≈ 5.1:1 (passes AA for UI/large text). For any place violet sits *under body text*, use `--ds-accent-text` (`#5B21B6` light / `#A78BFA` dark), not `--ds-accent`. Grep for `--ds-accent-text` usages and confirm none render small text on the bright hue.

- [ ] **Step 5: Browser check** - reload `localhost:5173`. Sidebar active state, primary buttons, and links are violet; surfaces are still warm paper (not slate). No magenta remains in DS-driven components.

- [ ] **Step 6: Commit**
```bash
git add src/design-system/tokens.css src/index.css
git commit -m "feat(ds): repoint accent from magenta #a21caf to violet #7C3AED (light+dark)"
```

### Task 1.2 - Add the missing token layers (radius, spacing, type, motion)

- [ ] **Step 1: Add radius tokens to `:root` in `tokens.css`** (so corner rounding is centrally tunable):
```css
--ds-radius-sm: 6px;
--ds-radius-md: 8px;
--ds-radius-lg: 12px;   /* primary buttons - matches the reference showcase */
--ds-radius-xl: 16px;   /* cards */
--ds-radius-2xl: 20px;  /* modals */
--ds-radius-full: 9999px;
```

- [ ] **Step 2: Add spacing + type + motion tokens** to `:root` (values mirroring the reference showcase's scale - 4px base spacing `--ds-space-1..20`; `--ds-text-xs..display`; `--ds-ease-standard: cubic-bezier(.2,0,0,1)`, `--ds-dur-fast: 120ms`, `--ds-dur-base: 200ms`). Keep these additive - do not rip out existing Tailwind utilities in this task.

- [ ] **Step 3: Point Button + Card + Modal radius at the tokens.** In `buttonVariants.ts` replace `rounded-lg` with `rounded-[var(--ds-radius-lg)]`; in `Card.tsx` use `rounded-[var(--ds-radius-xl)]`; in `Modal.tsx` use `rounded-[var(--ds-radius-2xl)]`.

- [ ] **Step 4: Browser check** - buttons now have the 12px reference radius; cards/modals consistent. Commit:
```bash
git add src/design-system/
git commit -m "feat(ds): add radius/spacing/type/motion token layers; route button/card/modal radius through tokens"
```

### Task 1.3 - Replace the 2px glow focus ring with a hairline 1px ring

- [ ] **Step 1: Define the hairline in `tokens.css`** (light + dark already have `--ds-ring`). Establish the canonical Tailwind class string the app will use everywhere: `focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]` - a 1px box-shadow that follows the element's own radius, no offset, no 2px glow.

- [ ] **Step 2: Edit `buttonVariants.ts`** - remove `focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] focus-visible:ring-offset-2`; add the hairline class from Step 1. Add the hover lift `hover:-translate-y-px active:translate-y-0 transition-transform` to the primary variant only.

- [ ] **Step 3: Edit `Input.tsx`** - replace `ring-2 ring-[var(--ds-accent-soft)]` with the hairline (`focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]`), border stays `--ds-border` → `--ds-accent` on focus.

- [ ] **Step 4: Sweep the remaining ring consumers.** Grep and replace every `ring-2` + `ring-offset-2` occurrence in the design-system + features:
```bash
grep -rn "ring-offset-2\|focus-visible:ring-2" src/design-system src/features src/shell
```
Apply the same hairline in each hit (`AgentCard.tsx`, `QuickAction.tsx`, `ActionCard.tsx`, `Tabs.tsx`, `DataTable.tsx`, `Modal.tsx`, workspace tab row, analytics RangeControl).

- [ ] **Step 5: Browser + keyboard check** - Tab through Home and an Agent tab: every focusable element shows a crisp 1px violet ring hugging its radius, no chunky glow. Commit:
```bash
git add -A
git commit -m "feat(ds): replace 2px offset glow focus ring with hairline 1px ring across DS + features"
```

### Task 1.4 - Sweep the ~30 hardcoded color leaks

- [ ] **Step 1: Enumerate the leaks:**
```bash
grep -rn "#a21caf\|#A21CAF\|#86198f\|#d946ef\|indigo-\|purple-\|fuchsia-" src/features src/components src/pages src/layouts
```

- [ ] **Step 2: Fix the live (new-tree) leaks** - these render in the running app:
  - `src/features/analytics/chart-theme.ts` - `accent: '#a21caf'`/dark `'#d946ef'` → `'#7C3AED'`/`'#8B5CF6'`; recolor the series ramp to a violet-anchored palette.
  - `src/components/ui/charts.jsx` - `primary: '#a21caf'` and series array → violet family.
  - `src/features/agents/experience/ExperiencePage.tsx` (`:39`) and `src/features/launch-studio/steps/CustomizeStep.tsx` (`:19`) - widget preset swatch arrays: replace the `#a21caf` default with `#7C3AED`.
  - `src/features/workspace/billing/TopupModal.tsx` (`:102`) - default color `#a21caf` → `#7C3AED`.

- [ ] **Step 3: Leave legacy-tree leaks (`src/pages/*`, `src/layouts/*`, legacy `src/components/*` gradients) alone** - they are orphaned and get deleted wholesale in WS-5. Note them; don't spend time recoloring dead code.

- [ ] **Step 4: Browser check** - open Agent → Analytics and the widget customizer: charts and preset swatches are violet, no magenta. Commit:
```bash
git add -A
git commit -m "fix(ds): recolor live hardcoded magenta leaks (charts, widget presets, topup) to violet"
```

**WS-1 acceptance criteria:**
- Zero magenta (`#a21caf`/`#d946ef`) in any *rendered* surface; grep of `src/features|src/shell|src/design-system` returns none.
- Focus rings are 1px hairline everywhere, following element radius.
- Warm paper neutrals unchanged; app is not slate.
- Primary buttons: 12px radius, flat, subtle hover lift.
- Gate green (typecheck · lint · build) + browser pass.

---

## Workstream 2 - Agent-tab padding/alignment fix (P0)

**Goal:** Kill the visible left-edge shift when switching agent tabs by owning horizontal padding in exactly one place.

**Files:** `AgentLayout.tsx`, `channels/ChannelsPage.tsx`, `analytics/AgentAnalyticsPage.tsx`.

**Branch:** `feat/admin2-ws2-tab-padding`.

### Task 2.1 - Normalize padding

- [ ] **Step 1: Read the three files** to confirm current padding:
```bash
grep -n "px-4\|md:px-6\|md:px-8\|PageContainer\|className=\"flex-1" src/features/agents/AgentLayout.tsx src/features/agents/channels/ChannelsPage.tsx src/features/agents/analytics/AgentAnalyticsPage.tsx
```
Expected: `AgentLayout` header `px-4 pt-6 md:px-8`, content `<main className="flex-1">` (no h-padding); Channels/Analytics each add `PageContainer className="px-4 py-6 md:px-8"`.

- [ ] **Step 2: Decide the single source of padding.** `AgentLayout` sits inside AppShell's already-padded `<main className="… px-4 py-6 md:px-6 md:py-8">`. So the agent *content* should add **no horizontal padding** and inherit AppShell's `md:px-6`. Change the `AgentLayout` header from `md:px-8` to `md:px-6` so header and body share the same inset.

- [ ] **Step 3: Remove the per-page overrides** in `ChannelsPage.tsx` and `AgentAnalyticsPage.tsx` - drop `px-4 py-6 md:px-8` from their `PageContainer`, leaving only `PageContainer` (or `PageContainer width=…`) with vertical rhythm handled by the shared `space-y-*`.

- [ ] **Step 4: Browser check** - click through Overview → Knowledge → Experience → Channels → Analytics → Advanced. The content left edge does **not** move; every tab body aligns with the header above it. Commit:
```bash
git add src/features/agents/
git commit -m "fix(agents): unify horizontal padding across all six agent tabs (remove per-tab overrides)"
```

**WS-2 acceptance criteria:** no horizontal shift across the six tabs; header/body left edges aligned; gate green.

---

## Workstream 3 - Settings → bottom sidebar zone (P1)

**Goal:** Promote **Settings** (preferences) to a bottom-anchored secondary nav zone in the sidebar; keep **Workspace** as org-administration. Clean "administer the org vs. tune my experience" split.

**Files:** listed under WS-3 in File Structure.

**Branch:** `feat/admin2-ws3-settings-nav`.

### Task 3.1 - Define the secondary nav

- [ ] **Step 1: Edit `src/shell/nav.config.ts`** - keep `PRIMARY_NAV` (six items) exactly as-is. Add:
```ts
import { Settings, LifeBuoy } from 'lucide-react';

/** Secondary, bottom-anchored nav - preferences & help, separate from the
 *  primary object-nav. Account/workspace switching stays in the TopBar menu. */
export const SECONDARY_NAV: NavItem[] = [
  { to: '/settings', label: 'Settings', icon: Settings, hint: 'Profile, workspace and appearance' },
  { to: '/help', label: 'Help', icon: LifeBuoy, hint: 'Docs and support' },
];
```
(If `/help` has no destination yet, ship Settings only and add Help in WS-5.)

### Task 3.2 - Render the bottom zone

- [ ] **Step 1: Edit `src/shell/Sidebar.tsx`** - replace the dead `"Admin 2.0"` footer marker with a `SECONDARY_NAV` block pinned to the bottom (the primary `<nav>` already has `flex-1`, so the secondary block sits below it). Reuse the exact same `NavLink` styling/active-state/collapsed behavior as the primary items (active = `bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]` + 3px rail marker). Respect `showLabels` for the collapsed rail.

- [ ] **Step 2: Browser check** - Settings appears at the sidebar bottom, above where the account control will live, with identical active/hover/collapsed behavior to primary items.

### Task 3.3 - Route Settings as a first-class area; slim Workspace

- [ ] **Step 1: Create `src/features/settings/SettingsLayout.tsx`** - a preferences layout with tabs Profile · Workspace · Appearance · Notifications (mirror `WorkspaceLayout`'s tab-row pattern for consistency). Export a barrel `src/features/settings/index.ts`.

- [ ] **Step 2: Move preferences content out of Workspace.** Relocate `src/features/workspace/SettingsPage.tsx` → `src/features/settings/` as the Workspace-preferences tab body. Workspace keeps Members/Billing/Usage/Security/API Keys/Integrations only.

- [ ] **Step 3: Edit `src/features/workspace/WorkspaceLayout.tsx`** - remove the `{ path: 'settings', label: 'Settings' }` tab (line ~24). Workspace tab row now has six tabs.

- [ ] **Step 4: Edit `src/app/routes.tsx`** - remove the `workspace/settings` child route; add a top-level `settings` area under the AppShell:
```tsx
{
  path: 'settings',
  handle: { crumb: 'Settings' },
  element: <SettingsLayout />,
  children: [
    { index: true, element: <Navigate to="profile" replace /> },
    { path: 'profile', handle: { crumb: 'Profile' }, element: <ProfileSettingsPage /> },
    { path: 'workspace', handle: { crumb: 'Workspace' }, element: <WorkspacePrefsPage /> },
    { path: 'appearance', handle: { crumb: 'Appearance' }, element: <AppearanceSettingsPage /> },
    { path: 'notifications', handle: { crumb: 'Notifications' }, element: <NotificationSettingsPage /> },
  ],
},
```
(Ship with the tabs that have real content today - at minimum Workspace-prefs + Appearance/theme, which already exists via `ThemeProvider`. Stub tabs must use an honest `EmptyState`, never fake controls - see WS-5 rule.)

- [ ] **Step 5: Add a redirect for the old URL** so existing links/bookmarks don't 404:
```tsx
{ path: 'workspace/settings', element: <Navigate to="/settings" replace /> },
```

- [ ] **Step 6: Browser check** - `/settings` renders via the bottom nav; `/workspace` shows six tabs (no Settings); old `/workspace/settings` redirects to `/settings`; breadcrumbs read "Settings › …". Commit:
```bash
git add -A
git commit -m "feat(nav): promote Settings to bottom sidebar zone; Workspace becomes org-admin only"
```

**WS-3 acceptance criteria:** Settings reachable from the sidebar bottom, not as a Workspace tab; Workspace = 6 admin tabs; old URL redirects; no dead footer; gate green.

---

## Workstream 4 - Plan-entitlement wiring (P1)

**Goal:** Make the new app plan-aware. Port the (currently orphaned) entitlements system into the live tree, mount the provider, and wire the concrete gates + quota meters. **No backend change** - consume `GET /auth/me/entitlements`.

**Backend contract (read-only, already live):** `GET /auth/me/entitlements` → `{ plan_slug, plan_name, subscription_status, is_free, is_enterprise, limits{credits,bots,operators,leads,page_scraping,documents,chat_history_days}, features{live_chat,bant,branding_removable,webhooks,api_access,online_support,topup_allowed,integrations}, usage{…} }`. Client already exists: `src/services/api.js` `getEntitlements` → `/auth/me/entitlements`. Reference implementation to port: legacy `src/hooks/useEntitlements.js`, `src/components/FeatureGate.jsx`, `src/components/UpgradeModal.jsx`, `src/context/UpgradeModalContext.jsx`.

**Files:** listed under WS-4 in File Structure.

**Branch:** `feat/admin2-ws4-entitlements`.

### Task 4.1 - Typed entitlements context + hook

- [ ] **Step 1: Create `src/context/EntitlementsContext.tsx`** - a provider that fetches `getEntitlements()` once on mount (and on workspace switch), exposes `{ entitlements, loading, error, refresh }`, and falls back to a typed Free-plan default on error (never blocks the app). Port the caching/refresh logic from legacy `useEntitlements.js:43-73,157-185`, typed.

- [ ] **Step 2: Create `src/hooks/useEntitlements.ts`** - typed selector hook over the context returning `hasFeature(key)`, `withinLimit(key, current)`, `limitFor(key)`, `remaining(key, current)`, `isFree`, `planSlug`. Define the `Entitlements` type from the backend contract above (no `any`).

- [ ] **Step 3: Write a smoke test** `src/hooks/__tests__/useEntitlements.test.ts` - Free-plan fallback returns `isFree === true`, `limitFor('bots') === 1`, `hasFeature('live_chat') === false`. Run it (vitest); confirm pass.

### Task 4.2 - Mount the providers

- [ ] **Step 1: Edit `src/shell/AppShell.tsx`** - wrap the shell in `<EntitlementsProvider>` and `<UpgradeModalProvider>` (port `UpgradeModalContext.jsx` → `.tsx` into `src/context/`). Confirm they sit inside the auth/workspace providers so the fetch has a token.

- [ ] **Step 2: Browser check** - Network tab shows one `GET /auth/me/entitlements` on load; no console errors; app renders normally for a Free workspace.

### Task 4.3 - Shared gating components

- [ ] **Step 1: Create `src/design-system/components/UpgradeModal.tsx`** - DS-styled modal (reuse `Modal` primitive) showing the current plan, the locked capability, and a CTA linking to `/workspace/billing`. Driven by `UpgradeModalContext`.

- [ ] **Step 2: Create `src/design-system/components/FeatureGate.tsx`** - `<FeatureGate feature="live_chat" fallback={<LockedState/>}>…</FeatureGate>`; when the feature is absent, render the locked affordance and open the upgrade modal on interaction. Port semantics from legacy `FeatureGate.jsx`.

- [ ] **Step 3: Create `src/design-system/components/QuotaMeter.tsx`** - a labeled progress meter (`used / limit`, `-1` = unlimited → "Unlimited") reusing the `Progress` primitive; turns `--ds-warning` at ≥80%, `--ds-danger` at 100%.

- [ ] **Step 4: Create `src/design-system/components/PlanBadge.tsx`** - small plan pill (Free/Pro/Enterprise) using `StatusBadge`. Export all four from `src/design-system/index.ts`.

### Task 4.4 - Wire the gates (one commit per surface)

For each, gate on the exact backend key and show an upgrade affordance instead of a raw failure:

- [ ] **Add Agent** - `features/agents/AgentsPage.tsx`: if `!withinLimit('bots', agents.length)`, the "Add agent" CTA opens the upgrade modal; also catch the backend `402 must_subscribe` on create and route to the same modal.
- [ ] **Channels** - `channels/ChannelsPage.tsx`: gate non-website channels on `features.integrations === 'all'`; `reply_to_only`/locked channels show a `FeatureGate` locked card (not a dead button).
- [ ] **Inbox live chat** - `inbox/InboxPage.tsx`: gate the live-chat tab on `features.live_chat` (dovetails with WS-5 honest state).
- [ ] **Advanced** - `advanced/AdvancedPage.tsx`: gate Webhooks on `features.webhooks`, API access on `features.api_access`.
- [ ] **Experience** - `experience/ExperiencePage.tsx`: gate "remove branding" on `features.branding_removable`.
- [ ] **Members** - `workspace/MembersPage.tsx`: gate "invite" on `withinLimit('operators', seats)`.
- [ ] **Knowledge** - `knowledge/KnowledgePage.tsx`: `QuotaMeter` for `documents` and `page_scraping`; block add when at limit with upgrade CTA.
- [ ] **Home** - `home/HomePage.tsx`: add a plan/usage summary card (`PlanBadge` + top 2–3 `QuotaMeter`s) + a trial/upgrade banner for Free.
- [ ] **Usage** - `workspace/UsagePage.tsx`: extend beyond credits to render `QuotaMeter`s for documents, page_scraping, bots, operators, chat_history_days from `entitlements.limits`/`usage`.

After each surface: browser-check the locked + unlocked states (simulate by temporarily forcing the Free fallback), then commit `feat(entitlements): gate <surface> on <key>`.

**WS-4 acceptance criteria:**
- One `/auth/me/entitlements` fetch, cached, refreshed on workspace switch; typed, no `any`.
- Every surface in Task 4.4 shows a graceful locked/upgrade state on Free and full access on a paid plan.
- No raw `402`/backend error reaches the user for a gated action.
- Home + Usage show real quota meters.
- Gate green + browser pass on both Free and paid simulations.

---

## Workstream 5 - Honesty & hygiene (P2)

**Goal:** Remove the "premium spell-breakers" - fake-metric scaffolds, silent 404, and the orphaned legacy tree.

**Files:** listed under WS-5 in File Structure.

**Branch:** `feat/admin2-ws5-honesty-hygiene`.

### Task 5.1 - Honest empty states

- [ ] **Step 1: `src/features/inbox/LiveChatPanel.tsx`** - remove the hardcoded `MetricCard value="0"` counters (`:88-89`). Render a single `EmptyState` ("Live chat console is coming soon") gated by WS-4's `features.live_chat`. Keep the real availability toggle. No fabricated zeros.

- [ ] **Step 2: `src/features/workspace/SecurityPage.tsx`** - replace the "coming soon" 2FA (`:227`) and device-management (`:399`) *actionable-looking* controls with a single honest `EmptyState`/disabled section carrying a clear "Coming soon" `StatusBadge` - nothing that looks clickable-but-dead.

- [ ] **Step 3: Browser check** - neither surface presents a non-functional control as functional. Commit `fix(ux): honest empty states for live chat + security (no fake metrics/dead controls)`.

### Task 5.2 - Real 404

- [ ] **Step 1: Create `src/features/system/NotFoundPage.tsx`** - DS-styled 404 (`SectionHeader` + `EmptyState` + "Back to Home" button).

- [ ] **Step 2: Edit `src/app/routes.tsx`** - replace the catch-all `{ path: '*', element: <Navigate to="/" replace /> }` (`:130`) with `{ path: '*', element: <NotFoundPage /> }` inside the AppShell so 404 keeps the chrome.

- [ ] **Step 3: Browser check** - visit `/nonsense` → styled 404 with the shell, not a silent redirect. Commit `feat(routing): real 404 page instead of silent redirect`.

### Task 5.3 - Delete the orphaned legacy tree (do LAST)

- [ ] **Step 1: Prove they're orphaned** - confirm nothing in the live tree imports them:
```bash
grep -rn "from '\.\./App'\|layouts/\|pages/Dashboard\|pages/Billing\|pages/Settings" src/main.jsx src/app src/shell src/features src/design-system
```
Expected: no references except the 5 auth pages the router still uses (`pages/Login`, `Register`, `VerifyEmail`, `ForgotPassword`, `OAuthCallback`) and anything WS-4 explicitly ported.

- [ ] **Step 2: Delete** `src/App.jsx`, `src/layouts/`, and the non-auth `src/pages/*` (KEEP the 5 auth pages + any file WS-4 ported from). Delete legacy `src/components/*` entitlement files only if WS-4 fully replaced them.

- [ ] **Step 3: Run the full gate** - `typecheck` + `lint` + `build`. A red build here means something live still referenced the deleted code; restore that one file and re-scope. Expected: green (dead code removal shrinks the bundle).

- [ ] **Step 4: Commit** `chore: remove orphaned legacy App/layouts/pages tree (strangler-fig cleanup)`.

**WS-5 acceptance criteria:** no fake-metric or dead-control surfaces; real 404 with chrome; legacy tree gone; bundle smaller; gate green.

---

## Definition of Done (whole plan)

- [ ] Every rendered surface is violet `#7C3AED`; warm paper neutrals intact; zero magenta in `src/features|src/shell|src/design-system`.
- [ ] Hairline 1px focus rings everywhere; 12px primary buttons with subtle hover lift.
- [ ] Agent tabs align with no left-edge shift.
- [ ] Settings lives in the sidebar bottom zone; Workspace = org-admin only; old URL redirects.
- [ ] Every gated surface shows graceful locked/upgrade states on Free and full access on paid; Home + Usage show real quota meters; no raw backend errors surface.
- [ ] Honest empty states; real 404; orphaned legacy tree deleted.
- [ ] `npm run typecheck` · `npm run lint` · `npm run build` green on the final integration branch; browser pass recorded.
- [ ] No backend/API/auth change; each WS independently revertable.

## Risk register

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Warm→slate drift if someone imports the showcase wholesale | Med | Plan explicitly preserves paper neutrals; only accent tokens change |
| Contrast regressions on violet | Low | Task 1.1 Step 4 contrast check; body text uses `--ds-accent-text` |
| Entitlements fetch failure blocks UI | Med | Typed Free-plan fallback; provider never throws |
| Deleting legacy breaks a hidden import | Med | WS-5 runs last, grep-proven orphaned, full build gate before commit |
| Nav restructure breaks deep links | Low | `/workspace/settings` → `/settings` redirect |
| Scope creep across WS | Med | One branch + one PR per WS; merge in order; no cross-WS edits |

## Out of scope (explicit)

- Backend/API/model/auth changes; new endpoints.
- Finishing the live-chat console engine (WS-5 only makes it honest).
- USD/multi-currency billing (already gated "contact sales").
- The superadmin app (`oyechats-admin/`) and website (`oyechats-website/`).
