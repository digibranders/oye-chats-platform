# OyeChats Console — Design Language

The working document for how the admin console is designed and built. If a
component and this document disagree, one of them is wrong: decide which, then
change it. Nothing here is aspirational — every value is in
[`src/ui/tokens.css`](src/ui/tokens.css), and `src/ui/scale.test.ts` fails the
build if a component wanders outside it.

---

## 1. The idea

**Paper, ink, and one signal.**

The content ground is warm paper, reading surfaces are white, and structure is
drawn with hairlines rather than shadows. The navigation rail is near-black —
not a dark theme, a dark chrome element — which gives the product a silhouette
recognisable at thumbnail size and stops the rail competing with the content for
the same three greys. Colour is spent only where it carries meaning.

Four ideas hold it together:

1. **Blue means interactive.** Links, focus, selection, active nav. Nothing else.
   It deliberately does *not* also mean "in progress": a selected row that is
   also streaming would be one colour saying two things, and the inbox cannot
   afford that.
2. **In-progress is motion, not hue.** Crawling, training and streaming are
   carried by an indeterminate bar, a pulsing dot, and the brand mark's own
   three dots animating. "Live / online" is green-with-a-pulse, which every chat
   tool has already taught people to read.
3. **Every figure is mono.** Table cells, stat tiles, timestamps, money, IDs. A
   tool where every number is monospaced reads as an instrument rather than as a
   website, and it costs one class.
4. **Colour is never the only signal.** Roughly one reader in twelve cannot
   separate the success green from the danger red. Every status carries a word;
   `forced-colors` mode gets a border on every tinted surface, because Windows
   High Contrast strips backgrounds and would otherwise render all five tones
   identically.

**Light mode only, deliberately.** One theme done properly beats two done
adequately, and it makes every ground in the system a known quantity — which is
what lets the contrast table below exist at all.

Why this and not the product's previous violet: the mark is an ink-black `C`
made of three dots, a speech bubble mid-typing. The brand is not a colour, it is
a weight. Building neutral-first is what makes the four status tones mean
something, and the animated mark is a progress language nobody else can copy,
because it is derived from the logo.

---

## 2. Colour

### 2.1 Neutrals — paper and ink

Spaced by measured lightness, not by eye. Canvas → surface is 6.3 L\*, and every
interaction step clears 2.4. An earlier draft put four neutrals inside ten L\*
points, which reads as restraint on a colour-managed laptop and as a rendering
fault on the panel a support operator actually uses.

| Token | Value | L\* | Role |
|---|---|---|---|
| `--color-surface` | `#FFFFFF` | 100 | Cards, tables, drawers, menus, popovers |
| `--color-surface-hover` | `#F7F6F2` | 96.9 | Row and menu-item hover |
| `--color-surface-sunken` | `#F4F2EC` | 95.5 | Toolbars, table heads, wells, code |
| `--color-canvas` | `#EFEDE6` | 93.7 | The page ground |
| `--color-surface-active` | `#E9E6DD` | 91.3 | Pressed |
| `--color-border` | `#E2DFD7` | — | Decorative hairline **only** |
| `--color-border-strong` | `#8B877F` | — | Control boundaries |
| `--color-ink` | `#17171A` | — | Primary buttons, the rail, the mark |

`--color-border` is 1.28:1. It is a hairline between rows and around cards and
nothing else. Anything a user types into or toggles gets `--color-border-strong`,
which clears the 3:1 that WCAG 2.2 SC 1.4.11 asks of a boundary that is the only
thing telling you a control is there.

### 2.2 The rail

The rail has its own scale, because paper tokens on a near-black ground are
unreadable and would otherwise be reached for out of habit.

`--color-rail` `#17171A` · `--color-rail-hover` `#232327` · `--color-rail-active`
`#2C2C31` · `--color-rail-border` `#2E2E33` · `--color-rail-text` `#F2F0EA`
(15.70) · `--color-rail-text-muted` `#A5A099` (6.89) · `--color-rail-accent`
`#8FAAF5` (7.87).

It has a **status scale too**, for the same reason and measured the same way.
Stopping at neutrals plus one accent guaranteed the habit it was written to
prevent: six components needed a status colour on the rail and all six borrowed
a paper token, including the health dot that says a chatbot is broken —
`--color-danger-fill` measures **2.94** against `--color-rail` and fails SC
1.4.11's 3:1 for a non-text indicator, making the one dot a customer must not
miss the least visible of the four.

`--color-rail-success` `#4FC08A` (7.87) · `--color-rail-warning` `#E0A649`
(8.28) · `--color-rail-danger` `#F08279` (6.96) · `--color-rail-track` `#3A3A40`
(1.58 — a track is a felt step, not a stripe; the setup ring's unfilled arc was
drawn in `--color-rail-border` at 1.14 and could not be seen at all).

**No paper status token appears on the rail.** A count in the chrome is
`.figure`, and capped: it read `9+` in the top bar and `14` in the rail for the
same queue.

### 2.3 Signal

| Token | Value | Role |
|---|---|---|
| `--color-accent-50` | `#E9EFFD` | Selected row, focus tint |
| `--color-accent-500` | `#3A6AE6` | Fill, focus ring, active indicator |
| `--color-accent-600` | `#2B54C8` | Link text |
| `--color-accent-700` | `#1F3FA0` | Text on `--color-accent-50` |

### 2.4 Status — four tones

| Tone | Text | Fill | Tint | Means |
|---|---|---|---|---|
| success | `#1B6B4C` | `#1D7350` | `#E7F1EB` | Healthy, active, trained, paid, live |
| warning | `#8A5A16` | `#9A6A1C` | `#F9EFDD` | Pending, degraded, nearing a limit |
| danger | `#A32A28` | `#B5322B` | `#FBEAE8` | Failed, past due, over limit, destructive |
| neutral | `#5F5C56` | `#6E6A62` | `#E4E1D7` | Draft, archived, off, not applicable |

**There is no `info` hue.** An informational notice is neutral with a 3px ink
leading rule, which gives it presence without a fifth colour — and a blue one
would have collided with the interactive accent.

`--color-plan` `#755814` on `--color-plan-tint` `#F4EEDC` is a single reserved
brass, used **only** on plan, entitlement and upgrade surfaces.

### 2.5 Data

One categorical ramp: `#2F5FE0 · #1F7C56 · #A8701F · #6E4FB8 · #B5322B ·
#0F6E6C · #8E4A7C · #4E5C6B`. Muted violet is permitted here and only here — as
data, never as UI chrome. **Blue is not a data fill.** The accent means
interactive; two panels filled their bars with `--color-accent-500` and one with
`--color-accent-50`, a background token, at 1.05:1 on its own track. A bar,
a ranked row and a series take the ramp. Every series clears 3:1 on the canvas. Because their
greyscale spread is narrow, charts never lean on hue alone: series carry direct
labels or a legend, and lines vary dash pattern past four.

### 2.6 Verified contrast

Measured against `--surface`, `--canvas` and `--surface-sunken`. Nothing ships
that fails its role's bar.

| Token | White | Canvas | Sunken | Bar |
|---|---|---|---|---|
| `--text-primary` | 17.43 | 14.88 | 15.57 | 4.5 |
| `--text-secondary` | 6.66 | 5.69 | 5.95 | 4.5 |
| `--text-tertiary` | 5.38 | 4.60 | 4.81 | 4.5 |
| `--border-strong` | 3.58 | 3.05 | 3.20 | 3.0 |
| `--accent-600` | 6.55 | 5.59 | 5.85 | 4.5 |
| `--success` | 6.45 | 5.51 | 5.76 | 4.5 |
| `--warning` | 5.91 | 5.04 | 5.28 | 4.5 |
| `--danger` | 7.19 | 6.14 | 6.43 | 4.5 |
| `--plan` | 6.64 | 5.67 | 5.93 | 4.5 |

White on fills: ink 17.89 · accent 4.79 · success 5.80 · danger 6.08 · warning
4.72. Status text on its own tint: success 5.59 · warning 5.18 · danger 6.18 ·
accent 8.01 · neutral 5.09 · plan 5.73.

**An opacity modifier on a text token is banned.** A ratio measured at full
strength does not survive `/70`; that is how the previous system's most-used
text colour ended up at 2.56:1 across 505 uses. `scale.test.ts` enforces it.

---

## 3. Typography

Inter for text, Geist Mono for figures, eyebrows, identifiers and code. Inter
rather than something more fashionable because the system leans on two of its
features: `cv11` straightens the `l` so it cannot be read as a `1` in an API key,
and `ss01` gives the single-storey alternates. Both faces are actually fetched —
declaring a face the page never loads is just a wrong spec.

Seven rungs, each with exactly one job. A size outside this list is a defect,
not a choice: `text-md` is not a Tailwind default either, so a component
reaching for one silently renders at the inherited body size — which is how two
dialog titles and every section heading shipped wrong before the guardrail test
existed.

| Rung | Size / line | Job |
|---|---|---|
| `2xs` | 11 / 16 | Mono eyebrows and column *groups* |
| `xs` | 12 / 18 | Meta, hints, captions, badges |
| `sm` | 13 / 20 | Table cells, dense UI |
| `base` | 14 / 22 | Body, inputs, buttons, card titles |
| `prose` | 14 / 24 | Running prose — transcripts, long descriptions |
| `lg` | 18 / 26 | Section headings, dialog titles |
| `xl` | 22 / 30 | Page titles |
| `2xl` | 28 / 36 | Headline figures, empty-state heroes |

Weights: 400 body · 500 UI and labels · 600 headings and emphasis. Eyebrows are
mono 11px uppercase at `--tracking-eyebrow` (0.08em).

**A column head is not an eyebrow.** It is 12px Inter, sentence case. Mono
uppercase across twelve columns was the single most magazine-like element on the
console's most important surface, and at the same padding as the cells it
labelled it did not even align with them: mono side bearings plus 0.08em of
tracking put the header a pixel off the figures under it. `Eyebrow` keeps the
rung for card headers and for column *groups*.

---

## 4. Space, shape, elevation

- Base 4. Control heights and row heights are **spacing tokens**
  (`h-control-md`, `h-row`), not arbitrary values, so a button and an input on
  one row line up and the guardrail rule has nothing to make an exception for.
- Controls: `sm` 28 · `md` 34 · `lg` 40. Rows: 44, compact 36.
- Page gutter 24 / 32, from one token pair (`--spacing-gutter`,
  `--spacing-gutter-lg`) that the page, the top bar and the shell's banners all
  read. `max-w-page` 1440 is the widest content column. A narrower measure is a
  property of the *content*, never of the page: `Measure` gives a form 672 and
  long-form help 896, and the page keeps one left edge at every route.
- Card padding 20. Card header 16 vertical plus a hairline. Section stack 24.
  Field gap 6 between label, control and hint.
- Radii: `4` chip and badge · `6` small control · `8` medium and large control ·
  `10` card and floating panel · `14` modal; a drawer anchored to an edge is
  square on those edges and `14` on its leading one. Full only for avatars,
  status dots and toggles. Radius is a function of control **size**, not control
  type, so a button and an input on one toolbar row are one set.
- A progress or ranked-bar **track** is `rounded-xs`. A fully round track reads
  as a pill, and at 4px tall the radius is doing nothing anyone can see.
- An icon's size is derived from the control that holds it, never chosen at the
  call site.
- A name and the sentence explaining it are 4px apart inside one control; 6px is
  the `Field`'s label → control → hint chain and nothing else.
- Overlay padding is one contract: header 20/16 plus a hairline, body 20 all
  round, footer 20/12 on sunken.
- A `Select`'s closed control is ours; its **open list is platform chrome** and
  ignores every token here. That is the accepted price of a native select.
- **Cards carry no shadow.** Elevation means "floating above the page, and
  dismissible", which a card is not. `--shadow-xs` is a 1px *seam* — a switch
  thumb, an active segment — and is honest about that. `md` is for menus and
  popovers, `lg` for modals and drawers.
- **Cards do not nest**, and the rule is wider than it reads. A `Card` whose
  entire body is an `Alert` (`rounded-md border`), a `DataTable`
  (`rounded-lg border`) or a `LockedState` is the same defect: two competing
  hairlines and two concentric radii a pixel apart. Use `CardSection` for a
  band inside a card, `seated` + `CardBody flush` for a table, and
  `size="panel"` for a state.
- **The chrome grid.** The rail's icon column is at x=18 with a 16px optical
  box; every rail glyph — icon, health dot, progress ring, brand mark —
  occupies it. The rail's label column is at x=44. Group labels and any control
  spanning the rail start at 18, on the glyph column. The top bar shares the
  page's gutter, so the breadcrumb and the page title stand on one line. Rail
  rows are `h-9` (36); the identity row is `--spacing-row` (44) and is the only
  exception. Both consoles get this from `RailFrame`, because two shells owning
  their own geometry drifted 22px apart.

---

### 4.1 Composition

The first version of this document specified colour, type, shape and space, and
then left the arrangement of a page to whoever wrote it. That omission produced
the console's worst quality: a token layer and a primitive layer with no layout
layer, so `Stack` — `flex-col gap-6`, one column, forever — became the default
composition for the whole product. Eighty-eight hand-written `grid-cols-*`
strings grew in `features/` around it, and every page whose author did not write
one became a single column of full-width cards. The review of the result put it
plainly: it read as a magazine, not as an instrument.

**A page is a grid, not a stack.** `Stack` sets the vertical rhythm *between*
sections. It is not how peers are arranged. Two or more cards answering the same
question at the same altitude belong in a `Grid`. A form beside a summary or a
live preview is `Columns`. A list and its detail is `SplitPane`, both panes
mounted, so scroll position and half-written replies survive. A secondary nav
beside its content is `SidebarLayout`. If a page renders more than three `Stack`
children in a row and none of them is a table, it is wrong.

**A pair is a pair.** A label and its control, a term and its value, a bar and
its figure — these bind visually only while they are close. Stretched across a
1440px card by `justify-between` they stop being a pair and the middle of the
row becomes a hole; the console shipped a switch 1,540px from the label naming
it. Every such row is capped at `--container-pair` (640).

**A record is a `PropertyGrid`, not a paragraph.** Any run of label→value facts
is hairline rows, one or two columns, `—` for an absent value. Prose describing
a record is deleted, not styled.

**A setting is a `SettingRow`, not a card.** A card per setting costs about
130px of chrome to present one control. A run of them is a `SettingGroup`: name
left, control right, a hairline between.

**A number lives in a `StatRow`.** Never a lone tile, never a hand-written
`grid grid-cols-4`, and the period is stated once for the row rather than
repeated on every tile. The one number a page is *about* is the only one that
takes `size="hero"`.

**Breakpoints are container queries, not viewport queries.** This console has
panes. A `Grid` inside a 320px inbox pane on a 1920px monitor is one column, and
only the container knows that. `Page` declares `@container/page` and every
primitive that narrows the measure re-declares it, so `@3xl/page:` always means
"the box I am actually in is at least 768 wide", wherever it is written.

**The page box never moves.** `Page` is left-anchored. It used to be `mx-auto`,
so navigating from a wide page to a narrow one slid the title, the tab row and
every card 148px right at 1440 and 388px at 1920, and back again — the app had
no stable left edge, which is the single most visible cause of "the arrangement
of pages is broken". A reading measure is `Measure`, and `Measure` is never
`mx-auto` either.

**A card's chrome is proportional to its content.** A widget card gets a 40px
header (`CardHeader size="sm"`, no eyebrow, no hairline). A section card gets a
68px one. Nothing gets 98.

**A description earns its line or it is deleted.** It may not restate its own
title, may not repeat a sibling hint, and never exceeds one clause. Anything
longer is a `Tooltip` on the label, or it does not need saying. The console
carried about 610 of them — 101 of its 103 card headers among them — and roughly
four hundred said nothing the title had not already said. No copy tells the
reader to scroll.

---

## 5. Focus, motion, state

- **One focus ring: `outline`, not `box-shadow`.** The system draws structure
  with inset box-shadows — the active tab's underline, the table's hairlines, a
  switch thumb's seam — and a box-shadow ring overwrites all of them. An outline
  also follows `border-radius` on its own and takes no layout space, which a
  box-shadow ring does not. It **is** still painted inside an `overflow`
  ancestor's clip rect, like any other ink — so a control at the edge of a
  scrolling panel needs inset room for its ring. `PopoverBody` carries 20px
  because of it, and a scrolling table sets `outline-offset: -2px`. The earlier
  claim here that an outline "is never clipped" was simply wrong, and it was
  licensing scroll containers that clip focus rings.
- Easing `cubic-bezier(.2,.8,.2,1)`. Durations: 120 hover and press · 180 menus
  and popovers · 240 drawers and modals.
- No scroll reveals. No entrance animation on data. An operator opening this
  thirty times a day does not want the numbers arriving.
- `prefers-reduced-motion` **removes** animation rather than shortening it. A
  pulse compressed to 0.01ms strobes; an entrance compressed to 0.01ms flashes.
- One z-ladder: sticky 10 · rail 20 · topbar 30 · scrim 40 · overlay 50 · toast
  60 · banner 70. The system this replaces put the mobile scrim and the top bar
  both on 20, with the bar later in the DOM, so the bar painted above its own
  scrim and stayed clickable. **A rung is only real on a positioned element**,
  and an overlay's z-index belongs on its positioner, not on the popup Base UI
  renders as a static child. A panel and its own backdrop never share a rung:
  relying on DOM order is the failure the ladder exists to prevent.
- **A must-see bar is a layout row, not an overlay.** It renders in the shell's
  banner slot above the top bar and pushes the chrome down. The impersonation
  bar was `position: fixed` at rung 70 with a `body { padding-top }` rule
  compensating — and that rule targeted two attributes the rebuilt shell does
  not have, so the bar covered the top bar and the shell hung 36px below the
  fold.
- **Every surface ships loading, empty, error and forbidden.** They are one
  decision, not four: "nothing here yet", "nothing matched your filter", "we
  could not load this" and "your plan does not include this" are different
  answers, and a single blank panel makes the reader guess which one they got.
  A state **seated in a card matches the card's gutter** (`--spacing-cell`); an
  inline state is left-aligned and drawn at row scale, because a table that
  returned no rows is not a poster. A **route-level** 403 is a page of its own,
  never a silent `<Navigate>` — a redirect throws away the address the reader
  asked for and tells them nothing about why.

---

## 6. Rules

1. No raw hex, no arbitrary font size, no opacity modifier on a text token,
   outside `tokens.css`. Enforced by `src/ui/scale.test.ts`.
2. **A feature may not define a visual primitive.** If a screen needs one that
   does not exist, it goes into `src/ui/` first. The system this replaces had
   three parallel component libraries, seven Toggle implementations, five
   drawers, six chart palettes and twelve copies of one loading block, because
   nothing owned any of them.
3. Colour is never the only signal.
4. No decorative iconography. An icon labels a distinct concept or it does not
   ship.
5. No pill-shaped inputs, no fully-round cards, no glass, no gradient chrome.
6. Destructive actions are `danger` **outline**, never a filled red button, and
   always confirm. A filled red button is easy to hit by accident and reads as
   the expected path; a destructive action should look like a decision.
7. Every table has sort, an empty state, a loading skeleton, a row count and a
   keyboard path.
8. A toast confirms; an alert explains. Anything the user must read in order to
   proceed stays on the page, beside the control that produced it.
9. Tooltips are a component, never the native `title` attribute — which is
   unreachable by keyboard, invisible on touch, and waits a second before it
   appears.
10. Every figure is `.figure`. Every absent value is `—`, never `0` or a blank
    cell. A count in the chrome is a figure too, and it is capped: `99+`, from
    one helper, so the same queue cannot read `9+` in the top bar and `14` in
    the rail.
11. **A destination has exactly one name, in exactly one place.** The rail
    printed "Chatbots" as a nav row and again forty pixels below as the label of
    the group listing them; the account menu offered two items that opened the
    identical screen, and a third that 404'd. A trail that names the wrong page
    is worse than a short one — the last crumb carries `aria-current="page"`,
    so it is read aloud as the answer to "where am I".

---

## 7. Where to look

- `src/ui/tokens.css` — every token, with its measured contrast.
- `src/ui/index.ts` — the public surface. If it is not exported here, it is not
  in the system.
- `/dev/ui` — the gallery. Every primitive in the states it actually ships in.
- `src/ui/scale.test.ts` — the guardrails.
- `src/ui/ui.test.tsx` — the keyboard and ARIA contracts that are invisible
  until they break.
- `src/shell/shell.test.tsx` — the chrome's own guardrails: no Tailwind default
  palette anywhere in the shell (`--color-*: initial` deletes it, so it compiles
  to nothing and renders invisible), no paper status token on the ink rail, and
  the breadcrumb's answer at every route shape.

---

## Addenda from the build

Three things the system learned by being used, recorded here so the reasoning
survives the commits.

**A ranked bar row is not a progress bar.** `Progress` answers "how far through
is this?" and `Meter` answers "how much of my allowance is gone?" — both are one
quantity against a known ceiling, and both carry ARIA semantics that are wrong
for a comparison between peers. Top questions, funnel stages, a ratings
distribution and page influence are peers. They get `RankedBars`: a label, a
proportional bar, a figure, and every value stated in text so the chart survives
being printed, read aloud, or rendered with its colours stripped.

**A table that pages on the server says so.** `DataTable` takes
`page`/`onPageChange`/`rowCount` beside `pageSize`. Without them, a surface
holding one request's worth of rows renders a client-side pager reading "1–50 of
50" for a workspace with nine thousand. It also refuses to sort a server-paged
page client-side: ordering fifty rows out of nine thousand and presenting it as
"sorted by name" is a lie the table will not tell.

**A primitive's accessible name is only testable at the call site.** Four
defects shipped invisible in their own diffs and only wrong where they were
used: a checkbox whose label was wired to an id that exists only inside a
`Field`; a `Progress` labelling the element next to the one carrying
`role="progressbar"`; three `CodeBlock` copy buttons all named "Copy"; and a
`Tooltip` whose trigger was a fragment, so Base UI's handlers were dropped and
no tooltip in the app had ever opened. Each now has a test that renders the
primitive the way a feature does, not the way its author imagined.

**A choice that needs a sentence is not a segmented control.** `SegmentedControl`
has room for a label and nothing else, which is right for a status filter and
wrong the moment an option needs explaining — three surfaces hit that wall and
each worked around it differently. `RadioCards` is the APG radiogroup with room
to read: one tab stop, arrow keys inside it, and each card named by its label
alone with the description wired as a description. Naming it by its contents
folds the explanation into the accessible name, which is the defect the control
exists to avoid.

**One save bar.** It had been written three times, once per editable surface,
with three different contracts — the exact duplication this directory exists to
prevent. `SaveBar` carries all of it: what changed (named, not merely
acknowledged), a failed save beside the button that produced it, a specific
reason when saving is blocked, and the navigation guard. Two forms: `footer`
anchors to a card and is **always** rendered, because a footer that appears on
the first keystroke pushes the card down while the user is typing in it;
`sticky` floats and so appears only when there is something to save. The
router-dependent half is a separate component, so a form that opted out of the
guard does not inherit a data-router requirement.

**One disclosure.** A button carrying `aria-expanded` over a labelled `region`,
optionally wrapped in a heading so a log of a hundred collapsed rows is navigable
by heading — which is the whole reason the rows are collapsed. The panel is
unmounted rather than hidden: a hidden subtree keeps its focusable children in
the tab order unless every one of them is disabled. The one place a native
`<details>` is still right is content that must stay findable by the browser's
own in-page search while collapsed, and `ErrorDetails` makes exactly that case
for a stack trace, in writing.

**`Dialog` takes an eyebrow.** The upgrade intents carry a contextual sentence
that belongs above the title — "You already have one chatbot on Free". It is set
in sentence case at full size, not in the mono uppercase `Eyebrow`, because
these are sentences and 11px uppercase mono mangles a sentence.

**The chrome is one component, drawn twice.** There are two consoles — the
customer's and the platform's — and they were the same 248px column with two
different interiors: a 56px header against a 52px one, a bottom border against
none, a 12px inset against 16, 8px of nav padding against none, and an active
state with an accent rule against one without. A super-admin crosses between
them constantly and every crossing moved the content start by 22px. `RailFrame`,
`RailItem`, `RailGroupLabel` and `RailBackLink` own that geometry now, in
`src/ui/`, because two shells consuming one frame cannot drift and two shells
each owning their own always will.

**A class that compiles to nothing looks exactly like a class that works.**
`tokens.css` opens its `@theme` with `--color-*: initial`, which deletes all
twenty-two of Tailwind's default palettes — `white` and `black` included, since
they live in the same namespace. The impersonation bar reached for `bg-rose-600`,
`text-white` and `bg-white/15`, and the built stylesheet contained none of them:
the one bar in the product whose stated job is to make a support session
impossible to forget rendered as a transparent strip with near-black text, and
nothing in its source said so. Reading the diff could not catch it. A guardrail
test over the shell's own source can, and does.
