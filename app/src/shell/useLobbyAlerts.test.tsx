import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ping = vi.hoisted(() => vi.fn());
vi.mock('../features/inbox/notifications', () => ({
  playPing: ping,
  alertOperator: vi.fn(),
  ensureNotificationPermission: vi.fn(),
}));

const socket = vi.hoisted(() => ({
  value: {
    status: 'connected',
    queue: [] as unknown[],
    activeChats: {} as Record<string, unknown>,
    unreadBySession: {} as Record<string, number>,
    messagesBySession: {} as Record<string, unknown>,
  },
}));
vi.mock('../features/inbox/inboxSocket', () => ({ useInboxSocket: () => socket.value }));

const presence = vi.hoisted(() => ({
  value: { liveChat: true, unavailable: false, isOnline: true },
}));
vi.mock('./operatorPresenceContext', () => ({ useOperatorPresence: () => presence.value }));

import { useLobbyAlerts } from './useLobbyAlerts';

/**
 * The parts of the stack that are about time rather than markup.
 *
 * The reported failure was a signal that fired exactly once and was missed, so
 * what matters here is that the chime keeps going while somebody is still
 * waiting, that muting it is honoured, and that closing one card does not close
 * the queue.
 */

function queued(sessionId: string, secondsAgo = 5) {
  return {
    session_id: sessionId,
    name: `Visitor ${sessionId}`,
    reason: null,
    bot_id: 1,
    bot_name: 'Acme Bot',
    created_at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
  };
}

/** Renders the hook and exposes what a card would need from it. */
function Probe() {
  const { alerts, muted, toggleMute, dismiss } = useLobbyAlerts();
  return (
    <div>
      <output data-testid="ids">{alerts.map((a) => a.sessionId).join(',')}</output>
      <output data-testid="muted">{String(muted)}</output>
      <button type="button" onClick={toggleMute}>
        toggle mute
      </button>
      {alerts.map((a) => (
        <button key={a.sessionId} type="button" onClick={() => dismiss(a.sessionId, a.since)}>
          dismiss {a.sessionId}
        </button>
      ))}
    </div>
  );
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/leads']}>
      <Probe />
    </MemoryRouter>,
  );
}

describe('useLobbyAlerts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    ping.mockClear();
    window.sessionStorage.clear();
    socket.value = {
      status: 'connected',
      queue: [],
      activeChats: {},
      unreadBySession: {},
      messagesBySession: {},
    };
    presence.value = { liveChat: true, unavailable: false, isOnline: true };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sounds once immediately, because nobody should wait 30s to be told', () => {
    socket.value.queue = [queued('s1')];
    mount();
    expect(ping).toHaveBeenCalledTimes(1);
  });

  it('keeps sounding while somebody is still in the lobby', () => {
    // The whole reported failure: one chime, missed, and then silence. This is
    // driven by "is anybody still waiting", not by "did somebody arrive".
    socket.value.queue = [queued('s1')];
    mount();
    expect(ping).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(ping).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(ping).toHaveBeenCalledTimes(3);
  });

  it('goes quiet when the lobby empties', () => {
    socket.value.queue = [queued('s1')];
    const view = mount();
    ping.mockClear();

    socket.value = { ...socket.value, queue: [] };
    view.rerender(
      <MemoryRouter initialEntries={['/leads']}>
        <Probe />
      </MemoryRouter>,
    );

    act(() => {
      vi.advanceTimersByTime(90_000);
    });
    expect(ping).not.toHaveBeenCalled();
  });

  it('does not sound for a chat the operator already holds', () => {
    // They know somebody is there. A repeating chime for a message in a live
    // conversation is how an operator learns to mute the console.
    socket.value.activeChats = { s9: { session_id: 's9', visitor_name: 'Priya', bot_id: 1, bot_name: 'Acme Bot' } };
    socket.value.unreadBySession = { s9: 1 };
    mount();
    expect(ping).not.toHaveBeenCalled();
  });

  it('stays silent while muted, and remembers it for the session', async () => {
    socket.value.queue = [queued('s1')];
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount();
    ping.mockClear();

    await user.click(screen.getByRole('button', { name: 'toggle mute' }));
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(ping).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem('oc_lobby_muted')).toBe('1');
  });

  it('closes one card without closing the queue', async () => {
    socket.value.queue = [queued('s1', 30), queued('s2', 5)];
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount();
    expect(screen.getByTestId('ids')).toHaveTextContent('s1,s2');

    await user.click(screen.getByRole('button', { name: 'dismiss s1' }));
    expect(screen.getByTestId('ids')).toHaveTextContent('s2');
  });

  it('raises nothing on the inbox page, where the queue is already on screen', () => {
    socket.value.queue = [queued('s1')];
    render(
      <MemoryRouter initialEntries={['/inbox?view=all']}>
        <Probe />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('ids')).toHaveTextContent('');
    expect(ping).not.toHaveBeenCalled();
  });

  it('raises nothing while the operator is off duty', () => {
    presence.value = { liveChat: true, unavailable: false, isOnline: false };
    socket.value.queue = [queued('s1')];
    mount();
    expect(screen.getByTestId('ids')).toHaveTextContent('');
    expect(ping).not.toHaveBeenCalled();
  });
});
