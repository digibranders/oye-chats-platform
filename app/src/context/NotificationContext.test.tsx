import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NotificationItem } from '../types/domain';

/**
 * `dismiss` and the bell badge.
 *
 * The count used to be decremented from a value assigned inside the `setItems`
 * updater. React runs that updater during the next render unless its "eager
 * state" path happens to evaluate it inline, so the decrement fired only when
 * the update queue was empty - dismissing an unread notification usually left
 * the badge counting a row that was no longer in the list, until the next
 * hydrate or the 30s poll quietly corrected it. What is pinned here is that a
 * dismissal is accounted for immediately, once per removed unread row, whether
 * one or several land in the same batch.
 */

const api = vi.hoisted(() => ({
  listNotifications: vi.fn(),
  getUnreadNotificationCount: vi.fn(),
  markAllNotificationsRead: vi.fn(),
  markNotificationRead: vi.fn(),
  deleteNotification: vi.fn(),
  clearAllNotifications: vi.fn(),
}));
vi.mock('../services/api', () => api);

const { NotificationProvider, useNotifications } = await import('./NotificationContext');

function notification(id: number, isRead: boolean): NotificationItem {
  return {
    id,
    type: 'offline_message',
    title: `Notification ${id}`,
    is_read: isRead,
    created_at: '2026-08-28T09:00:00Z',
  };
}

/** A socket that connects to nothing: the feed under test is the REST one. */
class SilentWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = SilentWebSocket.CONNECTING;
  send(): void {}
  close(): void {
    this.readyState = SilentWebSocket.CLOSED;
  }
}

function Probe() {
  const { items, unreadCount, dismiss } = useNotifications();
  return (
    <div>
      <output data-testid="unread">{unreadCount}</output>
      <output data-testid="ids">{items.map((item) => item.id).join(',')}</output>
      <button type="button" onClick={() => void dismiss(1)}>
        dismiss unread
      </button>
      <button type="button" onClick={() => void dismiss(3)}>
        dismiss read
      </button>
      <button
        type="button"
        onClick={() => {
          void dismiss(1);
          void dismiss(2);
        }}
      >
        dismiss both unread
      </button>
    </div>
  );
}

async function renderFeed() {
  render(
    <NotificationProvider>
      <Probe />
    </NotificationProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('1,2,3'));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('WebSocket', SilentWebSocket);
  window.localStorage.setItem('admin_token', 'test-api-key');
  api.listNotifications.mockResolvedValue({
    items: [notification(1, false), notification(2, false), notification(3, true)],
    unread_count: 2,
  });
  api.getUnreadNotificationCount.mockResolvedValue(2);
  api.deleteNotification.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('NotificationProvider.dismiss', () => {
  it('drops the unread count by exactly one when an unread notification is dismissed', async () => {
    const user = userEvent.setup();
    await renderFeed();
    expect(screen.getByTestId('unread')).toHaveTextContent('2');

    await user.click(screen.getByRole('button', { name: 'dismiss unread' }));

    expect(screen.getByTestId('ids')).toHaveTextContent('2,3');
    expect(screen.getByTestId('unread')).toHaveTextContent('1');
    expect(api.deleteNotification).toHaveBeenCalledWith(1);
  });

  it('leaves the unread count alone when the dismissed notification was already read', async () => {
    const user = userEvent.setup();
    await renderFeed();

    await user.click(screen.getByRole('button', { name: 'dismiss read' }));

    expect(screen.getByTestId('ids')).toHaveTextContent('1,2');
    expect(screen.getByTestId('unread')).toHaveTextContent('2');
  });

  it('accounts for every unread dismissal batched into one handler', async () => {
    const user = userEvent.setup();
    await renderFeed();

    // Two dismissals in a single batch: the second `setItems` lands on a
    // non-empty update queue, which is exactly the case where reading the
    // removed row out of the updater used to come back empty.
    await user.click(screen.getByRole('button', { name: 'dismiss both unread' }));

    expect(screen.getByTestId('ids')).toHaveTextContent('3');
    expect(screen.getByTestId('unread')).toHaveTextContent('0');
  });

  it('re-hydrates when the delete call fails', async () => {
    const user = userEvent.setup();
    api.deleteNotification.mockRejectedValue(new Error('gone'));
    await renderFeed();
    api.listNotifications.mockResolvedValue({
      items: [notification(1, false), notification(2, false), notification(3, true)],
      unread_count: 2,
    });

    await user.click(screen.getByRole('button', { name: 'dismiss unread' }));

    await waitFor(() => expect(screen.getByTestId('ids')).toHaveTextContent('1,2,3'));
    expect(screen.getByTestId('unread')).toHaveTextContent('2');
  });
});
