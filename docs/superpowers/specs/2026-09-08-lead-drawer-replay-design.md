# Lead conversation drawer: a replay of what the visitor saw

**Status:** approved 2026-09-08. Implementation follows this document.

## The problem

The Leads drawer's Conversation tab renders a transcript nobody can read
comfortably. Six defects, in order of damage:

1. **Four lines of chrome before the first word.** Eyebrow, name, subtitle, tab
   row: 118px spent saying "Lead / Siddique" three ways. The inbox puts the same
   person on screen in 56px.
2. **A label inside every bubble.** `CHATBOT 10:56` in uppercase mono sits above
   all 23 messages. The label rung is louder than the message it labels, and a
   clock that moves by one minute is repeated as though it were new information.
   This is the main reason the panel reads as cluttered.
3. **Speakers on inconsistent sides.** The visitor is right, the operator is a
   grey box on the left. It matches neither the widget (where the visitor is
   right and everyone else is left, bubble-less) nor the inbox (where the
   operator is right in ink).
4. **Three near-identical greys.** Visitor on `surface-sunken`, operator on
   `neutral-tint`, chatbot on `surface` with a hairline. Nothing separates a
   person from the AI at a glance.
5. **No grouping.** "hello / are you there? / hello" is one visitor thought in
   three bubbles, each labelled and clocked, each spaced as though the speaker
   had changed.
6. **A second transcript renderer.** `LeadDrawer` ships its own `Bubble` with no
   grouping, no avatars, no day-aware spacing, while the inbox's `Transcript`
   and the Experience page's `WidgetMock` each have their own. Three renderers,
   already drifting. `app/CLAUDE.md` forbids a feature defining a primitive.

Smaller, fixed by the same work: the transcript scrolls the whole drawer body so
the tab row scrolls away with it; "Load earlier" is a full button where a text
link belongs; the audit trail is a separate collapsed section under the last
message; the panel is a fixed 768px on every screen.

## The decision

**The drawer is a replay of what the visitor saw**, not a console-perspective
transcript. It is a record of a conversation that happened on the customer's
website, so it is drawn with the widget's anatomy:

- the visitor's turns are right-aligned bubbles in the chatbot's own
  `user_bubble_color`;
- the AI's turns are its avatar plus rendered markdown, **no bubble**;
- an operator's turns are the operator's name in the chatbot's primary colour
  plus plain text, **no bubble**.

The console's inbox keeps its own perspective (operator right, in ink); that is
correct there because "me" is a different person on that screen.

## What ships

### 1. `WidgetTranscript`, one shared renderer

New, in the design system at `app/src/ui/chat/`. `widgetTheme.ts`, `PremiumOrb`
and the widget avatar move there with it; the Experience page imports them from
their new home.

Props:

- `appearance: WidgetAppearance` — `primaryColor`, `userBubbleColor`,
  `avatarType`, `botLogo`, `orbColor`.
- `messages: readonly WidgetMessage[]` — `{ key, role, text, at?, file? }` where
  `role` is `visitor | bot | operator | system`. Deliberately not the API's
  shape: two endpoints disagree on the timestamp field and neither knows about
  audit rows.
- `operatorName?: string | null` — falls back to "Operator".
- `showTimes?: boolean` — off for the live preview, on for the record.

It owns grouping, the half-gap within a run, one timestamp per run, day
dividers, system lines, markdown for `bot` only, verbatim text for people, file
and image rendering, and the avatar (orb / upload / mascot).

Exports `appearanceFromBot(bot)` and `DEFAULT_APPEARANCE` for a chatbot that no
longer exists.

**A drift this fixes:** `WidgetMock` draws the visitor bubble at 16px radius;
the shipped widget uses 8. The shared component takes the widget's value, so the
Experience preview becomes more accurate as a side effect.

### 2. `WidgetMock` becomes a consumer

It keeps its stage, header, identity badge, starter chips, composer, typing pill
and launcher, and hands its message list to `WidgetTranscript`. `BotRow` and
`UserBubble` are deleted. `experience.test.tsx` (29 cases) is the safety net.

### 3. A resizable `Drawer`

`Drawer` gains `resizable`, `storageKey` and bounds, through a new
`useResizeHandle` hook extracted from `SplitPane`. `SplitPane` is refactored onto
the same hook, so the console has exactly one drag separator: `role="separator"`,
arrow keys 16px, shift-arrow 64, Home and End to the stops, value announced in
pixels, RTL-aware.

- Stops: 512 minimum, `viewport - rail - gutter` maximum, so the table behind
  never disappears entirely.
- Width persists per user in `localStorage`; storage failure degrades to a
  session-only drag, as `SplitPane` already does.
- Below `sm` the drawer is full-width and the handle is not rendered.

`Drawer` also gains `headerHairline={false}`, so a tab row can serve as the
header's bottom edge instead of drawing a second rule 40px below the first.

### 4. `LeadDrawer`

- Eyebrow removed. Subtitle becomes `company · <chatbot> chatbot · last active`,
  because the colours and avatar below belong to that chatbot and the reader
  should know whose site they are looking at.
- The tab list is fixed; the tab panel is the scroller. Chrome drops from ~118px
  to ~88px.
- `Bubble` and `LeadAuditTrail` are deleted.
- The Profile tab is unchanged.

### 5. The replay itself

`replayMessages(history, audit, labels)` — a pure function — maps history rows
to `WidgetMessage` and interleaves audit entries as `system` rows at their
`created_at`, sorted by time, keyed `audit-<id>`. "Requested a person",
"Operator joined", "Closed" become quiet centred lines at the moment they
happened, which is also how the widget shows them to the visitor.

The audit query moves into `useLeadDetail` beside the three reads already there.
Appearance comes from the bot context via `appearanceFromBot`. `user_bubble_color`
is added to the `Bot` type: the API already sends it and the type does not
declare it.

The panel opens scrolled to the newest message. Loading an earlier page keeps the
reader anchored on the message they were looking at.

**One deliberate departure from the widget:** the widget shows no clocks at all.
A record needs them, so each *run* ends with a 10px mono timestamp, and day
dividers separate days. Twenty-three clocks become about nine.

## Failure modes

| What fails | What the reader gets |
|---|---|
| Lead record | `ErrorState` replaces the tabs, with retry. As today. |
| Transcript | `ErrorState` inside the panel, tabs stay usable. |
| Audit trail | System lines are absent. No error: they are annotation. |
| Chatbot deleted | `DEFAULT_APPEARANCE`; the subtitle omits the name. |
| `localStorage` blocked | The drag works for the session, nothing is remembered. |

## Tests

- `WidgetTranscript.test.tsx` — bubble colour and side per role; markdown
  rendered for `bot` and never for a person; operator name in the primary
  colour; one timestamp per run; half gap within a run; day divider; system
  line; file and image; defaults when appearance is missing.
- `useResizeHandle` / `Drawer` — arrow, shift-arrow, Home, End, clamping,
  persistence, storage failure. `SplitPane`'s existing tests must stay green on
  the shared hook.
- `replayMessages` — interleaving order, both timestamp field names, unknown
  audit action falls back to its de-underscored name.
- `LeadsPage.test.tsx` — the replay renders, audit rows interleave, no eyebrow.
- `leads-drawer.spec.ts` (browser) — dragging changes the width and it survives
  a reload; the transcript scrolls inside the panel with the tab row still
  visible, asserted with the same zero-overflow check used for the inbox.
- New strings in `en`, `hi` and `ar`; `/dev/ui` entries for the transcript and
  the resizable drawer.
