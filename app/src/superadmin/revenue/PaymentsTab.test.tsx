import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentsTab } from './PaymentsTab';
import type { BillingFunnelResponse, PaymentMethodRow } from './types';

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

function method(overrides: Partial<PaymentMethodRow> = {}): PaymentMethodRow {
  return {
    id: 3,
    client_id: 42,
    client_name: 'Northwind Security',
    provider: 'razorpay',
    type: 'card',
    last4: '4242',
    network: 'Visa',
    issuer: 'HDFC',
    upi_handle: null,
    is_default: true,
    synced_at: '2026-08-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const FUNNEL: BillingFunnelResponse = {
  days: 7,
  counts: [
    { surface: 'checkout', event: 'sheet_opened', count: 40 },
    { surface: 'checkout', event: 'payment_failed', count: 6 },
  ],
  recent: [
    {
      id: 1,
      client_id: 42,
      client_email: 'ops@northwind.test',
      event: 'payment_failed',
      surface: 'checkout',
      meta: null,
      created_at: '2026-08-19T09:00:00Z',
    },
  ],
};

function respond(methods: PaymentMethodRow[], funnel: BillingFunnelResponse | null = FUNNEL) {
  get.mockImplementation((path: string) => {
    if (path.includes('billing-funnel')) return Promise.resolve({ data: funnel });
    if (path.includes('payment-methods')) return Promise.resolve({ data: methods });
    // The account directory the one filter picks from.
    return Promise.resolve({
      data: [{ id: 42, name: 'Northwind Security', email: 'ops@northwind.test' }],
    });
  });
}

function UrlProbe() {
  const location = useLocation();
  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

function mount(url = '/platform/revenue/payments') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <UrlProbe />
      <Routes>
        <Route path="/platform/revenue/payments" element={<PaymentsTab />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PaymentsTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the funnel for the default window and the methods unfiltered', async () => {
    respond([method()]);
    mount();
    await screen.findByText('Northwind Security');
    expect(get).toHaveBeenCalledWith('/superadmin/billing-funnel?days=7&limit=50', expect.anything());
    expect(get).toHaveBeenCalledWith('/superadmin/payment-methods', { params: {} });
  });

  it('keeps the chosen window in the URL and re-reads the funnel', async () => {
    const user = userEvent.setup();
    respond([method()]);
    mount();

    await screen.findByText('Northwind Security');
    await user.click(screen.getByRole('radio', { name: '30 days' }));

    await waitFor(() => expect(screen.getByTestId('url').textContent).toContain('days=30'));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/superadmin/billing-funnel?days=30&limit=50', expect.anything()),
    );
  });

  it('ignores a window the endpoint would refuse', async () => {
    respond([method()]);
    mount('/platform/revenue/payments?days=9999');
    await waitFor(() => expect(get).toHaveBeenCalledWith('/superadmin/billing-funnel?days=7&limit=50', expect.anything()));
  });

  it('shows the instrument without revealing anything the server masked', async () => {
    respond([method({ type: 'upi', last4: null, upi_handle: '••••@ybl' })]);
    mount();
    expect(await screen.findByText(/••••@ybl/)).toBeInTheDocument();
  });

  /** The filter names the account rather than asking for its integer id. */
  it('filters the methods list by account, through the URL', async () => {
    const user = userEvent.setup();
    respond([method()]);
    mount();

    await screen.findAllByText('Northwind Security');
    await user.click(screen.getByLabelText(/filter payment methods by account/i));
    await user.click(await screen.findByRole('option', { name: /Northwind Security/ }));

    await waitFor(() => expect(screen.getByTestId('url').textContent).toContain('client=42'));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/superadmin/payment-methods', { params: { client_id: '42' } }),
    );
  });

  /* --------------------------------------------------------- four states */

  it('is busy while the lists load', async () => {
    get.mockReturnValue(new Promise(() => {}));
    mount();
    const tables = await screen.findAllByRole('table');
    for (const table of tables) expect(table).toHaveAttribute('aria-busy', 'true');
  });

  it('says a quiet checkout window is worth checking rather than showing nothing', async () => {
    respond([method()], { days: 7, counts: [], recent: [] });
    mount();
    expect(await screen.findByText('No checkout activity in this window')).toBeInTheDocument();
  });

  it('separates an empty platform from an empty client filter', async () => {
    respond([]);
    const { unmount } = mount();
    expect(await screen.findByText('No payment methods stored')).toBeInTheDocument();
    unmount();

    mount('/platform/revenue/payments?client=999');
    expect(await screen.findByText('No methods for that client')).toBeInTheDocument();
  });

  it('explains a failure and offers the way back', async () => {
    get.mockRejectedValue(new Error('Database unreachable'));
    mount();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((alert) => alert.textContent?.includes('Database unreachable'))).toBe(true);
  });

  it('says which half the account is not permitted to read', async () => {
    get.mockImplementation((path: string) =>
      path.includes('payment-methods')
        ? Promise.reject(
            Object.assign(new Error('failed'), {
              response: { status: 403, data: { detail: 'No privileges.' } },
            }),
          )
        : Promise.resolve({ data: FUNNEL }),
    );
    mount();
    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
    expect(screen.getByText('sheet opened')).toBeInTheDocument();
  });
});
