import { describe, expect, it } from 'vitest';
import {
  AGEING_MS,
  OVERDUE_MS,
  ageBand,
  alertsFrom,
  waitedMs,
  type LobbyAlert,
  type LobbySources,
} from './lobbyModel';
import type { ActiveChat, QueueItem } from '../features/inbox/liveChatProtocol';

/**
 * The rules that decide which cards appear and in what order.
 *
 * Two of them exist to protect a click rather than to look tidy, and neither
 * shows up in a screenshot: arrivals append rather than taking the top slot,
 * and dismissal is per visitor rather than global. Both are the same family of
 * defect as the reflow that swallowed clicks on the auth pages.
 */

const NOW = Date.parse('2026-09-08T12:00:00Z');

function queued(over: Partial<QueueItem> & Pick<QueueItem, 'session_id'>): QueueItem {
  return {
    name: 'Siddique',
    reason: 'Asked to speak to a person',
    bot_id: 1,
    bot_name: 'Acme Bot',
    created_at: new Date(NOW - 10_000).toISOString(),
    ...over,
  };
}

function chat(over: Partial<ActiveChat> & Pick<ActiveChat, 'session_id'>): ActiveChat {
  return {
    visitor_name: 'Priya Raman',
    reason: null,
    bot_id: 1,
    bot_name: 'Acme Bot',
    ...over,
  } as ActiveChat;
}

function sources(over: Partial<LobbySources> = {}): LobbySources {
  return {
    queue: [],
    activeChats: {},
    unreadBySession: {},
    messagesBySession: {},
    dismissed: new Map(),
    enabled: true,
    onInboxPage: false,
    ...over,
  };
}

describe('ageBand', () => {
  it('turns a wait into urgency at the boundaries, not near them', () => {
    expect(ageBand(0)).toBe('fresh');
    expect(ageBand(AGEING_MS - 1)).toBe('fresh');
    expect(ageBand(AGEING_MS)).toBe('ageing');
    expect(ageBand(OVERDUE_MS - 1)).toBe('ageing');
    expect(ageBand(OVERDUE_MS)).toBe('overdue');
  });
});

describe('waitedMs', () => {
  const dated = (since: string | null): LobbyAlert => ({ since }) as LobbyAlert;

  it('measures from when the visitor started waiting', () => {
    expect(waitedMs(dated(new Date(NOW - 90_000).toISOString()), NOW)).toBe(90_000);
  });

  it('admits it does not know, rather than inventing a zero', () => {
    // The card renders no timer at all for this. "0s" beside somebody who has
    // been there two minutes is worse than saying nothing.
    expect(waitedMs(dated(null), NOW)).toBeNull();
    expect(waitedMs(dated('not a date'), NOW)).toBeNull();
  });

  it('never counts backwards when the server clock runs ahead', () => {
    expect(waitedMs(dated(new Date(NOW + 4_000).toISOString()), NOW)).toBe(0);
  });
});

describe('alertsFrom', () => {
  it('raises a card for a visitor waiting for a person', () => {
    const alerts = alertsFrom(sources({ queue: [queued({ session_id: 's1' })] }));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ sessionId: 's1', kind: 'waiting', name: 'Siddique' });
  });

  it('says nothing at all while the operator is off duty', () => {
    expect(alertsFrom(sources({ queue: [queued({ session_id: 's1' })], enabled: false }))).toEqual([]);
  });

  it('says nothing on the inbox page, where the queue is already on screen', () => {
    expect(alertsFrom(sources({ queue: [queued({ session_id: 's1' })], onInboxPage: true }))).toEqual([]);
  });

  it('appends an arrival below, so nothing moves under a travelling pointer', () => {
    // An operator reaching for "Take it" on the first card must not have a
    // second person slide into that slot on the way. Oldest first does that on
    // its own: a new arrival is by definition the newest.
    const alerts = alertsFrom(
      sources({
        // Deliberately the wrong way round on the wire: the payload is a
        // snapshot and carries no order of its own.
        queue: [
          queued({ session_id: 's2', created_at: new Date(NOW - 1_000).toISOString() }),
          queued({ session_id: 's1', created_at: new Date(NOW - 30_000).toISOString() }),
        ],
      }),
    );
    expect(alerts.map((a) => a.sessionId)).toEqual(['s1', 's2']);
  });

  it('files a visitor with no start time last, not first', () => {
    // An unknown wait is not an infinite one. Sorting it to the top would push
    // somebody with a real, long wait underneath it.
    const alerts = alertsFrom(
      sources({
        queue: [
          queued({ session_id: 'undated', created_at: null }),
          queued({ session_id: 's1', created_at: new Date(NOW - 30_000).toISOString() }),
        ],
      }),
    );
    expect(alerts.map((a) => a.sessionId)).toEqual(['s1', 'undated']);
  });

  it('closes one card without closing the queue', () => {
    const first = new Date(NOW - 30_000).toISOString();
    const alerts = alertsFrom(
      sources({
        queue: [
          queued({ session_id: 's1', created_at: first }),
          queued({ session_id: 's2', created_at: new Date(NOW - 1_000).toISOString() }),
        ],
        dismissed: new Map([['s1', first]]),
      }),
    );
    expect(alerts.map((a) => a.sessionId)).toEqual(['s2']);
  });

  it('lets a dismissed visitor back in when they ask again', () => {
    // A widget session survives in the visitor's browser, so somebody who asks
    // for a person, is dismissed, gives up and asks again ten minutes later
    // comes back under the SAME session id. Keyed on the id alone, that second
    // request would be swallowed in silence, which is the reported bug wearing
    // a different hat.
    const alerts = alertsFrom(
      sources({
        queue: [queued({ session_id: 's1', created_at: new Date(NOW - 5_000).toISOString() })],
        dismissed: new Map([['s1', new Date(NOW - 600_000).toISOString()]]),
      }),
    );
    expect(alerts.map((a) => a.sessionId)).toEqual(['s1']);
  });

  it('ranks somebody nobody owns above a message in a chat you hold', () => {
    // The visitor in the lobby is the one who leaves. The other is already
    // yours and knows somebody is there.
    const alerts = alertsFrom(
      sources({
        queue: [queued({ session_id: 'lobby', created_at: new Date(NOW - 1_000).toISOString() })],
        activeChats: { mine: chat({ session_id: 'mine' }) },
        unreadBySession: { mine: 2 },
        messagesBySession: {
          mine: [
            {
              key: 'k',
              dbId: 9,
              role: 'user',
              content: 'is that price with GST?',
              // Older than the lobby visitor: time alone would rank it first.
              timestamp: new Date(NOW - 60_000).toISOString(),
            },
          ],
        },
      }),
    );
    expect(alerts.map((a) => a.kind)).toEqual(['waiting', 'message']);
  });

  it('ignores a chat you hold that has nothing unread in it', () => {
    const alerts = alertsFrom(
      sources({ activeChats: { mine: chat({ session_id: 'mine' }) }, unreadBySession: { mine: 0 } }),
    );
    expect(alerts).toEqual([]);
  });

  it('dates a held chat from the oldest thing you have not answered', () => {
    // Not from the newest. "How long have they waited for a reply" is the
    // question, and it is also the only answer that stays still: dating from
    // their latest line would re-sort the stack every time somebody typed.
    const older = new Date(NOW - 90_000).toISOString();
    const newer = new Date(NOW - 5_000).toISOString();
    const alerts = alertsFrom(
      sources({
        activeChats: { mine: chat({ session_id: 'mine' }) },
        unreadBySession: { mine: 2 },
        messagesBySession: {
          mine: [
            { key: 'read', dbId: 1, role: 'user', content: 'hi', timestamp: new Date(NOW - 200_000).toISOString() },
            { key: 'a', dbId: 2, role: 'user', content: 'hello?', timestamp: older },
            { key: 'b', dbId: 3, role: 'user', content: 'are you there?', timestamp: newer },
          ],
        },
      }),
    );
    expect(alerts[0].since).toBe(older);
    // The preview is still the latest thing they said, which is what an
    // operator reads to decide.
    expect(alerts[0].preview).toBe('are you there?');
  });

  it('keeps a preview to one line, so a pasted essay cannot become the card', () => {
    const alerts = alertsFrom(
      sources({ queue: [queued({ session_id: 's1', reason: 'line one\nline two\nline three' })] }),
    );
    expect(alerts[0].preview).toBe('line one');
  });
});
