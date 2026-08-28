# Redesign Audit: `development` vs. `claude/ui-ux-redesign-review-laf0r4`

**Date:** 2026-08-22
**Scope:** Full comparative audit of the admin console (`app/`) — pages/features, component library, design tokens/visual system, and layout/structure consistency — between the old shipped UI (`development`) and the in-progress redesign (`claude/ui-ux-redesign-review-laf0r4`).
**Method:** Four parallel research passes (page inventory, component parity, design tokens, layout consistency) over both branches on disk, cross-checked against `app/REBUILD.md` and `app/DESIGN.md`, with one finding independently re-verified before inclusion (see §2).

---

## Executive summary

The redesign is not a reskin — it's a rebuild with a documented rationale behind almost every change. Across all four passes, the overwhelming majority of what looked like "missing" surface turned out to be a deliberate, reasoned consolidation already written down in `REBUILD.md`, or a decomposition of one old god-component into several smaller `src/ui/` primitives that DESIGN.md explains. **No customer-facing capability has been silently dropped.** The one thing genuinely removed — the Launch Studio onboarding wizard — was replaced by three real product surfaces (`/setup`, `/welcome`, `/welcome/:agentId`), not deleted outright.

That said, this audit did surface real, actionable gaps — mainly around **responsive/mobile support**, a handful of **unaudited empty/locked-state coverage gaps**, and a short list of **small layout duplication** that should be extracted into shared components. Those are itemized in §5 with a priority order in §6.

One flagged "missing component" (UpgradeModal / LockedFeatureCard, cited as 132 and 40 uses in `development`) was a false positive from the component-parity research pass — both exist on the redesign branch, just not exported from `src/ui/` because they're feature-level composites, not generic primitives. Corrected in §2.

---

## 1. Feature & page parity

**Full page/route inventory: 21 pages + 0 super-admin UI in `development` → 23 pages + 7 super-admin sections (~110 previously-unexposed backend endpoints) in the redesign.**

### What changed and why (all documented decisions, not oversights)

| Change | From → To | Reason (per `REBUILD.md`) |
|---|---|---|
| Journey standalone page removed | `/journey` → `/analytics/journey` (tab) | Was a second top-level route that fully remounted on every nav away/back, discarding scroll position and every cached panel. See the [Journey diagram work](../docs/superpowers/plans/2026-08-21-restore-visual-journey-diagram.md) already done this session — the visual/pan-zoom/donut all came back, rebuilt keyboard-accessible, as a view toggle inside the tab. |
| Onboarding wizard removed | `/launch/*` (8-step full-screen wizard) → `/setup` + `/welcome` + `/welcome/:agentId` | Wizard lived outside the shell, so payment failures had no banner and the final step hard-blocked on a third-party ping with no skip. Replaced with three real, permanent product surfaces instead of a disposable wizard. |
| Billing promoted | `/workspace/billing` → `/billing` (top-level) | Credit exhaustion is a customer-facing outage, not a preference setting; it no longer hides eight clicks deep in Workspace. |
| Settings split | `/settings` (ambiguous) → `/settings` (workspace) + `/account` (personal) | Old `/settings` conflated "my profile" and "my workspace's config" under one label; operators now land on their own profile, not workspace admin. |
| Qualification promoted | Buried inside `/advanced` → own top-level chatbot tab `/qualification` | It's a revenue-scoring surface, not technical config — DESIGN.md's verb-based tab naming makes each tab answer one question. |
| Routes renamed | `/agents`→`/chatbots`, `/channels`→`/deploy`, `/advanced`→`/behaviour` | Verb-based, plain-language naming; legacy paths still 301-redirect so old bookmarks/emails don't break. |
| Super-admin console | none → `/platform/*` (7 sections) | ~110 endpoints had zero UI; a separate shell/URL space reflects that a super-admin is not a workspace member. |

### Genuinely new (no `development` equivalent)
`/setup`, `/welcome`, `/welcome/:agentId`, `/dev/ui` (component gallery), and the entire `/platform/*` super-admin section (command centre, customers, records/data-browser, revenue, billing ops, catalogue, configuration).

### Still-open gaps (already tracked, not new findings)
Per `REBUILD.md`'s own "Still open" ledger: crawl page/depth cap surfaced nowhere in the UI, per-lead visitor journey (distinct from the aggregate Journey tab), operator profile full-edit surface, seed-question re-editing, server-side lead filtering/pagination past 200 rows, chat-history pagination past 50 messages. These are documented with owner surfaces already — nothing here is a silent gap this audit is newly discovering.

---

## 2. Component library parity

**Old:** 43 files in `app/src/design-system/`, organized by rough tier (primitives, Admin-2.0 composite cards, entitlements, utilities).
**New:** 216 named exports from one barrel (`app/src/ui/index.ts`), organized by responsibility (primitives, overlays, layout, data, charts, feedback, hooks, utilities).

### Correction to an initial finding

The component-parity research pass flagged `UpgradeModal` (132 uses in `development`) and `LockedFeatureCard` (40 uses) as apparently missing from the new library. **Verified false positive.** Both exist on the redesign branch:
- `UpgradeModal` lives in `app/src/context/UpgradeModal.tsx`, wired through `UpgradeModalContext.tsx`'s `useUpgradeModal()` hook — a global provider pattern, not a `src/ui/` primitive, because its copy is billing/entitlement-specific (per-intent messaging registered in `upgradeIntents.ts`), which is exactly the kind of feature-specific composite `DESIGN.md` says does *not* belong in the generic design system.
- `LockedState` (the redesign's equivalent of `LockedFeatureCard`) is a real `src/ui/data/States.tsx` export, used 25 times across `app/src/features/`.

Net: this is not a gap. It's the intended split between "generic primitive" (`src/ui/`) and "feature composite" (`src/context/`, `src/features/`) that `app/CLAUDE.md`'s non-negotiable #1 describes.

### Real decomposition, not loss
Several old composite cards (`MetricCard`, `IconTile`, `InsightCard`, `ActionCard`, `AgentCard`, `ConversationCard`, `QuickAction`) have no 1:1 named export in the new library. Per `DESIGN.md` §6 ("a number lives in a StatRow"), these were deliberately broken down into smaller, composable primitives (`StatTile`/`StatRow`, `FigureRow`/`FigureList`, `Card`/`CardHeader`/`CardBody`/`CardSection`, `Well`) rather than kept as one-off pre-composed cards. This is the same "compose from primitives, don't pre-bake a card" philosophy that made the old system produce "seven toggles, six chart palettes, five drawers" per `app/CLAUDE.md`'s own postmortem — worth confirming in a live `/dev/ui` pass that every one of these old card *shapes* is actually reachable via the new primitives (this audit didn't verify pixel-for-pixel visual coverage, only export-surface coverage).

### Real new capability (not in `development` at all)
Composable `Menu`/`Popover` (vs. the old opaque single-component versions), a real `Tooltip` (replacing 203 native `title` attributes), `Combobox`/`TagInput`/`FileDrop`/`RadioCards`, a full layout tier (`Grid`, `Columns`, `SplitPane`, `SidebarLayout`, `PropertyGrid`, `SettingRow`/`SettingGroup`/`SettingBand`, `Measure`), a real four-state system (`EmptyState`/`ErrorState`/`LockedState`/`FullPageState` × `LoadingRows`/`LoadingBars`/`LoadingConversations`), `ZoomPanCanvas` (built this session), a complete chart-token system, and centralized formatters/validators that used to be scattered or duplicated per-feature.

### `DESIGN.md` compliance
Every prescription checked (forced-colors mode, container queries, sticky-header behavior, indeterminate-progress-under-reduced-motion, the four-state system, Dialog eyebrow convention, one canonical `SaveBar`, keyboard path through `DataTable`, `RadioCards` for choices needing explanation) has a matching implementation. No documented-but-unbuilt gaps found.

### Gallery coverage
`/dev/ui` exists (`UiGallery.tsx`, ~3,500 lines) and imports the full `src/ui/index.ts` export surface — satisfies `app/CLAUDE.md`'s non-negotiable #1 requirement that every primitive be independently reviewable there.

---

## 3. Design tokens & visual system

This is the strongest part of the redesign, and the one place old and new aren't really comparable in maturity — the old system had no enforcement at all; the new one fails the build on a violation.

### Color: a deliberate rebrand, not a palette swap
- **Accent: violet `#7C3AED` → blue `#3a6ae6`.** Old violet bled into data-viz, focus rings, and active states simultaneously, so "this is interactive" and "this is a data series" used the same hue. New system reserves blue for *only* interactive/focus/selection; a separate muted-violet (`#6e4fb8`) exists solely inside the 8-series chart palette and never touches UI chrome.
- **`--text-tertiary`: `#a1a1aa` → `#6e6a62`.** The old value failed WCAG AA on the sunken surface (measured ~1.8:1 in the new audit's terms). This was a real, live accessibility bug in `development`, now fixed with a documented 5.38:1 minimum.
- **`--border-strong`: `#d4d4d0` → `#8b877f`.** Old value didn't clear the 3:1 WCAG 1.4.11 threshold for control boundaries; new value does (3.58:1 on white).
- **Rail (sidebar) chrome now has its own palette** (`--color-rail-*`), because reusing the light "paper" text tokens against a near-black rail background put health-status dots at ~2.94:1 — another real, fixed accessibility bug.
- **Info tone deleted outright.** DESIGN.md's stated reasoning: a blue "info" tone would collide with the new interactive-blue meaning; a neutral tone with a 3px ink rule replaces it.
- **Dark mode removed, deliberately.** It existed in `development` but — per this session's earlier audit memory — was already dead/unused there. The new branch replaces it with a **high-contrast mode** (`data-contrast='high'`) driven by an accessibility need, not a theme preference, plus full `forced-colors` (Windows High Contrast) support that `development` never had.

### Typography, spacing, radius
All three moved from "implicit/ad hoc" in `development` (no explicit line-height tokens, no control-height tokens, no max-width tokens) to a fully explicit, governed scale in the new `tokens.css` — including a dedicated monospace/tabular-numeral treatment for every figure in the product (prevents digit jitter in live counters), and a z-index ladder (`--z-base` through `--z-banner`) that didn't exist before and is enforced by `scale.test.ts` (no raw `z-[N]` allowed anywhere in `src/`).

### Enforcement is the real headline
`app/src/ui/scale.test.ts` bans raw hex outside `tokens.css`, arbitrary font sizes, raw z-index values, and opacity modifiers on text tokens — and it scans the **entire** `src/` tree, not just `src/ui/`. A grep across `app/src/features/` and `app/src/shell/` for hardcoded hex/arbitrary sizes in this audit returned **zero matches**. `development` had no equivalent lint at all — its 235-defect audit (cited in `app/CLAUDE.md`) is a direct consequence of that absence.

### Nothing to redesign here
Contrast is computed and documented for every token pair against all three grounds (surface/canvas/sunken) in `DESIGN.md` §2.6, plus a live `contrast.test.ts` suite. This category is done to a standard the old system never approached — no further "redesign the colors" work is warranted; the open work is elsewhere (see §5).

---

## 4. Layout & structure consistency

### Strong
- **Page width:** one pattern (`<Page>` → `max-w-page`, 1440px), zero pages set ad-hoc widths.
- **Page headers:** `PageHeader` covers 14+ of ~20 pages; the ~6 exceptions (Inbox's 3-pane console, sub-pages nested inside a parent layout) are architecturally justified, not duplicated one-offs.
- **Layout primitive adoption:** `Card` alone is used 127 times via the shared component; only 5–6 hand-rolled card-like `<div>`s remain, and those are already flagged in the `Card.tsx` source comments as extraction candidates.

### Real gaps found

**Responsive/mobile coverage is thin.** Only ~11 total `sm:`/`md:`/`lg:` breakpoint usages were found across the entirety of `app/src/features/` — for context, the three sampled high-traffic pages (Home, Leads, Analytics) had **zero** breakpoint usage each. Mobile handling exists at the navigation-shell level (`AppShell.tsx`'s `MOBILE_QUERY` collapses the rail), but individual page *content* — tables, multi-column grids, dense forms — is effectively desktop-only. This sits uncomfortably next to `app/CLAUDE.md`'s WCAG 2.2 AA non-negotiable, since responsive layout is part of a genuinely accessible product on real devices, not a nice-to-have. **This is the single most concrete "needs redesign work" finding in this audit.**

**Empty/loading/error/forbidden state coverage is inconsistent, though not necessarily wrong.** Of 6 sampled major pages, 4 had all four states (`EmptyState`, `ErrorState`, `LoadingRows`, `LockedState`); 2 (Analytics, Settings) had three of four, missing `LockedState`. That's very plausibly correct — not every page has a plan gate to lock against — but per `app/CLAUDE.md`'s non-negotiable #3 ("every surface ships four states"), the omission isn't currently *documented* as intentional anywhere. Worth a quick pass to either confirm each omission is deliberate (no entitlement gate exists for that page) or close the gap.

**Minor, already-converging layout duplication.** ~10 instances of hand-rolled `flex items-center justify-between` acting as an ad-hoc section header, spread across `InboxPage`, `LeadsPage`, `BillingPage`, `AgentsPage`, `ExperiencePage`, `QualificationPage`. Small enough to be a one-afternoon extraction into a shared row-header pattern, not a structural problem.

---

## 5. What should be redesigned again

Ranked by how load-bearing the gap is, not by effort:

1. **Responsive/mobile layout for page content.** The shell already collapses to a mobile rail; the content inside pages doesn't follow. Tables need a stacked/card fallback below a breakpoint, multi-column forms need to collapse to one column, and dense data grids (Leads, Records, Billing) need a real mobile reading pattern rather than horizontal scroll as the only fallback. This is the one item in this whole audit that represents unfinished work against the redesign's own stated standard, not a difference of opinion.

2. **Close the `LockedState` documentation gap.** Quick pass: for every page currently missing one of the four required states, either add it (if a real entitlement gate applies) or leave a one-line comment saying why it's exempt (matches the pattern this session already used when removing the BANT-override control — state the reasoning in the code, not just in an audit doc that will go stale).

3. **Extract the repeated `flex items-center justify-between` header pattern** (~10 sites) into one shared primitive (a `RowHeader` or similar) in `src/ui/layout/`, with a `/dev/ui` entry — consistent with how `Card`'s own source comments already flag the analogous hand-rolled-card duplication for the same treatment.

4. **Verify old composite-card visual parity, not just export-surface parity.** The component-parity pass confirmed every *capability* behind `MetricCard`/`IconTile`/`InsightCard`/etc. has a composable equivalent (`StatTile`, `FigureRow`, `Card` + subparts), but didn't do a pixel-level check that every page actually recomposed the old shape correctly rather than approximating it. Worth a `/dev/ui`-driven visual pass on the pages that used those old cards most (Home, Overview) to confirm nothing reads as visually thinner than before.

5. **Nothing further on color/tokens.** As covered in §3, this layer is already ahead of where `development` ever was, with computed contrast, enforcement tests, and a documented rationale for every deviation. Re-opening it would be effort spent on an already-solved problem.

---

## 6. Priority action list

| # | Item | Why now | Rough scope |
|---|---|---|---|
| 1 | Add responsive breakpoints to Leads/Billing/Records tables + dense forms | Only real "unfinished redesign" gap; blocks real mobile usage today | Medium — table stacking pattern + apply across ~5-8 pages |
| 2 | Audit + document `LockedState` coverage per page | Cheap, closes a non-negotiable compliance gap | Small — few hours |
| 3 | Extract shared row-header primitive for the ~10 ad-hoc `flex justify-between` sites | Prevents further drift; matches an already-flagged pattern | Small |
| 4 | Visual parity spot-check of old composite cards on Home/Overview | Confirms the decomposition didn't quietly lose visual weight | Small — browser walkthrough, no code unless something's found |

Everything else surfaced by this audit — the page/route reorganization, the component-library restructuring, the color/accent rebrand, the accessibility fixes baked into the token system — is already correct, already documented, and does not need further redesign work.
