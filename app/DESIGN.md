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

One categorical ramp: `#123A5E · #1F7C56 · #A8701F · #6E4FB8 · #B5322B ·
#0F6E6C · #8E4A7C · #4E5C6B`. Muted violet is permitted here and only here — as
data, never as UI chrome. **The interactive blue is not a data fill.** The accent
means interactive; two panels filled their bars with `--color-accent-500` and one
with `--color-accent-50`, a background token, at 1.05:1 on its own track. A bar,
a ranked row and a series take the ramp. Every series clears 3:1 on the canvas.
Because their greyscale spread is narrow, charts never lean on hue alone: series
carry direct labels or a legend, and lines vary dash pattern past four.

The first series was `#2F5FE0` — one step from `--color-accent-500` (`#3A6AE6`),
4.68 against its 4.09 on the canvas — so the *default* fill of every ranked bar
and every first line read as interactive, and the rule above was broken by the
token it pointed at. It is now a deep petrol navy at **10.0 on the canvas**:
twice as dark as the accent and far less saturated, so a bar cannot be mistaken
for a link, and blue keeps its categorical strength where it is genuinely useful.

| Series | Hex | Canvas |
|---|---|---|
| `--chart-1` | `#123A5E` | 10.00 |
| `--chart-2` | `#1F7C56` | 4.40 |
| `--chart-3` | `#A8701F` | 3.58 |
| `--chart-4` | `#6E4FB8` | 5.16 |
| `--chart-5` | `#B5322B` | 5.19 |
| `--chart-6` | `#0F6E6C` | 5.17 |
| `--chart-7` | `#8E4A7C` | 5.24 |
| `--chart-8` | `#4E5C6B` | 5.84 |

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

**`--surface-sunken` is a surface inside `--surface`, never on `--canvas`.**
The two are 1.8 L* apart, under the 2.4 floor the neutral ramp is spaced by, so
a sunken block on the page ground has no visible edge — the assistant's chat
bubble, painted that way on the transcript's canvas, was effectively invisible.
On white it is 4.5 L* and reads as the recess it is meant to be. A block that
must separate itself from the canvas is `--surface` with a hairline, or it
carries a border of its own.

**A disabled control has its own two fills.** `--color-control-disabled`
(`#DDD9D0`, 1.41 on white) is a disabled control that is *off*;
`--color-control-disabled-on` (`#8F8B82`, 2.41 against it) is one that is *on*.
Without the second, a disabled checked switch had no honest colour to take and
shipped as `--color-ink` at full strength — indistinguishable from a live one,
with only its label dimmed. Neither is a surface or a text token borrowed for the
job: a switch track is neither, and reaching across roles is how one token ends
up meaning two things.

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

**A dialog's grid takes `cols="pairs"`.** The card ramp's two-up step is 48rem
and a dialog body is 408–856px after its padding, so `cols={2}` can never fire
inside one — which is why four `sm:grid-cols-2` strings survived in dialogs,
asking the viewport a question only the panel can answer. `pairs` is a different
claim, not a smaller threshold on the same one: *these two fields are short and
belong on one line*, from 24rem of container. There is no three-up form of it —
three short fields on a row is a `Toolbar`.

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
left, control right, a hairline between — and the group's card is capped at
`--container-form` (672), because a list of settings is a form and a form has a
measure. Capping the *pair* stops the pair breaking; it does nothing about the
box, and on a 1945px page the hairline ran 1,300px past the control it was
underlining. The row publishes a `FieldContext`, so
its control gets `aria-describedby`, `aria-invalid` and `aria-required` from the
row rather than from ten hand-written call sites — but not the *name*: a row
heading is the row talking about the setting, and a control that names itself
keeps its own name unless the caller wires the two with `htmlFor`. Anything in a
group that is not a row — an explanation, a preview, an `Alert` — is a
`SettingBand`, which is the group's `CardBody`.

**A recess inside a card is a `Well`, never a nested `Card`.** Card-in-card is a
doubled hairline down both sides and two radii a pixel apart at all four
corners, which is the "broken corner" this rebuild is largely about. A `Well` is
8px — the card's radius less its own gutter — bordered, and sunken unless its
content already has a fill of its own.

**A number lives in a `StatRow`.** Never a lone tile, never a hand-written
`grid grid-cols-4`, and the period is stated once for the row rather than
repeated on every tile — *by the row*, in its own caption. It shipped saying it
nowhere: the strip told every tile to suppress its window and then printed
nothing in its place, so four figures stood over no period at all and three
surfaces re-stated it in a `CardHeader` eyebrow. The one number a page is *about*
is the only one that takes `size="hero"`.

**`main` is the longer column.** `Columns` is exactly as tall as its taller
side, so an aside taller than the main column leaves a large empty rectangle —
about 530px of it on Deploy at 1440. Nothing the primitive can do fills that
hole and it should not try: the hole is the layout telling the truth, and an
aside that carries the work is not an aside. Put the longer block in `main`, drop
to a `Stack`, or use `Grid` and admit the two are peers. `stickyAside` is for a
summary the reader works beside; when it is taller than the viewport it caps
itself and scrolls its own overflow, because a sticky element that has stopped
moving parks everything below the fold permanently out of reach.

**A sticky column head sticks inside its own table.** It cannot stick to the
page: the table's wrapper has to scroll X for a wide table, `overflow-x: auto`
forces `overflow-y: auto` with it, and an element sticks to its nearest scrolling
ancestor. So the head's offset is always 0, and the body is bounded
automatically past the point at which losing the column names costs the reader
something. `DataTable.stickyOffset` was a prop for an offset that can never be
right, and it rendered as an empty band at the top of the card plus a header
overlapping row 1.

**A sticky bar draws its hairline only once it is stuck.** `border-b` says "this
is floating over content"; drawn at rest and full-bleed through the page gutter
it is a rule across the whole viewport that aligns with nothing. `Toolbar`
watches a one-pixel sentinel above itself and paints the border only when the
sentinel leaves the viewport.

**A table in a narrow column takes `fit`.** The default — every cell on one
line, the table free to be wider than its box, an `overflow-auto` wrapper — is
what makes a pinned column mean anything on a wide table, and it is wrong in a
two-up grid, where the last column is simply clipped at the card's right edge
behind a scroll affordance nobody finds. `fit` switches to `table-fixed` and
ellipsises; declare a `width` on the columns that must not give.

**Breakpoints are container queries, not viewport queries.** This console has
panes. A `Grid` inside a 320px inbox pane on a 1920px monitor is one column, and
only the container knows that. `Page` declares `@container/page` and every
primitive that narrows the measure re-declares it — including **a dialog's and a
drawer's body**, which did not, so `Grid`, `Columns` and `PropertyGrid
columns={2}` walked past the panel and measured the page: a 480px drawer rendered
a two-up grid at 240px a column on a 1440px screen, and four call sites gave up
and wrote `sm:grid-cols-2`, which asks the same wrong question. `@3xl/page:`
always means "the box I am actually in is at least 768 wide", wherever it is
written.

The same query answers a shape, not only a count. `PropertyGrid` keeps a fixed
label column only above 24rem of *container*; below it the pair stacks, which is
what stops "First seen / 2 Jun 2026, 10:00" wrapping onto three lines and a URL
breaking mid-word in an 18rem aside. A component that can tell how much room it
has does not need a prop the call site has to keep in sync with its own layout.

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
- **A selected tab is marked off `aria-selected`, never off a library's
  `data-*`.** `TAB_SELECTED` keyed off `data-[selected]` while Base UI emitted
  `data-active`, so the marker matched nothing and every `Tabs` row in the
  console — Team, Integrations, `/dev/ui`'s own — rendered identical grey labels
  with `box-shadow: none`, while route-driven `NavTabs` was correct. Two tab rows
  a user must read as one control looked different from each other. `data-*` is a
  private state name that can be renamed in a minor release; `aria-selected` is
  what `role="tab"` guarantees and what the screen reader is already reading, so
  a marker keyed off it cannot go quiet without also being an accessibility bug.
  The test asserts the attribute, because a selector that never fires is
  invisible in its own diff.
- One z-ladder: sticky 10 · topbar 30 · scrim 40 · overlay 50 · toast 60 ·
  banner 70. The system this replaces put the mobile scrim and the top bar both
  on 20, with the bar later in the DOM, so the bar painted above its own scrim
  and stayed clickable. **A rung is only real on a positioned element**, and an
  overlay's z-index belongs on its positioner, not on the popup Base UI renders
  as a static child. A panel and its own backdrop never share a rung: relying on
  DOM order is the failure the ladder exists to prevent. **A raw `z-[40]` is
  banned everywhere** — `scale.test.ts` fails the build on it — because a number
  chosen inline is chosen against whatever was on screen that day and records
  nothing about what it was chosen against.
- The ladder had a **rail 20** rung with zero consumers, and could never have
  had one: the desktop rail is a grid child in normal flow with no z-index at
  all, and the mobile rail is a real dialog on `overlay`. It is gone. A rung
  nothing paints with is a claim the ladder cannot keep.
- **A must-see bar is a layout row, not an overlay.** It renders in the shell's
  banner slot above the top bar and pushes the chrome down. The impersonation
  bar was `position: fixed` at rung 70 with a `body { padding-top }` rule
  compensating — and that rule targeted two attributes the rebuilt shell does
  not have, so the bar covered the top bar and the shell hung 36px below the
  fold.
- - **An indeterminate bar stays indeterminate under `prefers-reduced-motion`.**
  It becomes a dimmed *full* track, never a stopped sliver: a 0.01ms one-shot
  ends and `translate` reverts, so the travelling sliver settled at a third of
  the track and read as a confident, determinate 33% — a false answer to the one
  question the bar exists to say it cannot answer. Crawling and training are the
  product's core async state and this is their only signal.
- **A state seated in a padded container passes `flush`.** Two gutters add up,
  and the state's copy then sits 20px inside every label around it. A table's
  empty state is forced to `inline` and `flush` by the table: a no-rows table is
  a row that says why, not a 340px poster with a 48px disc in it.

**Every surface ships loading, empty, error and forbidden.** They are one
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
   outside `tokens.css`. Also: no `disabled:opacity-*` — disabled is stated in
   tokens; no raw `z-[<number>]` — every rung comes off the ladder in §5; and no
   `leading-*` inside `src/ui` — each type rung ships its own line-height, and
   `leading-none` is the single exception, because a fixed-height inline chip
   needs *no* leading rather than a different one. Enforced by
   `src/ui/scale.test.ts`, which reads **the whole of `src/`**: it used to glob
   `src/ui` alone, so the forty thousand lines the rules actually govern were
   unguarded and a `text-3xl` walked straight through it.
2. **A feature may not define a visual primitive.** If a screen needs one that
   does not exist, it goes into `src/ui/` first. The system this replaces had
   three parallel component libraries, seven Toggle implementations, five
   drawers, six chart palettes and twelve copies of one loading block, because
   nothing owned any of them.
3. Colour is never the only signal.
4. **Mark the exception, not the rule.** A field that must be filled gets
   `aria-required` and "(required)" in its accessible name, and **no asterisk**;
   a field that may be skipped is labelled `Optional`. Marking every required
   field is the convention that carries no information in this product: almost
   every form in the console is required end to end, and the sign-in card showed
   six red asterisks that told the reader nothing they could act on. Where a form
   genuinely mixes, the shorter list is the optional one — and "Optional" is a
   word, not a glyph the reader has to have been taught.
5. No decorative iconography. An icon labels a distinct concept or it does not
   ship.
6. No pill-shaped inputs, no fully-round cards, no glass, no gradient chrome.
7. Destructive actions are `danger` **outline**, never a filled red button, and
   always confirm. A filled red button is easy to hit by accident and reads as
   the expected path; a destructive action should look like a decision.
8. Every table has sort, an empty state, a loading skeleton, a row count and a
   keyboard path.
9. A toast confirms; an alert explains. Anything the user must read in order to
   proceed stays on the page, beside the control that produced it.
10. Tooltips are a component, never the native `title` attribute — which is
   unreachable by keyboard, invisible on touch, and waits a second before it
   appears.
11. Every figure is `.figure`. Every absent value is `—`, never `0` or a blank
    cell. A count in the chrome is a figure too, and it is capped: `99+`, from
    one helper, so the same queue cannot read `9+` in the top bar and `14` in
    the rail.
12. **A destination has exactly one name, in exactly one place.** The rail
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
