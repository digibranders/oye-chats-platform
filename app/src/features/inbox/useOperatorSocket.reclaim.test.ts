import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/api', () => ({
  getChatHistory: vi.fn(async () => []),
  getMyLanguage: vi.fn(async () => ({ locale: null, available: [] })),
}));
vi.mock('../../utils/authStorage', () => ({ getAuthItem: () => 'test-token' }));
vi.mock('../../utils/impersonation', () => ({ isImpersonating: () => false }));
vi.mock('./notifications', () => ({
  alertOperator: vi.fn(),
  ensureNotificationPermission: vi.fn(),
}));

import { useOperatorSocket } from './useOperatorSocket';

/**
 * One socket per operator, and what the tab that loses it can do.
 *
 * A second tab supersedes the first; the server closes the loser with 4001.
 * That close is terminal ON PURPOSE — an automatic reconnect would have the
 * two tabs take the channel from each other forever — but it left the losing
 * tab with no queue, no active chats, and no way back except toggling
 * availability off and on, which is not a thing anyone would guess.
 *
 * So the contract is exactly two rules: never reconnect on its own, and
 * reconnect when the operator asks.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  sent: string[] = [];

  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** The server closing this tab out because another one took the channel. */
  supersede(): void {
    this.readyState = 3;
    this.onclose?.({ code: 4001, reason: 'Session opened in another tab' });
  }
}

describe('useOperatorSocket, when another tab takes the channel', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not fight the other tab for the connection', async () => {
    const { result } = renderHook(() => useOperatorSocket({ enabled: true, isOperator: true }));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    act(() => FakeSocket.instances[0].open());

    act(() => FakeSocket.instances[0].supersede());
    await waitFor(() => expect(result.current.status).toBe('duplicate'));

    // The reconnect backoff must stay out of this: a tab war is worse than a
    // quiet tab. Given time to misbehave, it opens nothing.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('reconnects when the operator asks for the channel back', async () => {
    const { result } = renderHook(() => useOperatorSocket({ enabled: true, isOperator: true }));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    act(() => FakeSocket.instances[0].open());
    act(() => FakeSocket.instances[0].supersede());
    await waitFor(() => expect(result.current.status).toBe('duplicate'));

    act(() => result.current.reclaim());

    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
  });
});
