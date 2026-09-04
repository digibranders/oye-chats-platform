import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOperatorSocket } from './useOperatorSocket';

/**
 * The same visitor, twice.
 *
 * A live conversation that is closed and then re-accepted KEEPS ITS SESSION ID.
 * `chat_closed` records how it ended so the transcript can stay readable
 * afterwards, and nothing used to clear that record, so the second round of the
 * same conversation inherited the first one's ending: the list row read
 * "Ended", `ChatPane` rendered "This conversation has ended", and the composer
 * said "This conversation is closed" at an operator whose visitor was sitting
 * in the widget typing at them. The widget showed a healthy live chat
 * throughout, because the widget's state is the server's and only the console
 * had gone stale. Reported from production on 2026-09-04.
 *
 * `endedBySession` is read for sessions that are STILL IN `activeChats`
 * (`InboxPage` passes both into `toLiveItem`), which is why an ending has to be
 * retracted rather than merely shadowed by the chat coming back.
 */

const HISTORY = { messages: [], has_more: false };

vi.mock('../../services/api', () => ({
  getChatHistory: vi.fn(async () => HISTORY),
  getMyLanguage: vi.fn(async () => ({ preferred_locale: null, available_locales: [] })),
}));
vi.mock('../../utils/authStorage', () => ({ getAuthItem: () => 'test-token' }));
vi.mock('../../utils/impersonation', () => ({ isImpersonating: () => false }));
vi.mock('./notifications', () => ({
  alertOperator: vi.fn(),
  ensureNotificationPermission: vi.fn(),
}));

/** The sockets this test opened, newest last. */
let sockets: FakeSocket[] = [];

/**
 * Enough of a WebSocket to drive the reducer: the hook only ever assigns the
 * four handlers, reads `readyState`, and calls `send`/`close`.
 */
class FakeSocket {
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor() {
    sockets.push(this);
    // The real socket opens asynchronously; opening synchronously inside the
    // constructor would run `setStatus` before the hook has assigned `onopen`.
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  /** Deliver one server frame. */
  emit(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

beforeEach(() => {
  sockets = [];
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const SESSION = 'session-cb324925';

const accepted = { type: 'chat_accepted', session_id: SESSION, visitor_name: 'Anonymous' };

async function connected() {
  const rendered = renderHook(() => useOperatorSocket({ enabled: true, isOperator: true }));
  await waitFor(() => expect(rendered.result.current.status).toBe('connected'));
  return rendered;
}

describe('a conversation that is closed and then accepted again', () => {
  it('drops the ending it recorded the first time round', async () => {
    const { result } = await connected();
    const socket = sockets.at(-1)!;

    act(() => socket.emit(accepted));
    act(() => socket.emit({ type: 'chat_closed', session_id: SESSION }));
    expect(result.current.endedBySession[SESSION]?.reason).toBe('closed');
    expect(result.current.activeChats[SESSION]).toBeUndefined();

    // The visitor comes back and the operator picks the same session up again.
    act(() => socket.emit(accepted));

    expect(result.current.activeChats[SESSION]).toBeDefined();
    // The half that shipped broken: the chat returned to the board still
    // carrying a "closed" ending, and every surface keyed on it stayed closed.
    expect(result.current.endedBySession[SESSION]).toBeUndefined();
  });

  it('drops it after a transfer that comes back too', async () => {
    // `chat_transferred` writes the same record through the same branch, so a
    // conversation transferred away and later handed back had the same defect.
    const { result } = await connected();
    const socket = sockets.at(-1)!;

    act(() => socket.emit(accepted));
    act(() => socket.emit({ type: 'chat_transferred', session_id: SESSION, transferred_to: 'Sales' }));
    expect(result.current.endedBySession[SESSION]?.reason).toBe('transferred');

    act(() => socket.emit(accepted));

    expect(result.current.endedBySession[SESSION]).toBeUndefined();
  });

  it('keeps the ending for a conversation that really did end', async () => {
    // The retraction has to be specific to the session that came back, or
    // closing one chat while another is open would clear the wrong record and
    // the transcript would lose its "this has ended" notice.
    const { result } = await connected();
    const socket = sockets.at(-1)!;

    act(() => socket.emit(accepted));
    act(() => socket.emit({ type: 'chat_accepted', session_id: 'session-other' }));
    act(() => socket.emit({ type: 'chat_closed', session_id: 'session-other' }));
    act(() => socket.emit(accepted));

    expect(result.current.endedBySession['session-other']?.reason).toBe('closed');
  });

  it('drops a stale ending when the server restores the chat after a reconnect', async () => {
    // `active_chats_restore` is the server asserting what this operator is
    // assigned to RIGHT NOW. A chat in that list is not over, whatever this
    // tab believed before its socket dropped.
    const { result } = await connected();
    const socket = sockets.at(-1)!;

    act(() => socket.emit(accepted));
    act(() => socket.emit({ type: 'chat_closed', session_id: SESSION }));
    expect(result.current.endedBySession[SESSION]).toBeDefined();

    act(() =>
      socket.emit({
        type: 'active_chats_restore',
        chats: [{ session_id: SESSION, visitor_name: 'Anonymous', visitor_online: true }],
      }),
    );

    expect(result.current.activeChats[SESSION]).toBeDefined();
    expect(result.current.endedBySession[SESSION]).toBeUndefined();
  });

  it('leaves the transcript alone, which is the reason endings are kept at all', async () => {
    const { result } = await connected();
    const socket = sockets.at(-1)!;

    act(() => socket.emit(accepted));
    act(() =>
      socket.emit({
        type: 'message',
        session_id: SESSION,
        role: 'user',
        content: 'hello',
        timestamp: '2026-09-04T07:14:00.000Z',
        id: 1,
      }),
    );
    act(() => socket.emit({ type: 'chat_closed', session_id: SESSION }));
    act(() => socket.emit(accepted));

    expect(result.current.messagesBySession[SESSION]).toHaveLength(1);
    expect(result.current.messagesBySession[SESSION][0].content).toBe('hello');
  });
});
