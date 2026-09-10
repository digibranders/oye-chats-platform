# Command palette: settings search

**Date:** 2026-09-10
**Status:** approved, not implemented

## The problem

`⌘K` finds destinations (the rail's seven items) and chatbots. It finds
nothing that lives *inside* a page. Searching "business hour" returns "No
match", although Business Hours is a real, named field on every chatbot's
Experience tab.

This is not a matching bug. Base UI's combobox already does case-insensitive
substring matching (`Intl.Collator`-based), and "business hour" is a literal
substring of "business hours". The defect is coverage: nothing in the
palette's searchable universe contains the words "business" or "hours"
anywhere, because the palette only ever indexed `WORKSPACE_NAV`, `AGENT_NAV`
and chatbot names (`app/src/shell/CommandPalette.tsx`, `app/src/shell/nav.ts`).
The same is true of "API key", "webhook", "allowed domains", and roughly
thirty other things a customer would type the name of rather than browse to.

A second, separate gap exists: the palette cannot find a *record* — a
specific lead, conversation, invoice or document. `CommandPalette.tsx`'s own
docstring already says so and files it as later work: that needs a live
backend query (`/leads?q=`, `/sessions?q=`) against per-account data, not a
fixed list, and is explicitly **out of scope here**. This spec is settings and
features only.

## What is not the problem

The palette's default matching (`Intl.Collator`-based substring scan) is
adequate for exact phrases and already handles case and accents correctly.
What it does not do: match word-order-independent queries ("hours chatbot"
against "Business Hours"), or recognise a synonym the product's own copy
doesn't use verbatim ("opening times" for "Business Hours"). Both are cheap to
fix and are covered below. Typo tolerance ("buisness hours") is explicitly
**not** part of this pass — no fuzzy/edit-distance matching, no new
dependency.

## Design

### One new index, next to the one that already exists

`app/src/shell/nav.ts` already states its own principle: `WORKSPACE_NAV` is
"the canonical list of workspace destinations... a destination missing from
here is a destination the product cannot find." `searchIndex.ts` extends that
principle one level deeper, to things *inside* a destination rather than the
destination itself.

```ts
// app/src/shell/searchIndex.ts

export interface SettingItem {
  id: string;
  /** What the customer calls it. Matches product copy, not code. */
  label: string;
  /** One line, for the palette row — same role as NavItem.hint. */
  hint: string;
  icon: LucideIcon;
  /** Extra terms the filter matches but which are never rendered:
   *  synonyms, and the copy this codebase uses elsewhere for the same idea. */
  keywords: string;
}

export interface WorkspaceSettingItem extends SettingItem {
  /** Static: the same URL for every workspace. */
  to: string;
}

export interface AgentSettingItem extends SettingItem {
  /** Appended to `/chatbots/:agentId`, exactly like AgentNavItem.segment. */
  segment: string;
}

export const WORKSPACE_SETTINGS: readonly WorkspaceSettingItem[] = [ /* ... */ ];
export const AGENT_SETTINGS: readonly AgentSettingItem[] = [ /* ... */ ];
```

`CommandPalette.tsx` consumes both exactly the way it already consumes
`WORKSPACE_NAV` and `AGENT_NAV`: `WORKSPACE_SETTINGS` becomes one command per
entry; `AGENT_SETTINGS` runs through the *same* `bots.flatMap(...)` that
already expands `AGENT_NAV` per chatbot, producing one row per (bot, setting)
labelled `"{Bot name} — {label}"` — identical convention to the existing
`"{Bot name} — {tab label}"` rows, so nothing new is invented.

**No per-field landing.** Every entry's target is the page it lives on
(`to` or `agentPath(bot.id, segment)`), the same granularity every other
palette result already lands on. Picking "Business Hours" opens Experience,
the same page clicking the rail's Experience item opens. A tabbed page
(Integrations, Team) gets its tab in the URL — `?tab=webhooks` — since those
pages already read the tab from `useSearchParams()` for exactly this reason
(a support conversation can already link straight at one).

### Matching: every query word, any order

`itemToStringValue` already concatenates `label + hint + keywords` into one
string per command — that mechanism is unchanged. What changes is the
comparison Base UI runs against it. Its default `contains` is a single
whole-query substring scan (confirmed by reading
`@base-ui/react/internals/filter.mjs`): one literal slice of the query, tested
once against one slice of the item. "hours business" would not match "Business
Hours" under that rule, only "business hours" would.

The palette passes its own function to Base UI's `filter` prop instead:
split the query on whitespace, and require every resulting word to appear
*somewhere* in the item string, in any order. Built on the same
`Intl.Collator`-backed `contains` Base UI already uses internally (via
`useFilter`), so case-insensitivity and accent-folding are unchanged — only
the "one slice, one order" constraint is lifted.

```ts
// app/src/shell/paletteFilter.ts
export function makePaletteFilter(coreContains: CoreFilter['contains']) {
  return function paletteFilter(item: Command, query: string, itemToString?: ...) {
    const words = query.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    return words.every((word) => coreContains(item, word, itemToString));
  };
}
```

### A new group: "Settings"

Appended after "Chatbots" — the two existing groups (`Go to`, `Chatbots`)
keep their current order and current behaviour unchanged; this is pure
addition. Each row's icon is inherited from the page it belongs to (a
Business Hours row carries Experience's `MessagesSquare`, an API Key row
carries Developers' new `KeyRound`), keeping the palette's existing rule that
icon means "which page", not "what kind of row".

### The launch set

Walked every Settings sub-page and every agent tab once, by reading real
section headers already in the product's own copy (`CardHeader title={t(...)
|| '...'}` fallback strings), rather than inventing labels. This is the
reviewable inventory — add, cut or relabel anything below before it is built.

**Workspace** (`WORKSPACE_SETTINGS`, icon per group):

| Label | Target | Icon |
|---|---|---|
| Workspace name | `/settings/workspace` | `Building2` |
| Invite a teammate | `/settings/team?tab=invitations` | `Users` |
| Departments | `/settings/team?tab=departments` | `Users` |
| Live chat queue and wait time | `/settings/team?tab=routing` | `Users` |
| API key | `/settings/developers` | `KeyRound` |
| Webhooks | `/settings/integrations?tab=webhooks` | `Webhook` |
| Email notifications | `/settings/integrations?tab=email` | `Plug` |
| Meeting booking | `/settings/integrations?tab=meetings` | `Plug` |
| Affiliate / partner programme | `/settings/affiliate` | `Handshake` |

**Per chatbot** (`AGENT_SETTINGS`, icon = parent tab's existing icon):

| Label | Segment | Tab icon |
|---|---|---|
| Business Hours | `experience` | `MessagesSquare` |
| Widget colours | `experience` | `MessagesSquare` |
| Chatbot avatar | `experience` | `MessagesSquare` |
| Credit line / remove branding | `experience` | `MessagesSquare` |
| Language | `experience` | `MessagesSquare` |
| Talking to a person (handoff) | `experience` | `MessagesSquare` |
| Pre-chat form | `experience` | `MessagesSquare` |
| Chatbot name | `experience` | `MessagesSquare` |
| Greeting message | `experience` | `MessagesSquare` |
| Suggested questions | `experience` | `MessagesSquare` |
| Widget copy | `experience` | `MessagesSquare` |
| Persona | `behaviour` | `Settings2` |
| Voice | `behaviour` | `Settings2` |
| Scope (what it can talk about) | `behaviour` | `Settings2` |
| Smart links | `behaviour` | `Settings2` |
| Lead enrichment | `behaviour` | `Settings2` |
| Scoring dimensions | `qualification` | `Target` |
| Tier thresholds | `qualification` | `Target` |
| Tier outcomes | `qualification` | `Target` |
| Score decay / timing | `qualification` | `Target` |
| Behavioural points | `qualification` | `Target` |
| Currency | `quotation` | `Receipt` |
| When to send the quotation | `quotation` | `Receipt` |
| When to offer a quote | `quotation` | `Receipt` |
| Allowed domains | `deploy` | `Globe` |
| Demo link | `deploy` | `Globe` |
| Install / embed code | `deploy` | `Globe` |
| Auto-retrain | `knowledge` | `Brain` |
| Sources | `knowledge` | `Brain` |
| Knowledge gaps | `knowledge` | `Brain` |

39 entries total (9 workspace + 30 per-bot). New icon imports:
`KeyRound`, `Webhook`, `Handshake` (all exist in `lucide-react`, confirmed
against its type exports; `Plug` is already imported elsewhere in the app).

### Translation, following the existing rule exactly

`nav.ts` states this already, at the top of the file: it is evaluated at
import time, before any locale exists, so its English strings are lookup
*keys*, not copy — `navCopy.ts` derives `app.crumb.*` / `nav.hint.*` from each
label and resolves the translation at render. Translating the array in place
would silently orphan every existing Hindi/Arabic string.

`searchIndex.ts` is a module constant with the identical problem, so it
follows the identical fix: `navCopy.ts` gains `settingLabel` / `settingHint`
resolvers alongside the ones it already exports, keyed the same way, and
`CommandPalette.tsx` calls them when building each row exactly as it already
calls `navLabel` / `navHint`. Labels and hints render in the dashboard's
active language, unchanged from how every other palette row already behaves.

**`keywords` is the one deliberate exception, and it is a real, named
limitation, not an oversight.** It is never rendered, so it carries no
translation-orphaning risk, but it also is not translated: it stays the
English synonym list shown in the table above. A workspace running the
dashboard in Hindi still sees "Business Hours" in Hindi and still reaches it
by typing the English words in the table. Typing the Hindi word for it will
not match. Localized keywords are a reasonable follow-up; they are not free
(every entry needs a reviewed translation, not a machine one, or the search
degrades instead of improving), so they are out of scope for this pass and
named here rather than silently absent.

### Keywords, by example

Each entry's `keywords` carries product-copy synonyms, not invented jargon:

```ts
{
  id: 'business-hours',
  label: 'Business Hours',
  hint: "When the chatbot's people are around",
  icon: MessagesSquare,
  segment: 'experience',
  keywords: 'availability online offline opening times staffed when someone is there',
}
```

## Testing

- `paletteFilter.test.ts`: word-order independence ("hours business" matches
  "Business Hours"), synonym match via keywords, empty query passes
  everything, a query with no matching word returns false.
- `CommandPalette.test.tsx`: "business hour" surfaces a "Settings" group
  containing "Business Hours"; a per-bot setting is expanded once per bot
  when unscoped, labelled `"{Bot name} — {label}"`; picking a workspace
  setting navigates to its exact URL including `?tab=`; the "Settings" group
  renders after "Chatbots" and before nothing (last).
- A source-level test, matching the existing convention in this codebase for
  "this list is the single source of truth" invariants (see
  `api/tests/test_waiting_since_stamp.py`'s AST-based guard for a Python
  example): every `to` and every `segment` in `searchIndex.ts` must resolve to
  a route that actually exists in `app/src/app/routes.tsx`, so a renamed or
  removed page fails a test instead of shipping a dead palette result.

## Out of scope

- Records search (leads, conversations, documents, invoices) — needs a
  backend query, filed as the palette's own docstring already says.
- Typo/fuzzy tolerance.
- Scrolling to or highlighting the specific field once landed on its page.
- Per-department business hours (`BusinessHoursEditor.tsx`, opened from a
  dialog inside `DepartmentDialog.tsx`) — no stable destination URL exists to
  land on without first picking a department, so it has no palette entry.
