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
data, never as UI chrome. Every series clears 3:1 on the canvas. Because their
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
| `2xs` | 11 / 16 | Mono eyebrows, column heads |
| `xs` | 12 / 18 | Meta, hints, captions, badges |
| `sm` | 13 / 20 | Table cells, dense UI |
| `base` | 14 / 22 | Body, inputs, buttons, card titles |
| `prose` | 14 / 24 | Running prose — transcripts, long descriptions |
| `lg` | 18 / 26 | Section headings, dialog titles |
| `xl` | 22 / 30 | Page titles |
| `2xl` | 28 / 36 | Headline figures, empty-state heroes |

Weights: 400 body · 500 UI and labels · 600 headings and emphasis. Eyebrows are
mono 11px uppercase at `--tracking-eyebrow` (0.08em).

---

## 4. Space, shape, elevation

- Base 4. Control heights and row heights are **spacing tokens**
  (`h-control-md`, `h-row`), not arbitrary values, so a button and an input on
  one row line up and the guardrail rule has nothing to make an exception for.
- Controls: `sm` 28 · `md` 34 · `lg` 40. Rows: 44, compact 36.
- Page gutter 24 / 32. `max-w-page` 1440 for dense surfaces, `max-w-reading` 896
  for settings and forms — a 1,400px-wide form puts the label and its control a
  screen apart.
- Card padding 20. Card header 16 vertical plus a hairline. Section stack 24.
  Field gap 6 between label, control and hint.
- Radii: `4` chip · `6` input and small button · `8` button and select · `10`
  card · `14` modal and drawer. Full only for avatars, badges and toggles.
- **Cards carry no shadow.** Elevation means "floating above the page, and
  dismissible", which a card is not. `--shadow-xs` is a 1px *seam* — a switch
  thumb, an active segment — and is honest about that. `md` is for menus and
  popovers, `lg` for modals and drawers.
- **Cards do not nest.** A card inside a card gives you two competing hairlines
  and forty pixels of dead gutter. Use `CardSection`.

---

## 5. Focus, motion, state

- **One focus ring: `outline`, not `box-shadow`.** The system draws structure
  with inset box-shadows — the active tab's underline, the table's hairlines, a
  switch thumb's seam — and a box-shadow ring overwrites all of them. An outline
  also follows `border-radius` on its own and is never clipped by an
  `overflow: hidden` ancestor, which a ring on a table cell always is.
- Easing `cubic-bezier(.2,.8,.2,1)`. Durations: 120 hover and press · 180 menus
  and popovers · 240 drawers and modals.
- No scroll reveals. No entrance animation on data. An operator opening this
  thirty times a day does not want the numbers arriving.
- `prefers-reduced-motion` **removes** animation rather than shortening it. A
  pulse compressed to 0.01ms strobes; an entrance compressed to 0.01ms flashes.
- One z-ladder: sticky 10 · rail 20 · topbar 30 · scrim 40 · overlay 50 · toast
  60 · banner 70. The system this replaces put the mobile scrim and the top bar
  both on 20, with the bar later in the DOM, so the bar painted above its own
  scrim and stayed clickable.
- **Every surface ships loading, empty, error and forbidden.** They are one
  decision, not four: "nothing here yet", "nothing matched your filter", "we
  could not load this" and "your plan does not include this" are different
  answers, and a single blank panel makes the reader guess which one they got.

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
    cell.

---

## 7. Where to look

- `src/ui/tokens.css` — every token, with its measured contrast.
- `src/ui/index.ts` — the public surface. If it is not exported here, it is not
  in the system.
- `/dev/ui` — the gallery. Every primitive in the states it actually ships in.
- `src/ui/scale.test.ts` — the guardrails.
- `src/ui/ui.test.tsx` — the keyboard and ARIA contracts that are invisible
  until they break.

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
