# The lobby card: reaching an operator who is not on the inbox page

**Status:** approved 2026-09-08. Implementation follows this document.

## The reported problem

An operator misses incoming live-chat requests. The notification bell is a
passive feed nobody opens, and the rail's Inbox badge is a number that changes
quietly. The ask was a toast or a banner.

## The problem underneath it

The operator WebSocket is owned by the inbox page. `InboxSocketProvider` is
rendered inside `InboxPage`, so navigating to Leads, Analytics or Billing
unmounts it and closes the socket.

The backend then starts a 60-second grace period and, when it expires:

- sets `is_online = False`,
- drops the operator from Redis presence,
- **re-queues every live session assigned to them**

(`api/app/services/live_chat_service.py::_operator_disconnect_timeout`).

Nothing else refreshes presence: `presence.mark_online` is called only from the
WebSocket path, and the shell's 30-second `waiting-count` poll does not touch
it. Meanwhile `useOperatorStatus` reads the status once at mount and never
re-checks, so the console keeps showing "Taking chats" as **on**.

So an on-duty operator who spends more than a minute anywhere else in the
console is silently offline, with their live conversations taken away. A large
share of "I missed the notification" is "there was no notification, because I
was not connected to receive one". Any alert surface built on top of that would
be decoration.

## What ships

### 1. The socket moves to the shell

`InboxSocketProvider` moves from `InboxPage` to `AppShell`, wrapping the
authenticated app. Its `enabled` gate stops asking *"am I on the inbox route?"*
and asks only: does this workspace have live chat, does this person hold an
operator seat, and are they on duty. `useInboxSocket()` in the inbox is
unchanged; it simply no longer owns the connection.

This is not an extra connection. The server already supersedes duplicates with
close code 4001, so the count per operator is the same. It is *fewer* connection
events: today the socket opens and closes on every trip in and out of the inbox,
each one running connect/disconnect handling, a grace timer and a roster
broadcast.

**`enableOnMount` does not move up.** Going *on duty* stays tied to arriving at
the inbox, which is the gesture that means "I am at my desk". Opening the
dashboard to look at billing must not put anybody on duty. The socket follows
the on-duty flag; it does not set it.

**The superseded-tab notice moves up too.** Today "Use this tab" lives in the
inbox's empty state. With a shell-level socket a second tab supersedes the first
from anywhere, and a first tab that has silently stopped alerting is worse than
the bug being fixed. It becomes a shell-level notice.

**Known gap, deliberately out of scope:** an operator on another page can go on
duty but cannot go *off* without walking back to the inbox. Follow-up: an
on-duty indicator with a toggle in the account menu.

### 2. The lobby card

A persistent, floating card at the top-right of the shell, below the top bar.

Rejected alternatives, and why:

- **A toast** removes itself after a few seconds, which is the reported failure
  exactly. Operators also dismiss toasts reflexively, because every other toast
  in this console is disposable, and a toast has no room for who is waiting, how
  long, or a way to accept.
- **A shell banner** is a layout row: it arrives on its own schedule and pushes
  the page down 40px. That is the defect fixed on the auth pages the same day —
  a reflow between `mousedown` and `mouseup` swallows the click. One line also
  cannot honestly carry three people waiting.

The card carries: an eyebrow with the state and a live wait timer, the visitor's
name and company, their last message, and **Take it** / **Open inbox** / mute.
Below it, a count of anyone else waiting with "See all".

**It ages.** Accent under 30 seconds, warning to three minutes, danger beyond.
The timer is always visible, so colour is never the only signal.

**Rules:**

| Rule | Why |
|---|---|
| Only while on duty | Off duty, or not an operator, and none of this exists |
| Never on the inbox page | The queue is already on screen; a card over it is the same fact twice |
| No auto-dismiss | It leaves when the visitor is taken or gives up |
| Dismiss is per visitor | Closing Siddique's card must not hide the next arrival |
| A new card never takes the top slot | Arrivals append below, so nothing moves under a travelling pointer |
| A colleague's accept shows for ~3s, then leaves | Silent removal is a mis-click: the operator lands on whatever slid up |

The last two are the same class of defect as the auth click and the `sr-only`
scroll. They are stated as rules in the component, not discovered later.

### 3. Take it

Accepts the chat and lands the operator in that conversation with the composer
focused. They pressed a button labelled "Take it"; making them find the row and
press Accept again is the second-click problem in a different costume.

If the accept fails because a colleague got there first, the card says so and
does not navigate.

### 4. The other channels

- **Sound.** `playPing` already exists but only fires from the inbox's socket.
  It moves with the socket and repeats every 30 seconds while anyone is still in
  the lobby, so a head-down operator is nudged more than once. Muted from the
  bell on the card; the mute lasts the session.
- **Tab title.** `(1) OyeChats` while anyone waits. The cheapest change here and
  the only one that reaches an operator working in a different tab.
- **Native and push notifications** already work for a hidden tab. Unchanged.

### 5. Messages in a chat you already hold

Same surface, quieter: neutral stripe, "Message in your chat", the preview, and
**Reply**. That visitor is already yours, so it is a nudge rather than a claim
on the queue. Suppressed while the inbox is open.

## Components

| File | Responsibility |
|---|---|
| `app/src/shell/LobbyAlerts.tsx` | The stack, mounted in `AppShell` |
| `app/src/shell/LobbyCard.tsx` | One card: identity, timer, actions, ageing |
| `app/src/shell/useLobbyAlerts.ts` | Derives the alert list from the socket; owns per-visitor dismissal, the repeating chime and the mute |
| `app/src/shell/useDocumentTitle.ts` | `(n) OyeChats` while anyone waits |
| `app/src/features/inbox/InboxSocketContext.tsx` | Unchanged, mounted higher |
| `app/src/shell/AppShell.tsx` | Mounts the provider and the stack |
| `app/src/features/inbox/InboxPage.tsx` | Stops mounting the provider |

`lobbyModel.ts` holds the pure parts: `ageBand(waitedMs)`, and
`alertsFrom(queue, activeChats, unread, dismissed, onInbox)` returning the
ordered list. Pure, so the ordering and dismissal rules are unit-testable
without a socket.

## Failure modes

| What happens | What the operator gets |
|---|---|
| Socket drops | Cards stay, frozen, with a "reconnecting" note rather than vanishing |
| Superseded by another tab | Shell notice with "Use this tab"; no cards, because this tab is not listening |
| Accept fails, taken by a colleague | "Asha took this one", then the card leaves |
| Accept fails for any other reason | Error on the card, card stays, no navigation |
| Off duty mid-wait | Every card clears |
| Audio blocked | Silent; the card is the signal |

## Tests

- `lobbyModel.test.ts` — age bands at the boundaries; ordering is oldest-first
  and append-only; per-visitor dismissal; nothing while off duty or on the
  inbox; a held-chat message ranks below a lobby visitor.
- `LobbyCard.test.tsx` — the timer counts up, the band changes with it, the
  timer is present at every band so colour is not alone, mute toggles.
- `useLobbyAlerts.test.ts` — the chime repeats on a schedule and stops when the
  queue empties; mute silences it; dismissal does not silence the next arrival.
- `lobby-alerts.spec.ts` (browser) — a queue frame while on Leads raises a card;
  "Take it" accepts and lands in the conversation; a new arrival appends below
  and does not move the first card by a pixel (measured, the click-safety rule);
  the tab title changes; nothing appears on the inbox page.
- Existing inbox suites must stay green with the provider mounted higher.
- New strings in `en`, `hi`, `ar`; `/dev/ui` entry for the card.
