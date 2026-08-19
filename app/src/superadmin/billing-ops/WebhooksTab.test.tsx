import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebhooksTab } from './WebhooksTab';
import type { ProcessedWebhookRow } from './types';

const get = vi.fn();

vi.mock('../../services/api', () => ({
  httpClient: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  getApiBaseUrl: () => '',
}));

const EVENT_ID = 'evt_QaBcDeFgHiJkLmNoPq';

function event(overrides: Partial<ProcessedWebhookRow> = {}): ProcessedWebhookRow {
  return {
    event_id: EVENT_ID,
    provider: 'razorpay',
    processed_at: '2026-08-19T09:30:00Z',
    ...overrides,
  };
}

function UrlProbe() {
  const location = useLocation();
  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

function mount(url = '/platform/billing-ops/webhooks') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <UrlProbe />
      <Routes>
        <Route path="/platform/billing-ops/webhooks" element={<WebhooksTab />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('WebhooksTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the log unfiltered', async () => {
    get.mockResolvedValue({ data: [event()] });
    mount();
    await screen.findByText(EVENT_ID);
    expect(get).toHaveBeenCalledWith('/superadmin/processed-webhooks', { params: {} });
  });

  /** The whole point of the screen is matching an id read out of the gateway. */
  it('shows the event id in full, not truncated', async () => {
    get.mockResolvedValue({ data: [event()] });
    mount();
    expect(await screen.findByText(EVENT_ID)).toBeInTheDocument();
    expect(screen.queryByText(/…/)).not.toBeInTheDocument();
  });

  it('invents no column the endpoint does not return', async () => {
    get.mockResolvedValue({ data: [event()] });
    mount();
    await screen.findByText(EVENT_ID);
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent?.trim());
    expect(headers).toEqual(['Processed', 'Provider', 'Event id']);
  });

  it('keeps the provider filter in the URL and sends it', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({ data: [event()] });
    mount();

    await screen.findByText(EVENT_ID);
    await user.type(screen.getByLabelText(/filter by provider/i), 'razorpay');

    await waitFor(() => expect(screen.getByTestId('url').textContent).toContain('provider=razorpay'));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/superadmin/processed-webhooks', {
        params: { provider: 'razorpay' },
      }),
    );
  });

  it('says the list is truncated once the cap is reached', async () => {
    get.mockResolvedValue({
      data: Array.from({ length: 500 }, (_, index) => event({ event_id: `evt_${index}` })),
    });
    mount();
    expect(await screen.findByText('Truncated at 500 events')).toBeInTheDocument();
  });

  /* --------------------------------------------------------- four states */

  it('is busy while the log loads', async () => {
    get.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByRole('table')).toHaveAttribute('aria-busy', 'true');
  });

  it('treats an empty log as something to act on, not as normal', async () => {
    get.mockResolvedValue({ data: [] });
    mount();
    expect(await screen.findByText('No webhook has been processed')).toBeInTheDocument();
    expect(screen.getByText(/webhooks are not reaching the API at all/)).toBeInTheDocument();
  });

  it('separates an empty log from an unmatched provider', async () => {
    get.mockResolvedValue({ data: [] });
    mount('/platform/billing-ops/webhooks?provider=stripe');
    expect(await screen.findByText('No events from that provider')).toBeInTheDocument();
  });

  it('explains a failure and offers the way back', async () => {
    get.mockRejectedValue(new Error('Redis unreachable'));
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent('Redis unreachable');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('says the account is not permitted rather than showing an empty log', async () => {
    get.mockRejectedValue(
      Object.assign(new Error('failed'), {
        response: { status: 403, data: { detail: 'No privileges.' } },
      }),
    );
    mount();
    expect(await screen.findByText('You cannot read the webhook log')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
