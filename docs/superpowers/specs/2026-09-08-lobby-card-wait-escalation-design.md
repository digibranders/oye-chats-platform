# Lobby card wait escalation

**Date:** 2026-09-08
**Status:** approved, not implemented

## The problem

The lobby card escalates from accent to amber to danger as a visitor waits.
None of that happens in production, and it never has.

`LobbyCard` derives its band from `waitedMs(alert, now)`, which reads
`alert.since`. For a `waiting` alert `since` comes from `entry.created_at` in
`lobbyModel.alertsFrom`. The operator websocket's `queue_update` payload is
built by `LiveChatService._visible_queue_for_operator`
(`api/app/services/live_chat_service.py`), and each row carries exactly:

```python
{"session_id": ..., "name": ..., "reason": ..., "bot_id": ..., "bot_name": ...}
```

There is no timestamp. So `since` is `null`, `waitedMs` returns `null`, the
band is pinned to `fresh`, and the wait badge does not render at all. Every
lobby card in production is the same calm blue card with no number on it,
whether the visitor arrived two seconds ago or nine minutes ago.

Unread-message alerts are unaffected: those take `since` from the message's own
timestamp and escalate correctly.

Three further defects, found by rendering the real component in all four states
side by side:

1. **The badge cannot escalate.** `Badge` maps `warning` to `bg-warning-tint`
   and `danger` to `bg-danger-tint`, which are the exact colours the ageing and
   overdue cards use as their ground. A status badge on a tinted card is the
   same colour as the card. No tone in the system fixes this; `Badge` assumes a
   neutral surface. Worse, `fresh` maps to `ink`, the one solid tone, so the
   calmest state has the loudest badge and the most urgent has the quietest.
2. **`Take it` out-shouts the state.** It is `fill-primary` (near-black), so on
   the amber and red cards the highest-contrast object is the control rather
   than the urgency.
3. **Only the hue changes.** All bands share one size, weight and structure.
   Nothing about an overdue card is more insistent than a fresh one.

## Design

### Backend: a clock that measures the right thing

Add `ChatSession.waiting_since` (`DateTime(timezone=True)`, nullable), stamped
whenever `status` becomes `"waiting"`, and cleared when it leaves.

`created_at` is not a substitute: it records when the visitor opened the widget,
so anyone who talks to the bot for twenty minutes before asking for a human
would arrive already overdue.

Five sites set the status today, and all five stamp:

| Site | Situation |
|---|---|
| `api/app/api/operator_routes.py:1197` | visitor requests a handoff |
| `api/app/api/operator_routes.py:1853` | transfer to another department |
| `api/app/services/live_chat_service.py:838` | operator disconnected, live chats re-queued |
| `api/app/services/live_chat_service.py:950` | same, second path |
| `api/app/services/live_chat_queue_service.py:106` | queue entry created |

Writing this in five places invites the sixth to forget. The stamp belongs in
one helper, `enqueue_session(chat_session, *, reason)` in
`live_chat_queue_service`, which sets `status`, `waiting_since` and the requeue
reason together; the five sites call it.

Migration on head `b1000006platform`. No backfill: per the standing decision on
test accounts, existing rows get `NULL` and render exactly as they do today.

`_visible_queue_for_operator` gains `waiting_since` (ISO 8601) and
`requeue_reason` on each row.

### Backend: why they are waiting again

An operator dropping their chats re-queues them, and stamping `waiting_since`
resets that visitor's clock. Rather than fudge the clock, record why: a
`requeue_reason` of `handoff` (default), `transfer` or `operator_dropped`.

The card reads it on the context line, which already says "Waiting for a
person". A dropped visitor reads "Operator dropped · waiting again" instead, so
the operator sees this person has been let down once without the timer lying
about how long they have been in this queue.

### Frontend: the escalation

`lobbyModel.alertsFrom` reads `entry.waiting_since ?? null` into `since`, and
carries `requeueReason` onto `LobbyAlert`. `ageBand`, `OVERDUE_MS` (3 min) and
`AGEING_MS` (60s) are unchanged.

`LobbyCard` changes in three ways.

**The wait becomes a figure, not a badge.** `Badge` is dropped for this number
and replaced with a plain `text-sm font-semibold tabular-nums` span in the
band's own text colour (`text-accent-700`, `text-warning`, `text-danger`). This
is what makes the number legible on a tinted ground, and it removes the
inversion where `fresh` was the loudest.

**The card gains weight as it ages.** `fresh` keeps a 1px border; `ageing` and
`overdue` take 2px. Structure escalates alongside hue, so the change survives a
viewer who cannot separate the amber from the red.

**`overdue` inverts.** At three minutes the card becomes solid
`bg-danger-fill` with white text, a white `Take it`, and ghost controls at
`text-white/90`. This is the state an operator can catch while looking at
something else, which is the card's entire job. It is reserved for `overdue`
alone: a workspace where every card is solid colour has no crescendo left.

Colour never works alone at any step, because the wait is always spelled out in
words beside it.

Unchanged: `role="status"`, the arrival slide, the chime and its session mute,
oldest-first ordering, dismissal keyed on `sessionId -> since`, and the rule
that a held chat (`kind: 'message'`) never reddens.

## Testing

- `lobbyModel`: `since` reads `waiting_since`; a row without it still yields
  `null` and pins to `fresh`; `requeueReason` maps to the context string.
- `LobbyCard`: each band renders its expected surface, border width and figure;
  the overdue card renders inverted; a null wait renders no figure.
- Backend: `enqueue_session` stamps `waiting_since` and the reason; each of the
  five call sites goes through it (source-level, as with the gate call sites);
  the queue payload carries both fields; leaving `waiting` clears the stamp.
- A11y: the wait figure is inside the `role="status"` region, and the inverted
  card's white-on-`danger-fill` text is checked against the ratio
  `tokens.css` records for `--color-danger-fill` (white on it: 6.08).

## Out of scope

- Whether the chime should escalate with the band. It currently repeats at a
  fixed 30s interval regardless of how long the visitor has waited.
- Backfilling `waiting_since` for existing sessions.
- Operators going off duty from outside the inbox, which remains a known gap.
