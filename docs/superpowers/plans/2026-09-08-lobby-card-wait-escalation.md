# Lobby card wait escalation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the lobby card a real wait time so its escalation stops being dead code, and make the escalation legible once it runs.

**Architecture:** One new pair of columns on `ChatSession` (`waiting_since`, `requeue_reason`) written through a single helper, `mark_session_waiting`, that all five queueing sites call. The operator websocket's `queue_update` rows carry both fields; `lobbyModel` reads them; `LobbyCard` replaces the invisible `Badge` with a bold figure, thickens its border at `ageing`, and inverts to a solid danger card at `overdue`.

**Tech Stack:** FastAPI, SQLAlchemy 2.0, Alembic, pytest (backend); React 19, TypeScript, Tailwind v4, Vitest (frontend).

Spec: `docs/superpowers/specs/2026-09-08-lobby-card-wait-escalation-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `api/app/db/models.py` | The two columns on `ChatSession`. |
| `api/alembic/versions/b1000007waitsince.py` | Migration on head `b1000006platform`. |
| `api/app/services/live_chat_queue_service.py` | `mark_session_waiting`, the one place the stamp is written. |
| `api/app/api/operator_routes.py` | Two call sites: handoff request, department transfer. |
| `api/app/services/live_chat_service.py` | Two call sites (operator dropped), plus the queue payload. |
| `app/src/features/inbox/liveChatProtocol.ts` | `QueueItem` gains the two fields. |
| `app/src/shell/lobbyModel.ts` | Reads them onto `LobbyAlert`. |
| `app/src/shell/LobbyCard.tsx` | The escalation. |
| `app/src/i18n/locales/{en,hi,ar}.ts` | The requeue context strings. |

**Local test recipe (backend).** A plain `pytest` run is not representative. From
`api/`, with `.env` moved aside and a scratch DB:

```bash
DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib \
DB_URL=postgresql://$(whoami)@localhost/oyechats_pytest_ci \
GOOGLE_API_KEY=test-key APP_ENV=testing RAZORPAY_SEAT_PLAN_ID=plan_test_seat \
.venv/bin/python -m pytest -q --no-cov
```

---

## Task 1: The columns and the migration

**Files:**
- Modify: `api/app/db/models.py:1090` (the "Live chat state" block)
- Create: `api/alembic/versions/b1000007waitsince.py`

- [ ] **Step 1: Add the columns to the model**

In `api/app/db/models.py`, directly under `handoff_reason`:

```python
    # When this visitor entered the waiting queue, and why. NOT `created_at`:
    # that is when they opened the widget, so somebody who talks to the bot for
    # twenty minutes before asking for a human would arrive already overdue.
    # Written only through `live_chat_queue_service.mark_session_waiting`.
    waiting_since = Column(DateTime(timezone=True), nullable=True)
    # handoff | transfer | operator_dropped. Distinguishes a visitor who has
    # been let down once from one who has only just arrived, without making
    # `waiting_since` lie about the current wait.
    requeue_reason = Column(String(24), nullable=True)
```

- [ ] **Step 2: Write the migration**

Create `api/alembic/versions/b1000007waitsince.py`:

```python
"""Give the lobby card a wait it can actually measure.

The operator's lobby card escalates from accent to amber to danger as a
visitor waits. None of that ever ran in production: `queue_update` carried no
timestamp, so the card pinned itself to "just arrived" forever.

``chat_sessions.waiting_since``
    Stamped whenever the session enters the queue. Not `created_at`, which is
    when the visitor opened the widget.

``chat_sessions.requeue_reason``
    ``handoff`` | ``transfer`` | ``operator_dropped``.

Both nullable, no backfill. Existing rows keep NULL and render exactly as they
do today, which is the correct behaviour for a new column.

Revision ID: b1000007waitsince
Revises: b1000006platform
Create Date: 2026-09-08

"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "b1000007waitsince"
down_revision: str | None = "b1000006platform"
branch_labels: None = None
depends_on: None = None


def upgrade() -> None:
    op.add_column("chat_sessions", sa.Column("waiting_since", sa.DateTime(timezone=True), nullable=True))
    op.add_column("chat_sessions", sa.Column("requeue_reason", sa.String(length=24), nullable=True))


def downgrade() -> None:
    op.drop_column("chat_sessions", "requeue_reason")
    op.drop_column("chat_sessions", "waiting_since")
```

- [ ] **Step 3: Verify the migration applies and is the only head**

```bash
cd api && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib DB_URL=postgresql://$(whoami)@localhost/oyechats_pytest_ci .venv/bin/python -m alembic heads
```
Expected: one head, `b1000007waitsince`.

- [ ] **Step 4: Commit**

```bash
git add api/app/db/models.py api/alembic/versions/b1000007waitsince.py
git commit -m "feat(live-chat): record when a visitor entered the queue, and why"
```

---

## Task 2: `mark_session_waiting`, the one place the stamp is written

**Files:**
- Modify: `api/app/services/live_chat_queue_service.py`
- Test: `api/tests/test_waiting_since_stamp.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_waiting_since_stamp.py`:

```python
"""One helper owns the waiting stamp, because five call sites do not.

`status = "waiting"` is set in five places. A stamp written by hand at each of
them invites the sixth to forget, and a card whose clock is missing looks
exactly like a card whose visitor just arrived -- which is the bug this whole
change exists to fix.
"""

from datetime import UTC, datetime, timedelta

from app.db.models import ChatSession
from app.services.live_chat_queue_service import mark_session_waiting


def _session(**kw) -> ChatSession:
    return ChatSession(id=kw.pop("id", "s-1"), status=kw.pop("status", "bot"), **kw)


def test_stamps_the_time_and_the_reason():
    cs = _session()
    before = datetime.now(UTC)

    mark_session_waiting(cs, reason="handoff")

    assert cs.status == "waiting"
    assert cs.requeue_reason == "handoff"
    assert cs.waiting_since is not None
    assert abs((cs.waiting_since - before).total_seconds()) < 5


def test_a_second_queueing_restarts_the_clock():
    """A department transfer puts the visitor at the back of a different queue."""
    cs = _session()
    mark_session_waiting(cs, reason="handoff")
    cs.waiting_since = datetime.now(UTC) - timedelta(minutes=9)

    mark_session_waiting(cs, reason="transfer")

    assert cs.requeue_reason == "transfer"
    assert (datetime.now(UTC) - cs.waiting_since).total_seconds() < 5


def test_already_waiting_is_not_restamped():
    """`enqueue` guards on `status != "waiting"`; the helper must agree.

    Re-stamping an unchanged queue entry would reset the wait of somebody who
    has been sitting there, which is the one number the operator relies on.
    """
    cs = _session()
    mark_session_waiting(cs, reason="handoff")
    stamped = cs.waiting_since = datetime.now(UTC) - timedelta(minutes=4)

    mark_session_waiting(cs, reason="handoff")

    assert cs.waiting_since == stamped


def test_an_unknown_reason_is_refused():
    """The card renders a fixed string per reason; an unmapped one shows nothing."""
    cs = _session()
    try:
        mark_session_waiting(cs, reason="because")
    except ValueError as exc:
        assert "because" in str(exc)
    else:
        raise AssertionError("an unknown reason must not be stamped")
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd api && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib DB_URL=postgresql://$(whoami)@localhost/oyechats_pytest_ci GOOGLE_API_KEY=test-key APP_ENV=testing RAZORPAY_SEAT_PLAN_ID=plan_test_seat .venv/bin/python -m pytest tests/test_waiting_since_stamp.py -q --no-cov
```
Expected: `ImportError: cannot import name 'mark_session_waiting'`.

- [ ] **Step 3: Write the helper**

In `api/app/services/live_chat_queue_service.py`, above `def enqueue(`:

```python
#: Why a session is in the queue. The lobby card maps each to a phrase, so an
#: unmapped value would render as no explanation at all.
REQUEUE_REASONS = frozenset({"handoff", "transfer", "operator_dropped"})


def mark_session_waiting(chat_session: ChatSession, *, reason: str) -> None:
    """Put a session in the waiting queue and start its clock.

    The single writer of ``waiting_since``. Five call sites set
    ``status = "waiting"``; stamping by hand at each invites the sixth to
    forget, and a missing stamp is indistinguishable from a visitor who just
    arrived -- the exact failure this column exists to fix.

    A session already waiting keeps its original stamp. Re-stamping would reset
    the wait of somebody who has been sitting there, which is the one number
    the operator is deciding on.
    """
    if reason not in REQUEUE_REASONS:
        raise ValueError(f"unknown requeue reason: {reason!r}")
    if chat_session.status == "waiting" and chat_session.waiting_since is not None:
        return
    chat_session.status = "waiting"
    chat_session.waiting_since = datetime.now(UTC)
    chat_session.requeue_reason = reason
```

There is deliberately no `clear_session_waiting`. A session leaving the queue
becomes `live`, and the guard above keys on `status == "waiting"`, so the next
queueing re-stamps it. A stale timestamp on a live session is read by nothing.

`datetime` and `UTC` are already imported at the top of this module.

- [ ] **Step 4: Run it and watch it pass**

Same command as Step 2. Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add api/app/services/live_chat_queue_service.py api/tests/test_waiting_since_stamp.py
git commit -m "feat(live-chat): one helper owns the waiting stamp"
```

---

## Task 3: Route all five queueing sites through the helper

**Files:**
- Modify: `api/app/services/live_chat_queue_service.py:106`
- Modify: `api/app/api/operator_routes.py:1197`, `api/app/api/operator_routes.py:1853`
- Modify: `api/app/services/live_chat_service.py:838`, `api/app/services/live_chat_service.py:950`
- Test: `api/tests/test_waiting_since_stamp.py` (append)

- [ ] **Step 1: Write the failing source-level test**

Append to `api/tests/test_waiting_since_stamp.py`:

```python
class TestEveryQueueingSiteGoesThroughTheHelper:
    """A stamp is only reliable if nothing sets the status behind its back.

    Source-level because the alternative is five integration tests that each
    need an operator, a bot and a websocket. The defect this guards is a bare
    `status = "waiting"` reappearing, which looks entirely reasonable in a diff.
    """

    PATHS = (
        "app/api/operator_routes.py",
        "app/services/live_chat_service.py",
        "app/services/live_chat_queue_service.py",
    )

    def test_no_bare_status_assignment_remains(self):
        import pathlib

        offenders = []
        for rel in self.PATHS:
            src = pathlib.Path(rel).read_text(encoding="utf-8")
            for lineno, line in enumerate(src.splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith("#"):
                    continue
                if 'status = "waiting"' in stripped:
                    offenders.append(f"{rel}:{lineno}")
        assert offenders == [], (
            "these set the queue status without stamping waiting_since; "
            f"call mark_session_waiting instead: {offenders}"
        )
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd api && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib DB_URL=postgresql://$(whoami)@localhost/oyechats_pytest_ci GOOGLE_API_KEY=test-key APP_ENV=testing RAZORPAY_SEAT_PLAN_ID=plan_test_seat .venv/bin/python -m pytest tests/test_waiting_since_stamp.py -q --no-cov
```
Expected: FAIL listing five offenders.

- [ ] **Step 3: Replace the queue service's own assignment**

In `api/app/services/live_chat_queue_service.py`, replace:

```python
    chat_session = db_session.get(ChatSession, session_id)
    if chat_session is not None and chat_session.status != "waiting":
        chat_session.status = "waiting"
        db_session.commit()
```

with:

```python
    chat_session = db_session.get(ChatSession, session_id)
    if chat_session is not None:
        mark_session_waiting(chat_session, reason="handoff")
        db_session.commit()
```

The `status != "waiting"` guard moves inside the helper, which also checks the
stamp, so a session already waiting but never stamped now gets one.

- [ ] **Step 4: Replace the handoff-request site**

In `api/app/api/operator_routes.py`, replace `chat_session.status = "waiting"` at
line 1197 with:

```python
        mark_session_waiting(chat_session, reason="handoff")
```

Add to that file's imports:

```python
from app.services.live_chat_queue_service import mark_session_waiting
```

- [ ] **Step 5: Replace the department-transfer site**

In `api/app/api/operator_routes.py`, at line 1853 replace:

```python
        chat_session.status = "waiting"
        chat_session.assigned_operator_id = None
```

with:

```python
        # A transfer is a fresh queue, so the clock restarts. The reason is
        # what tells the receiving operator this is not a new arrival.
        chat_session.waiting_since = None
        mark_session_waiting(chat_session, reason="transfer")
        chat_session.assigned_operator_id = None
```

The explicit `waiting_since = None` is load-bearing: the helper declines to
re-stamp a session that is already waiting, and a transfer must restart the
clock for the new department.

- [ ] **Step 6: Replace both operator-dropped sites**

In `api/app/services/live_chat_service.py`, at lines 838 and 950 the loop body
reads:

```python
                        for cs in live_sessions:
                            cs.status = "waiting"
                            cs.assigned_operator_id = None
```

Replace each `cs.status = "waiting"` with:

```python
                            mark_session_waiting(cs, reason="operator_dropped")
```

preserving the surrounding indentation at each site. Add to that file's imports:

```python
from app.services.live_chat_queue_service import mark_session_waiting
```

These sessions were `live`, never `waiting`, so the helper stamps them.

- [ ] **Step 7: Run the guard and the full backend suite**

```bash
cd api && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib DB_URL=postgresql://$(whoami)@localhost/oyechats_pytest_ci GOOGLE_API_KEY=test-key APP_ENV=testing RAZORPAY_SEAT_PLAN_ID=plan_test_seat .venv/bin/python -m pytest -q --no-cov
```
Expected: all pass, no offenders.

- [ ] **Step 8: Commit**

```bash
git add api/app/services/live_chat_queue_service.py api/app/api/operator_routes.py api/app/services/live_chat_service.py api/tests/test_waiting_since_stamp.py
git commit -m "refactor(live-chat): every queueing site stamps the wait"
```

---

## Task 4: Send the wait on the wire

**Files:**
- Modify: `api/app/services/live_chat_service.py` (`_visible_queue_for_operator`, ~line 2273)
- Test: `api/tests/test_queue_payload_carries_the_wait.py`

- [ ] **Step 1: Write the failing test**

Create `api/tests/test_queue_payload_carries_the_wait.py`:

```python
"""The payload is the whole reason the card's escalation never ran.

`_visible_queue_for_operator` built rows with session_id, name, reason, bot_id
and bot_name. `LobbyCard` derives its band from a timestamp that was never in
there, so every card in production pinned itself to "just arrived".
"""

import inspect

from app.services.live_chat_service import LiveChatService


def test_the_row_builder_includes_the_wait_fields():
    src = inspect.getsource(LiveChatService._visible_queue_for_operator)

    assert '"waiting_since"' in src, "the card cannot escalate without a timestamp"
    assert '"requeue_reason"' in src, "the card cannot say why they are back in the queue"


def test_the_timestamp_is_serialised_as_iso():
    """`Date.parse` in the browser needs ISO 8601; a datetime would arrive as
    a Python repr and parse to NaN, which renders as no timer at all."""
    src = inspect.getsource(LiveChatService._visible_queue_for_operator)

    assert "isoformat()" in src
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd api && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib DB_URL=postgresql://$(whoami)@localhost/oyechats_pytest_ci GOOGLE_API_KEY=test-key APP_ENV=testing RAZORPAY_SEAT_PLAN_ID=plan_test_seat .venv/bin/python -m pytest tests/test_queue_payload_carries_the_wait.py -q --no-cov
```
Expected: FAIL on `"waiting_since" in src`.

- [ ] **Step 3: Add the fields to the row**

In `api/app/services/live_chat_service.py`, replace the `visible.append({...})`
block with:

```python
                lead = get_lead_info_by_session(db, chat_session.id)
                visible.append(
                    {
                        "session_id": chat_session.id,
                        "name": (lead.name if lead and lead.name else "Anonymous"),
                        "reason": chat_session.handoff_reason,
                        "bot_id": chat_session.bot_id,
                        "bot_name": bot.name if bot else None,
                        # ISO 8601, because the browser parses this with
                        # `Date.parse`. A NULL here is a session queued before
                        # the column existed; the card renders no timer rather
                        # than inventing one.
                        "waiting_since": (
                            chat_session.waiting_since.isoformat() if chat_session.waiting_since else None
                        ),
                        "requeue_reason": chat_session.requeue_reason,
                    }
                )
```

- [ ] **Step 4: Run it and watch it pass**

Same command as Step 2. Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add api/app/services/live_chat_service.py api/tests/test_queue_payload_carries_the_wait.py
git commit -m "feat(live-chat): the queue payload carries the wait"
```

---

## Task 5: Read the wait in the lobby model

**Files:**
- Modify: `app/src/features/inbox/liveChatProtocol.ts:32-42`
- Modify: `app/src/shell/lobbyModel.ts`
- Test: `app/src/shell/lobbyModel.test.ts`

- [ ] **Step 1: Write the failing test**

`app/src/shell/lobbyModel.test.ts` already exists and has `queued()` and
`sources()` factories at the top. Use them; do not add a second set. Append a
new block inside the existing `describe('alertsFrom', ...)`:

```ts
  it('takes the wait from waiting_since', () => {
    const [card] = alertsFrom(
      sources({ queue: [queued({ session_id: 's1', waiting_since: '2026-09-08T11:58:00Z' })] }),
    );

    expect(card.since).toBe('2026-09-08T11:58:00Z');
    expect(waitedMs(card, NOW)).toBe(120_000);
  });

  it('admits it does not know when the payload predates the column', () => {
    const [card] = alertsFrom(sources({ queue: [queued({ session_id: 's1' })] }));

    expect(card.since).toBeNull();
    expect(waitedMs(card, NOW)).toBeNull();
  });

  it('carries why they are back in the queue', () => {
    const [card] = alertsFrom(
      sources({ queue: [queued({ session_id: 's1', requeue_reason: 'operator_dropped' })] }),
    );

    expect(card.requeueReason).toBe('operator_dropped');
  });

  it('keys a dismissal on the same field it sorts by', () => {
    // Dismissal keyed on `created_at`, which the server never sent, so every
    // dismissal keyed on null. Sorting already used `since`; the two must agree
    // or a dismissed visitor can never raise a card again.
    const queue = [queued({ session_id: 's1', waiting_since: '2026-09-08T11:58:00Z' })];

    expect(
      alertsFrom(sources({ queue, dismissed: new Map([['s1', '2026-09-08T11:58:00Z']]) })),
    ).toHaveLength(0);
    expect(
      alertsFrom(sources({ queue, dismissed: new Map([['s1', '2026-09-08T11:00:00Z']]) })),
    ).toHaveLength(1);
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd app && npx vitest run src/shell/lobbyModel.test.ts
```
Expected: FAIL, `alert.since` is `null` where the ISO string was expected.

- [ ] **Step 3: Widen the protocol type**

In `app/src/features/inbox/liveChatProtocol.ts`, inside `QueueItem`, replace the
`created_at` line with:

```ts
  created_at?: string | null;
  /** When this visitor entered the queue, ISO. Absent on a session queued
   *  before the column existed; the lobby card then shows no timer. */
  waiting_since?: string | null;
  /** `handoff` | `transfer` | `operator_dropped`. */
  requeue_reason?: string | null;
```

- [ ] **Step 4: Read them in the model**

In `app/src/shell/lobbyModel.ts`, add to the `LobbyAlert` interface, under
`since`:

```ts
  /**
   * Why they are in the queue: `handoff`, `transfer` or `operator_dropped`.
   *
   * An operator dropping their chats re-queues them, which restarts the clock.
   * Rather than let the timer lie, the card says so on its context line: this
   * visitor has been let down once, even though their current wait is short.
   */
  requeueReason: string | null;
```

Then in `alertsFrom`, change the `waiting` block's filter and mapping:

```ts
  const waiting: LobbyAlert[] = queue
    .filter((entry) => dismissed.get(entry.session_id) !== (entry.waiting_since ?? null))
    .map((entry) => ({
      key: `w.${entry.session_id}`,
      sessionId: entry.session_id,
      kind: 'waiting' as const,
      name: entry.name?.trim() || '',
      detail: entry.bot_name?.trim() || null,
      preview: firstLine(entry.reason),
      since: entry.waiting_since ?? null,
      requeueReason: entry.requeue_reason ?? null,
    }))
    .sort(oldestFirst);
```

The filter and the mapping must read the same field. Dismissal is keyed on
`sessionId -> since`, so keying it on a field the payload never sends made every
dismissal permanent.

- [ ] **Step 5: Give the message branch the new field**

In the same function, the `messages` mapping builds a `LobbyAlert` too. Add
`requeueReason: null` to that object literal: an unread message in a live chat
is not a queue event.

- [ ] **Step 6: Run it and watch it pass**

```bash
cd app && npx vitest run src/shell/lobbyModel.test.ts && npx tsc --noEmit
```
Expected: all pass, no type errors.

- [ ] **Step 7: Commit**

```bash
git add app/src/features/inbox/liveChatProtocol.ts app/src/shell/lobbyModel.ts app/src/shell/lobbyModel.test.ts
git commit -m "feat(inbox): the lobby model reads the wait the server now sends"
```

---

## Task 6: The context line says why they are back

**Files:**
- Modify: `app/src/i18n/locales/en.ts`, `hi.ts`, `ar.ts`
- Modify: `app/src/shell/LobbyCard.tsx`

- [ ] **Step 1: Add the strings**

In `app/src/i18n/locales/en.ts`, in the `shell` section beside
`lobbyWaitingForAPerson`:

```ts
    lobbyOperatorDropped: 'Operator dropped · waiting again',
    lobbyTransferred: 'Transferred · waiting again',
```

`hi.ts`:

```ts
    lobbyOperatorDropped: 'ऑपरेटर ने छोड़ा · फिर से प्रतीक्षा में',
    lobbyTransferred: 'स्थानांतरित · फिर से प्रतीक्षा में',
```

`ar.ts`:

```ts
    lobbyOperatorDropped: 'غادر المشغّل · في الانتظار مجددًا',
    lobbyTransferred: 'تم التحويل · في الانتظار مجددًا',
```

All three dictionaries must gain both keys: the parity test fails on a key
present in one and missing from another.

- [ ] **Step 2: Use them in the card**

In `app/src/shell/LobbyCard.tsx`, replace the `state` assignment with:

```tsx
  // A re-queued visitor has already been let down once. The clock restarted
  // when they re-entered the queue, which is the honest number for "how long
  // has this person been ignored right now", so the fact that they have been
  // here before is said in words rather than smuggled into the timer.
  const requeued =
    alert.requeueReason === 'operator_dropped'
      ? t('shell.lobbyOperatorDropped') || 'Operator dropped · waiting again'
      : alert.requeueReason === 'transfer'
        ? t('shell.lobbyTransferred') || 'Transferred · waiting again'
        : null;
  const state =
    alert.kind === 'waiting'
      ? requeued || t('shell.lobbyWaitingForAPerson') || 'Waiting for a person'
      : t('shell.lobbyMessageInYourChat') || 'Message in your chat';
```

- [ ] **Step 3: Verify**

```bash
cd app && npx vitest run src/i18n && npx tsc --noEmit
```
Expected: dictionary parity passes, no type errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/i18n/locales/en.ts app/src/i18n/locales/hi.ts app/src/i18n/locales/ar.ts app/src/shell/LobbyCard.tsx
git commit -m "feat(inbox): the lobby card says why a visitor is waiting again"
```

---

## Task 7: The escalation

**Files:**
- Modify: `app/src/shell/LobbyCard.tsx`
- Modify: `app/src/shell/LobbyCard.test.tsx`

- [ ] **Step 1: Write the failing test**

`app/src/shell/LobbyCard.test.tsx` already exists with `alert()` and `card()`
factories and a suite covering the bands. Three changes to it.

First, `alert()` must produce the new field. Add to its returned object, above
the spread:

```tsx
    requeueReason: null,
```

Second, one existing test is about to describe something that is no longer
true. Replace `it('carries the urgency on the wait itself, not on a coloured
rule', ...)` in full with:

```tsx
  it('carries the urgency on the wait itself, not on a coloured rule', () => {
    // The first version painted a 3px accent bar across the top of the card. It
    // said "urgent" without saying how urgent, and the number underneath
    // already did.
    //
    // The wait is no longer a `Badge`. `Badge` maps `warning` to
    // `bg-warning-tint`, which is the exact colour the ageing card uses as its
    // ground, so the number was the same colour as the card it sat on. It is a
    // plain figure now, coloured by band, and the duration is always spelled
    // out beside it, so the tone still never works alone.
    card({ since: new Date(NOW - AGEING_MS - 12_000).toISOString() });

    const wait = screen.getByText('1m 12s');
    expect(wait.className).toContain('tabular-nums');
    expect(wait.className).not.toContain('bg-warning-tint');
    expect(document.querySelector('[data-lobby-card] [class*="bg-accent-500"]')).toBeNull();
  });
```

Third, append a new block for the escalation:

```tsx
describe('escalation', () => {
  it('carries more than hue, so the step survives a reader who cannot see it', () => {
    const fresh = card({ since: new Date(NOW - 8_000).toISOString() });
    expect(document.querySelector('[data-lobby-card]')?.className).not.toContain('border-2');
    fresh.unmount();

    card({ since: new Date(NOW - AGEING_MS - 12_000).toISOString() });
    expect(document.querySelector('[data-lobby-card]')?.className).toContain('border-2');
  });

  it('inverts at overdue, which is the state to catch from across a room', () => {
    card({ since: new Date(NOW - OVERDUE_MS - 40_000).toISOString() });

    const el = document.querySelector('[data-lobby-card]') as HTMLElement;
    expect(el.className).toContain('bg-danger-fill');
    expect(screen.getByText('Siddique').className).toContain('text-white');
  });

  it('leaves ageing tinted, so the last step still registers', () => {
    card({ since: new Date(NOW - AGEING_MS - 12_000).toISOString() });

    expect(document.querySelector('[data-lobby-card]')?.className).not.toContain('bg-danger-fill');
  });

  it('says why a visitor is waiting again, rather than letting the clock imply it', () => {
    card({ requeueReason: 'operator_dropped' });

    expect(screen.getByText(/waiting again/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd app && npx vitest run src/shell/LobbyCard.test.tsx
```
Expected: FAIL on `tabular-nums` (the wait is still a `Badge`).

- [ ] **Step 3: Replace the tone map and the surface map**

In `app/src/shell/LobbyCard.tsx`, delete the `TONE` constant and its comment
and replace `SURFACE` with:

```tsx
/**
 * The card's own ground, by band.
 *
 * Tinted from the first second rather than only once a wait turns bad. A
 * visitor who has just arrived is not an emergency, but the card still has to
 * be seen, and accent is the console's "this concerns you" colour rather than
 * a severity. Amber then means what it always means.
 *
 * `overdue` inverts instead of tinting. Three minutes is past the point where
 * the widget's own "someone will be with you shortly" is still true, and a
 * card that has to be caught by an operator looking somewhere else needs more
 * than a paler wash of the same idea. It is reserved for this one band on
 * purpose: a stack where every card is solid colour has no step left to take.
 */
const SURFACE: Record<LobbyBand, string> = {
  fresh: 'border-accent-500 bg-accent-50',
  ageing: 'border-2 border-warning bg-warning-tint',
  overdue: 'border-2 border-danger-fill bg-danger-fill',
};

/** The wait's colour. Never alone: the figure always spells out the duration. */
const FIGURE: Record<LobbyBand, string> = {
  fresh: 'text-accent-700',
  ageing: 'text-warning',
  overdue: 'text-white',
};

/** Everything that has to survive the inverted ground. */
const INK: Record<LobbyBand, { title: string; body: string; dismiss: string }> = {
  fresh: { title: 'text-text-primary', body: 'text-text-secondary', dismiss: 'text-text-tertiary' },
  ageing: { title: 'text-text-primary', body: 'text-text-secondary', dismiss: 'text-text-tertiary' },
  overdue: { title: 'text-white', body: 'text-white/85', dismiss: 'text-white/70' },
};
```

Update the imports on line 2 to drop `Badge` and `BadgeTone` and keep the rest:

```tsx
import { Avatar, Button, cn } from '../ui';
import { ageBand, waitWords, waitedMs, type LobbyAlert, type LobbyBand } from './lobbyModel';
```

- [ ] **Step 4: Apply the maps in the markup**

Replace the `Badge` element with:

```tsx
        {waited !== null ? (
          <span className={cn('figure mt-px shrink-0 text-sm font-semibold tabular-nums', FIGURE[band])}>
            {waitWords(waited)}
          </span>
        ) : null}
```

Apply `INK[band]` to the three places that carry text: the name `<p>` swaps
`text-text-primary` for `INK[band].title`, both the context and preview `<p>`
swap `text-text-secondary` for `INK[band].body`, and the dismiss button swaps
`text-text-tertiary` for `INK[band].dismiss`.

On the overdue card the `Button`s need to survive the dark ground, so wrap the
action row's buttons:

```tsx
          <Button
            size="sm"
            variant={band === 'overdue' ? 'secondary' : 'primary'}
            onClick={onTake}
            loading={busy}
            disabled={busy}
            className={band === 'overdue' ? 'bg-white text-danger hover:bg-white/90' : undefined}
          >
```

and give the two ghost buttons `className={band === 'overdue' ? 'text-white/90 hover:bg-white/15' : undefined}`.

- [ ] **Step 5: Run it and watch it pass**

```bash
cd app && npx vitest run src/shell/LobbyCard.test.tsx && npx tsc --noEmit && npm run lint
```
Expected: all pass, no type errors, lint clean.

- [ ] **Step 6: Commit**

```bash
git add app/src/shell/LobbyCard.tsx app/src/shell/LobbyCard.test.tsx
git commit -m "feat(inbox): the lobby card escalates in weight, not only in hue"
```

---

## Task 8: Verify the whole thing

- [ ] **Step 1: Backend suite**

```bash
cd api && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib DB_URL=postgresql://$(whoami)@localhost/oyechats_pytest_ci GOOGLE_API_KEY=test-key APP_ENV=testing RAZORPAY_SEAT_PLAN_ID=plan_test_seat .venv/bin/python -m pytest -q --no-cov
```
Expected: all pass.

- [ ] **Step 2: Backend lint**

```bash
cd api && .venv/bin/python -m ruff check app tests && .venv/bin/python -m ruff format --check app tests
```
Expected: `All checks passed!`

- [ ] **Step 3: Frontend**

```bash
cd app && npm run lint && npx tsc --noEmit && npx vitest run && npm run build
```
Expected: all pass.

- [ ] **Step 4: Look at it**

Render the card in all three bands and confirm the crescendo reads. Screenshot
the three states side by side and check that `overdue` is distinguishable at a
glance from `ageing`, and that the wait figure is legible on all three grounds.

- [ ] **Step 5: Open the PR**

```bash
git push origin development
gh pr create --base main --head development --title "feat(inbox): the lobby card can finally tell a 5-second wait from a 5-minute one"
```
