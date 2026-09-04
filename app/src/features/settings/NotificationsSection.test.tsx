import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Notifications surface, which did not exist.
 *
 * `GET/PUT /operators/me/notification-preferences` has been consulted on every
 * push dispatch since push shipped and had no client function and no UI, so the
 * only way to stop a 3am handoff alert was to revoke notifications in the
 * browser and lose all of them. What is pinned is that the stored preference is
 * actually read, that the save carries a complete object, and that the four
 * states are four different answers.
 */

const api = vi.hoisted(() => ({
  getNotificationPreferences: vi.fn(),
  updateNotificationPreferences: vi.fn(),
}));
vi.mock('../../services/api', () => api);

const push = vi.hoisted(() => ({
  supported: true,
  phase: { status: 'default' } as { status: string; message?: string; reason?: string },
  busy: false,
  actionError: '',
  enable: vi.fn(),
  disable: vi.fn(),
  recheck: vi.fn(),
}));
vi.mock('../../hooks/usePushSubscription', () => ({ usePushSubscription: () => push }));

const { NotificationsSection } = await import('./NotificationsSection');

// A menu, a dialog and a mutation sit comfortably inside the default 5s budget
// in isolation, and comfortably outside it when the whole suite runs in
// parallel on a loaded machine. This is a statement about the runner, not about
// what is being asserted — the assertions themselves all settle in milliseconds.
vi.setConfig({ testTimeout: 20_000 });

function renderSection() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <NotificationsSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  push.phase = { status: 'default' };
  push.actionError = '';
  api.getNotificationPreferences.mockResolvedValue({
    push: {
      enabled: true,
      events: { handoff_request: true, chat_transferred: true, offline_message: false },
      quiet_hours: null,
    },
  });
  api.updateNotificationPreferences.mockImplementation(async (body: unknown) => body);
});

describe('NotificationsSection — the four states', () => {
  it('shows a loading placeholder for the stored preferences', () => {
    api.getNotificationPreferences.mockReturnValue(new Promise(() => {}));
    renderSection();
    expect(document.querySelector('[aria-busy]')).not.toBeNull();
  });

  it('reports a failure to load without hiding the device controls', async () => {
    api.getNotificationPreferences.mockRejectedValue(new Error('service unavailable'));
    renderSection();
    expect(
      await screen.findByText('We could not load your alert preferences'),
    ).toBeInTheDocument();
    // The per-device layer still works — it does not depend on the account one.
    expect(screen.getByRole('button', { name: /turn on for this device/i })).toBeInTheDocument();
  });

  it('says plainly when the browser cannot do push at all', async () => {
    push.phase = { status: 'unsupported', reason: 'no-push-api' };
    renderSection();
    expect(await screen.findByText(/cannot receive push notifications/i)).toBeInTheDocument();
  });

  it('tells an iOS visitor to add it to the Home Screen, not that push is desktop-only', async () => {
    // iOS Chrome and Safari share WebKit, so both are missing PushManager in a
    // plain tab. The generic "desktop only" copy above is actively wrong here:
    // the fix is one tap away, since the app already ships full PWA install
    // support for exactly this case.
    push.phase = { status: 'unsupported', reason: 'ios-not-installed' };
    renderSection();
    expect(await screen.findByText(/add oyechats to your home screen/i)).toBeInTheDocument();
  });

  it('tells an already-installed iOS visitor to update iOS, not to reinstall', async () => {
    push.phase = { status: 'unsupported', reason: 'ios-too-old' };
    renderSection();
    expect(await screen.findByText(/already on the home screen/i)).toBeInTheDocument();
  });

  it('says we cannot undo a browser block from here', async () => {
    push.phase = { status: 'denied' };
    renderSection();
    expect(
      await screen.findByText('Notifications are blocked in your browser'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-check/i })).toBeInTheDocument();
  });
});

describe('NotificationsSection — the account preference', () => {
  it('renders what the server actually stored, not the defaults', async () => {
    renderSection();
    const offline = await screen.findByRole('switch', {
      name: /someone leaves a message while you are away/i,
    });
    expect(offline).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.getByRole('switch', { name: /a visitor asks for a person/i }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('says nothing is unsaved until something is, and can discard it', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByRole('switch', { name: /a visitor asks for a person/i });

    expect(screen.getByText('Everything here is saved.')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: /a visitor asks for a person/i }));
    expect(await screen.findByText('You have unsaved changes.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /discard/i }));
    expect(screen.getByText('Everything here is saved.')).toBeInTheDocument();
    expect(api.updateNotificationPreferences).not.toHaveBeenCalled();
  });

  it('sends the whole push object, because the PUT replaces it', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByRole('switch', { name: /a visitor asks for a person/i });

    await user.click(screen.getByRole('switch', { name: /a visitor asks for a person/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(api.updateNotificationPreferences).toHaveBeenCalledWith({
        push: {
          enabled: true,
          events: {
            handoff_request: false,
            chat_transferred: true,
            offline_message: false,
          },
          quiet_hours: null,
        },
      }),
    );
  });

  it('warns when the combination means nothing can reach them', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByRole('switch', { name: /send me push alerts/i });

    await user.click(screen.getByRole('switch', { name: /send me push alerts/i }));
    expect(await screen.findByText(/Nothing can reach you right now/i)).toBeInTheDocument();
  });

  it('offers quiet hours with a sensible night, and explains the wrap', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByRole('switch', { name: /quiet hours/i });

    await user.click(screen.getByRole('switch', { name: /quiet hours/i }));
    expect(await screen.findByLabelText(/^from/i)).toHaveValue('22:00');
    expect(screen.getByLabelText(/^until/i)).toHaveValue('07:00');
    expect(screen.getByText(/the next morning/i)).toBeInTheDocument();
  });

  it('saves quiet hours as the server’s HH:MM shape', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByRole('switch', { name: /quiet hours/i });

    await user.click(screen.getByRole('switch', { name: /quiet hours/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(api.updateNotificationPreferences).toHaveBeenCalled());
    const body = api.updateNotificationPreferences.mock.calls[0][0] as {
      push: { quiet_hours: { start: string; end: string; tz: string } | null };
    };
    expect(body.push.quiet_hours?.start).toBe('22:00');
    expect(body.push.quiet_hours?.end).toBe('07:00');
    expect(body.push.quiet_hours?.tz).toBeTruthy();
  });
});
