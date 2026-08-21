import { useEffect } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboundScreen } from './OutboundScreen';
import { PAGE_SIZE } from '../recordListState';
import type { WebhookDelivery } from './types';

const httpClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('../../services/api', () => ({ httpClient }));

function delivery(id: number, overrides: Partial<WebhookDelivery> = {}): WebhookDelivery {
  return {
    id,
    webhook_id: 9,
    event: 'tier_transition',
    status_code: 200,
    attempt: 1,
    next_retry_at: null,
    created_at: '2026-08-19T09:00:00Z',
    delivered_at: '2026-08-19T09:00:01Z',
    ...overrides,
  };
}

let currentSearch = '';

// Recorded in an effect rather than during render: reassigning a module
// variable while rendering is a side effect, and the lint rule that forbids it
// is right even in a test double.
function Probe() {
  const { search } = useLocation();
  useEffect(() => {
    currentSearch = search;
  }, [search]);
  return null;
}

/** Each outbound surface is its own route now, so the view is a prop. */
function renderScreen(
  entry = '/platform/platform/deliveries',
  view: 'deliveries' | 'registrations' | 'failed' | 'email' = 'deliveries',
) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <OutboundScreen view={view} />
      <Probe />
    </MemoryRouter>,
  );
}

/** Route the mocked client by path, since this screen reads several endpoints. */
function respond(map: Record<string, unknown>) {
  httpClient.get.mockImplementation((path: string) => {
    if (path in map) return Promise.resolve({ data: map[path] });
    return Promise.resolve({ data: [] });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  currentSearch = '';
});

/**
 * A replay is a repeat of an event a customer's system may already have acted
 * on. These pin the gate in front of it, and the paging that keeps the 500-row
 * delivery log readable and linkable.
 */
describe('OutboundScreen', () => {
  it('says what a replay actually is, before any control is touched', async () => {
    respond({ '/superadmin/webhooks': [delivery(1)] });
    renderScreen();
    // One clause on the section, not a standing warning card above the table.
    expect(await screen.findByText(/a replay is a repeat/)).toBeInTheDocument();
  });

  it('never replays on the first click', async () => {
    const user = userEvent.setup();
    respond({ '/superadmin/webhooks': [delivery(1)] });
    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'Replay' }));
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(httpClient.post).not.toHaveBeenCalled();
  });

  it('warns about the double-charge in the confirmation, then replays', async () => {
    const user = userEvent.setup();
    respond({ '/superadmin/webhooks': [delivery(1)] });
    httpClient.post.mockResolvedValue({ data: { ok: true } });
    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'Replay' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/see the event twice/i);
    expect(dialog).toHaveTextContent(/charge or provision somebody twice/i);

    await user.click(screen.getByRole('button', { name: 'Replay delivery' }));
    await waitFor(() =>
      expect(httpClient.post).toHaveBeenCalledWith('/superadmin/webhooks/1/replay', {}),
    );
  });

  it('abandons the replay when the confirmation is cancelled', async () => {
    const user = userEvent.setup();
    respond({ '/superadmin/webhooks': [delivery(1)] });
    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'Replay' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(httpClient.post).not.toHaveBeenCalled();
  });

  it('keeps the failure inside the dialog rather than closing on a refusal', async () => {
    const user = userEvent.setup();
    respond({ '/superadmin/webhooks': [delivery(1)] });
    httpClient.post.mockRejectedValue({
      response: { status: 400, data: { detail: 'Parent webhook is inactive.' } },
    });
    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'Replay' }));
    await user.click(await screen.findByRole('button', { name: 'Replay delivery' }));
    expect(await screen.findByText('Parent webhook is inactive.')).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('pages the delivery log and keeps the page in the URL', async () => {
    const user = userEvent.setup();
    const total = PAGE_SIZE * 2 + 10;
    respond({
      '/superadmin/webhooks': Array.from({ length: total }, (_, index) => delivery(index + 1)),
    });
    renderScreen();

    const pager = await screen.findByRole('navigation', { name: /pages/i });
    // The pager reports the whole set, not the page of rows on screen. Written
    // against the console's shared `PAGE_SIZE` rather than a literal: this
    // screen declared its own 25 while coupons declared 20 and the record lists
    // used 50, so a reader met three page lengths crossing three tabs.
    expect(pager).toHaveTextContent(`1–${PAGE_SIZE} of ${total}`);

    await user.click(within(pager).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(currentSearch).toContain('page=2'));
    expect(await screen.findByRole('navigation', { name: /pages/i })).toHaveTextContent(
      `${PAGE_SIZE + 1}–${PAGE_SIZE * 2} of ${total}`,
    );
  });

  it('opens on the page named in the URL, so a link lands where it was sent from', async () => {
    const total = PAGE_SIZE * 2 + 10;
    respond({
      '/superadmin/webhooks': Array.from({ length: total }, (_, index) => delivery(index + 1)),
    });
    renderScreen('/platform/platform/deliveries?page=3');
    expect(await screen.findByRole('navigation', { name: /pages/i })).toHaveTextContent(
      `${PAGE_SIZE * 2 + 1}–${total} of ${total}`,
    );
  });

  /**
   * Each surface is a route, so only the one on screen fetches — the four used
   * to hide behind a segmented control inside a tab inside a tab row.
   */
  it('fetches only the surface on screen', async () => {
    respond({ '/superadmin/webhooks': [delivery(1)], '/superadmin/failed-webhooks': [] });
    const deliveries = renderScreen();
    await screen.findByText('Outbound deliveries');
    expect(httpClient.get).toHaveBeenCalledWith('/superadmin/webhooks', { params: {} });
    expect(httpClient.get).not.toHaveBeenCalledWith('/superadmin/webhook-registrations', { params: {} });
    deliveries.unmount();

    renderScreen('/platform/platform/registrations', 'registrations');
    await waitFor(() =>
      expect(httpClient.get).toHaveBeenCalledWith('/superadmin/webhook-registrations', { params: {} }),
    );
  });

  it('offers the empty, error and forbidden states on the delivery log', async () => {
    respond({ '/superadmin/webhooks': [] });
    const empty = renderScreen();
    expect(await screen.findByText('Nothing has been delivered')).toBeInTheDocument();
    empty.unmount();

    httpClient.get.mockRejectedValue({ response: { status: 500, data: { detail: 'Database down.' } } });
    const failed = renderScreen();
    expect(await screen.findByText('Database down.')).toBeInTheDocument();
    failed.unmount();

    httpClient.get.mockRejectedValue({ response: { status: 403, data: { detail: 'Nope.' } } });
    renderScreen();
    expect(await screen.findByText('You cannot read this')).toBeInTheDocument();
  });
});
