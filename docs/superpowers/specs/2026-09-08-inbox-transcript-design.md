# The inbox transcript: a timestamp bug, and the AI without a bubble

**Status:** approved, ready to build
**Date:** 2026-09-08
**Surface:** `app/src/features/inbox/` (the live-chat operator console)

## Why

An operator reading an AI-handled conversation sees sixteen boxes in one
column: an avatar beside every single message, not one clock anywhere, no day
divider, and two speakers separated by 1.8 L* of fill. It reads as a wall.

Most of that is one defect, not five design mistakes.

## The defect

`parseHistoryMessage` (`liveChatHelpers.ts:68`) reads `m.created_at`.
`GET /chat/history` serialises the field as `timestamp`
(`api/app/api/chat_routes.py:2463`). Every message restored from history
therefore gets `timestamp: null` — which is every message in a Waiting or
AI-handled conversation, and the whole first page of a live one.

Four features in `Transcript.tsx` are keyed off that value, so all four switch
off silently:

| Feature | Why it dies |
|---|---|
| The time under a message | Rendered only `if (message.timestamp)` |
| Day dividers | `dayKey(null)` returns null, so no boundary is ever found |
| Grouping | `elapsed()` returns null for a null pair, and the guard treats that as "not the same run", so every message is its own group with its own avatar and a full gap |
| "Seen" | Requires `message.timestamp != null` before comparing against the read receipt, so after a reload it can never appear |

The other two clients read the field correctly, which is why this is invisible
until you look at the console:

- widget, `ChatWindow.jsx:792`: `timestamp: m.timestamp`
- lead drawer, `replayModel.ts:33`: `message.timestamp ?? message.created_at`

The lead drawer's tolerance is load-bearing rather than defensive: it renders
pages from the history endpoint (`timestamp`) and the lead endpoint
(`created_at`). The inbox reads only the history endpoint, but it will take the
same tolerant form so the three clients cannot disagree again.

## The design

### 1. Fix the parser

`timestamp: m.timestamp ?? m.created_at ?? null`.

Nothing else changes. Grouping, dividers, clocks and Seen return on their own.

### 2. The AI loses its bubble

The visitor's bubble is white, the AI's is `--color-surface-sunken`, and the
transcript's ground is `--color-canvas`. The AI's fill is 1.8 L* off that
ground, under the 2.4 L* floor `tokens.css` sets for a felt difference — the
component's own comment says so. Adding a third fill would be answering the
wrong question. The AI stops being a box instead:

| Speaker | Treatment |
|---|---|
| Visitor | White bubble, left, `--color-border-strong` hairline, tail on the last of a run |
| AI | Avatar plus rendered markdown. No fill, no border, no tail |
| Operator | Ink bubble, right, tail on the last of a run. Unchanged |

This is the convention the widget already uses and the one approved for the
lead drawer on 2026-09-08. It removes the near-collision without inventing a
colour, and it caps the AI's measure for free: plain text takes a reading
width rather than a bubble's percentage.

Every message's content caps at `min(34rem, 82%)`, down from
`min(42rem, 80%)` — about 73 characters at `text-prose` instead of about 95.

**The inbox keeps its own `Transcript`.** Reusing `ui/chat/WidgetTranscript`
looks obvious and is wrong: that component renders the visitor's perspective,
and the inbox needs the operator's, plus translation toggles, read receipts,
typing and attachments it does not have. Two components, one shared
convention: the AI is not a bubble.

### 3. The handover is derived, not recorded

The backend writes a system message when a chat *ends*
(`ws_routes.py:766`, `:1305`) and nothing when an operator joins, so there is
no stored marker to render.

The boundary is derivable from the transcript: the first message whose role
changes from `bot` to `operator`. It renders as the quiet centred line the
`system` role already uses, carrying that message's time.

It reads "A person joined", not a name: a transferred conversation contains
two operators and the transcript does not say which sent what. It appears at
most once, and never in a conversation with no operator turn.

Derived rather than persisted because it needs no new request, no backend
change, and it works on conversations that already happened.

### 4. The details rail drops impossible rows

A row whose value is *structurally impossible in the current state* is not
rendered. A row that could hold a value and does not still shows `—`, per
DESIGN.md rule 10.

| Row | Dropped when |
|---|---|
| `Assigned to` | Nobody is assigned |
| `Rated this chat` | The conversation has not ended |
| `Department` | None is set |

Contact details are untouched. "Company —" means "we did not learn this",
which is itself worth reading.

### 5. Copy

The strip under a read-only transcript stops repeating the header above it and
the button beside it.

## Testing

`liveChatHelpers.test.ts` (new): `timestamp`, `created_at`, both, neither, and
the file-attachment path that shares the parser.

`inbox.test.tsx` / `ChatPane.test.tsx`: the AI renders no bubble; the measure
cap; grouping collapses a run once timestamps exist; the handover line appears
once, at the right place, and not at all without an operator turn.

`VisitorPanel`: one case per dropped row, and one proving a genuinely-absent
contact value still renders `—`.

Browser (`inbox-transcript.spec.ts`): a replayed AI conversation shows clocks
and a day divider. jsdom computes no layout and no date rendering worth
trusting here, and this is the assertion that would have caught the defect.

## Commits

1. `fix(inbox): read the timestamp the history endpoint actually sends`
2. `feat(inbox): the AI is not a bubble`
3. `feat(inbox): mark where a person took over`
4. `fix(inbox): the details rail stops listing rows that cannot have a value`
5. `fix(inbox): the watching strip stops repeating the header above it`

The first stands alone and can be reverted without the rest.
