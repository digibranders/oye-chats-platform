# OyeChats Admin Redesign — Page Playbook

Reference: premium SaaS dashboards (Shopeers / Minecloud). Target feel: **calm, premium, cobalt-on-warm-ivory, Manrope.** This playbook is the contract for polishing individual pages. Follow it exactly. **Do not change any logic, data fetching, routes, props, or behavior — visual/layout only.**

## Design tokens (USE THESE — never hardcode hexes or off-brand colors)

| Purpose | Token / class |
|---|---|
| Canvas | `bg-surface-50` (ivory `#F8F6F0`) — set by layout, don't re-set on pages |
| Card surface | `bg-[var(--bg-card)] dark:bg-surface-900` (warm `#FFFDF9`) |
| Card chrome | `rounded-2xl border border-surface-200 dark:border-surface-800 shadow-sm` |
| Primary accent | `primary-*` (cobalt; 600 = `#2F5CFF`) — buttons, links, active states, icon tiles |
| Positive | `emerald-*` · Warning `amber-*` · Danger/negative `rose-*` |
| Text | heading `text-surface-900 dark:text-surface-50`; body `text-surface-600`; muted `text-surface-500/400` |
| Icon tile | `w-9 h-9 rounded-xl bg-primary-50 dark:bg-primary-500/10` + `text-primary-600 dark:text-primary-400` |
| Radius | cards `rounded-2xl`, controls `rounded-xl`, chips `rounded-lg`/`rounded-full` |
| Numerals | add `tabular-nums` to any metric/number |

### The #1 job: kill off-brand color
Replace decorative **blue / indigo / violet / fuchsia / sky / cyan** accents (and equivalent hardcoded hexes like `#2EA8FF`, `#040B18`, `#6d6bfa`) with **`primary-*` (cobalt)**. 
- KEEP semantic accents: `emerald` (success), `amber` (warning), `rose` (error) — these are part of the system.
- KEEP genuinely multi-categorical data-viz colors, brand logos (Google/Slack icons), and provider brand marks.
- A `sky`/`blue` used purely as "the accent color" → change to `primary`.

## Shared primitives — PREFER these over hand-rolled markup
- `Button` (`variant`: primary/secondary/ghost/outline/destructive/success/link; `size`)
- `Card` / `CardHeader` / `CardTitle` / `CardContent` / `CardFooter`
- `StatCard` — props: `icon, label, value, trend, caption, badge, badgeColor, sparkline, loading`
- `Badge` (`variant`: soft/solid/outline; `color`: primary/success/warning/error/default)
- `DataTable`, `Input`, `Select`, `Tabs`, `Dialog`, `Drawer`, `Alert`, `Progress`, `Avatar`, `EmptyState`, `PageHeader`, `Toggle`, `SkeletonLoader`
- Charts (`components/ui/charts.jsx`): `AreaTrendChart`, `MiniBarChart`, `RadialGauge`, `SegmentedStat`, `BrandTooltip`, `CHART_COLORS`

## Page composition patterns
1. **Page header** — big bold `text-2xl font-bold tracking-tight` title (use `PageHeader` where a page has none). Right-aligned actions use `Button`.
2. **KPI row** — 4-up `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4` of `StatCard`s with `caption="vs. N last period"`.
3. **Cards** — every panel uses the card chrome above; section title `text-base font-bold` + optional muted subtitle; optional icon tile left.
4. **Charts** — use the branded chart components (cobalt line + gradient, dashed comparison, branded tooltip). Retint any existing Recharts to `CHART_COLORS`.
5. **Tables** — clean rows, hairline `border-surface-100 dark:border-surface-800` dividers, uppercase muted column headers (`text-[10px] uppercase tracking-wider text-surface-400`), `tabular-nums` on numbers, thumbnails/avatars where entities have them.
6. **Spacing** — comfortable: page sections `space-y-6`; card padding `p-5`/`p-6`.
7. **Motion** — keep existing framer-motion; don't add heavy new animation.

## Hard rules
- **No logic changes.** Only className/markup/structure for visuals. Preserve every handler, state, prop, conditional, entitlement gate, loading/empty/error branch, and accessibility attribute.
- **No new dependencies.**
- Keep **dark mode** working: every light class needs its `dark:` pair (mirror the existing pattern).
- After edits the page must still `npm run lint` and `npm run build` clean.
- Don't touch files outside your assigned list.

## Definition of done (per page)
- Zero off-brand accent colors (cobalt is THE accent; emerald/amber/rose semantic only).
- Cards use warm card token + standard chrome; numbers `tabular-nums`.
- Uses shared primitives where it previously hand-rolled buttons/cards/badges.
- Visually matches the flagship Dashboard's density and polish.
- Behavior identical to before.
