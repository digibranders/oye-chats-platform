import { describe, expect, it } from 'vitest';
import {
  AGEING_MS,
  OVERDUE_MS,
  ageBand,
  alertsFrom,
  trackArrivals,
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
    dismissed: new Set(),
    arrivals: new Map(),
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
  it('measures from when the visitor started waiting', () => {
    const alert = { since: new Date(NOW - 90_000).toISOString(), seenAt: NOW } as LobbyAlert;
    expect(waitedMs(alert, NOW)).toBe(90_000);
  });

  it('falls back to when this tab first saw them', () => {
    const alert = { since: null, seenAt: NOW - 5_000 } as LobbyAlert;
    expect(waitedMs(alert, NOW)).toBe(5_000);
  });

  it('never reads as a negative wait when the server clock runs ahead', () => {
    // A server a few seconds fast would otherwise put the start in the future
    // and the card would sit at "0s" until the browser caught up.
    const alert = { since: new Date(NOW + 4_000).toISOString(), seenAt: NOW - 1_000 } as LobbyAlert;
    expect(waitedMs(alert, NOW)).toBe(1_000);
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
    // The whole reason arrival order is tracked. An operator reaching for
    // "Take it" on the first card must not have a second person slide into
    // that slot on the way.
    const arrivals = new Map([
      ['s1', NOW - 30_000],
      ['s2', NOW - 1_000],
    ]);
    const alerts = alertsFrom(
      sources({
        // Deliberately the wrong way round on the wire: the payload is a
        // snapshot and carries no arrival order of its own.
        queue: [queued({ session_id: 's2' }), queued({ session_id: 's1' })],
        arrivals,
      }),
    );
    expect(alerts.map((a) => a.sessionId)).toEqual(['s1', 's2']);
  });

  it('closes one card without closing the queue', () => {
    const alerts = alertsFrom(
      sources({
        queue: [queued({ session_id: 's1' }), queued({ session_id: 's2' })],
        arrivals: new Map([
          ['s1', NOW - 30_000],
          ['s2', NOW - 1_000],
        ]),
        dismissed: new Set(['s1']),
      }),
    );
    expect(alerts.map((a) => a.sessionId)).toEqual(['s2']);
  });

  it('ranks somebody nobody owns above a message in a chat you hold', () => {
    // The visitor in the lobby is the one who leaves. The other is already
    // yours and knows somebody is there.
    const alerts = alertsFrom(
      sources({
        queue: [queued({ session_id: 'lobby' })],
        activeChats: { mine: chat({ session_id: 'mine' }) },
        unreadBySession: { mine: 2 },
        messagesBySession: {
          mine: [{ key: 'k', dbId: 9, role: 'user', content: 'is that price with GST?', timestamp: null }],
        },
        // Arrival order alone would put the held chat first.
        arrivals: new Map([
          ['mine', NOW - 60_000],
          ['lobby', NOW - 1_000],
        ]),
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

  it('dates a held chat from their message, not from when the chat opened', () => {
    // A two-hour conversation is not a two-hour wait, and an overdue stripe on
    // a message sent ten seconds ago is a lie.
    const at = new Date(NOW - 20_000).toISOString();
    const alerts = alertsFrom(
      sources({
        activeChats: { mine: chat({ session_id: 'mine' }) },
        unreadBySession: { mine: 1 },
        messagesBySession: { mine: [{ key: 'k', dbId: 9, role: 'user', content: 'hello?', timestamp: at }] },
      }),
    );
    expect(alerts[0].since).toBe(at);
  });

  it('keeps a preview to one line, so a pasted essay cannot become the card', () => {
    const alerts = alertsFrom(
      sources({ queue: [queued({ session_id: 's1', reason: 'line one\nline two\nline three' })] }),
    );
    expect(alerts[0].preview).toBe('line one');
  });
});

describe('trackArrivals', () => {
  it('stamps a session the first time it is seen and never again', () => {
    const first = trackArrivals(new Map(), ['s1'], 1_000);
    const second = trackArrivals(first, ['s1', 's2'], 2_000);
    expect(second.get('s1')).toBe(1_000);
    expect(second.get('s2')).toBe(2_000);
  });

  it('returns the same map when nothing changed, so a socket frame is not a render', () => {
    const first = trackArrivals(new Map(), ['s1'], 1_000);
    expect(trackArrivals(first, ['s1'], 5_000)).toBe(first);
  });

  it('forgets a session that has left', () => {
    // A visitor who gives up and returns an hour later is a new arrival.
    // Keeping their old slot would file them above people who have waited
    // longer than they have.
    const first = trackArrivals(new Map(), ['s1'], 1_000);
    const gone = trackArrivals(first, [], 2_000);
    expect(gone.has('s1')).toBe(false);
    const back = trackArrivals(gone, ['s1'], 9_000);
    expect(back.get('s1')).toBe(9_000);
  });
});
