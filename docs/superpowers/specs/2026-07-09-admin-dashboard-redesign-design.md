# Admin Dashboard Redesign — Design Spec

**Date:** 2026-07-09
**App:** `app/` (React 19 · Vite 8 · React Router 7 · Tailwind v4 · Recharts · Framer Motion)
**Branch:** `feature/admin-redesign`
**Goal:** Elevate the OyeChats admin dashboard to a world-class, premium SaaS experience — soothing warm-light theme, upgraded color, distinctive type — inspired by Shopeers (premium B2B analytics) and Minecloud (airy light dashboard).

## Locked design decisions

| Lever | Decision |
|-------|----------|
| **Primary accent** | Cobalt `#2F5CFF` (upgraded from flat indigo) |
| **Canvas** | Warm ivory `#F8F6F0` (soothing, never pure white) |
| **Card surface** | Warm near-white `#FFFDF9` |
| **Sidebar** | Light ivory rail `#F1EDE3` (one shade deeper than canvas — Minecloud-style, airy) |
| **Positive / gold / danger** | Emerald `#10B981` · gold `#C99A3F` (rare) · rose `#F43F5E` |
| **Typeface** | Manrope (headings, numerals, UI, body) — excellent tabular figures |
| **Density** | Comfortable (generous padding, calm) |
| **Dark mode** | Light-first now; token layer built dark-ready, dark polished in a later pass |
| **Bot Selector** | Redesigned premium card (avatar tile + "ACTIVE BOT" eyebrow + name; premium dropdown with "Create new bot"). Stays under the logo. IA unchanged. |

## Architecture

### Token strategy (key insight)
The app already consumes Tailwind-v4 `@theme` ramps (`--color-primary-*`, `--color-surface-*`) and semantic CSS vars (`--bg`, `--bg-card`, `--border`, `--text`, …) across ~30 pages. Rather than rename tokens everywhere, we **remap the ramps in place**:
- `--color-primary-*` → cobalt ramp
- `--color-surface-*` → warm ivory/greige ramp
- Semantic vars (`:root` + `.dark`) → point at the new ramps; add `--sidebar-bg` = ivory light rail.

This instantly re-skins every page that already uses the tokens — the highest-leverage, lowest-risk move.

### Layers
1. **Primitive tokens** — cobalt + ivory ramps, accent ramps (in `src/index.css` `@theme`).
2. **Semantic tokens** — `--bg-canvas`, `--bg-card`, `--border`, `--text*`, `--primary`, `--ring`, `--sidebar-bg`, radius, shadow, type scale.
3. **Shared UI primitives** — restyled in place, same prop APIs (`Button, Card, StatCard, DataTable, Badge, Input, Select, Tabs, Dialog, Drawer, Alert, Progress, Avatar, EmptyState, PageHeader, Toggle, SkeletonLoader`).
4. **App shell** — `Sidebar` (light rail + redesigned Bot Selector), `TopBar` (frosted ivory).
5. **Flagship pages** — Overview/Dashboard, Insights, Leads (incl. Recharts styling: cobalt line + soft gradient fill, muted multi-tone donut, tabular numerals).

## Rollout (phased, each independently shippable, `lint` + `build` verified per phase)

1. **Token layer** — remap ramps + semantic vars in `index.css`; wire Manrope. *(reskins most of the app)*
2. **UI primitives** — polish shape/elevation/shadow/typography across `components/ui/*`.
3. **App shell** — Sidebar light rail + Bot Selector redesign; TopBar.
4. **Flagship pages** — Overview, Insights, Leads + Recharts theme.
5. **Sweep** — hunt hardcoded colors/spacing the tokens didn't catch across remaining pages.

## Constraints & guardrails
- **No behavior changes.** Preserve all IA, routes, entitlement gating, badges, operator-role variants, collapsed-rail state, framer-motion transitions.
- **No prop-API changes** to shared primitives (consumers untouched).
- Keep dark mode functional throughout (`.dark` class strategy).
- Per `CLAUDE.md`: work on `development`-derived branch; run `npm run lint` + `npm run build` before reporting each phase.

## Success criteria
- The five locked decisions are visibly realized across shell + flagship pages.
- `npm run lint` and `npm run build` pass after every phase.
- No regressions in navigation, entitlement locking, or bot switching.
