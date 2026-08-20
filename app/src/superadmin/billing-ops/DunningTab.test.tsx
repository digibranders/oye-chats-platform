import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DunningTab } from './DunningTab';
import type { DunningItem, DunningResponse } from './types';

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

function item(overrides: Partial<DunningItem> = {}): DunningItem {
  return {
    subscription_id: 1,
    client_id: 10,
    client_email: 'ops@northwind.test',
    plan_name: 'Standard',
    billing_cycle: 'monthly',
    past_due_since: '2026-08-14T00:00:00Z',
    days_elapsed: 5,
    days_left: 2,
    emails_sent: ['day_1'],
    cycle_at_risk_minor: 149_900,
    currency: 'INR',
    ...overrides,
  };
}

function response(items: DunningItem[]): { data: DunningResponse } {
  // Built the way the server builds it: one bucket per currency, rows with no
  // recorded price excluded rather than counted as zero.
  const buckets = new Map<string, number>();
  for (const entry of items) {
    if (entry.cycle_at_risk_minor === null) continue;
    const code = (entry.currency || 'INR').toUpperCase();
    buckets.set(code, (buckets.get(code) ?? 0) + entry.cycle_at_risk_minor);
  }
  return {
    data: {
      count: items.length,
      at_risk_by_currency: [...buckets.entries()]
        .map(([currency, minor]) => ({ currency, minor }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      grace_days: 7,
      items,
    },
  };
}

function mount() {
  return render(
    <MemoryRouter>
      <DunningTab />
    </MemoryRouter>,
  );
}

describe('DunningTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the dunning overview', async () => {
    get.mockResolvedValue(response([item()]));
    mount();
    expect(await screen.findByText('ops@northwind.test')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/superadmin/billing/dunning', expect.anything());
  });

  /**
   * The ordering is the screen. An operator with twenty minutes should be able
   * to work down the list from the top and stop.
   */
  it('lists the least grace remaining first, whatever order the server sent', async () => {
    get.mockResolvedValue(
      response([
        item({ subscription_id: 1, client_email: 'later@test', days_left: 6 }),
        item({ subscription_id: 2, client_email: 'urgent@test', days_left: 0 }),
        item({ subscription_id: 3, client_email: 'middle@test', days_left: 3 }),
      ]),
    );
    mount();

    await screen.findByText('urgent@test');
    const emails = screen
      .getAllByRole('row')
      .map((row) => row.textContent ?? '')
      .filter((text) => text.includes('@test'));
    expect(emails[0]).toContain('urgent@test');
    expect(emails[1]).toContain('middle@test');
    expect(emails[2]).toContain('later@test');
  });

  it('warns in words as well as colour when access is about to be cut off', async () => {
    get.mockResolvedValue(response([item({ days_left: 0 })]));
    mount();
    expect(await screen.findByText('Grace spent')).toBeInTheDocument();
    expect(screen.getByText(/1 account about to lose access/)).toBeInTheDocument();
  });

  it('does not raise the alarm when everyone has room', async () => {
    get.mockResolvedValue(response([item({ days_left: 6 })]));
    mount();
    await screen.findByText('6 days left');
    expect(screen.queryByText(/about to lose access/)).not.toBeInTheDocument();
  });

  /**
   * One tile per currency, never one tile adding paise to cents — which is what
   * the endpoint's old single `at_risk_minor_total` scalar did.
   */
  it('totals the amount at risk per currency', async () => {
    get.mockResolvedValue(
      response([
        item({ subscription_id: 1, currency: 'INR', cycle_at_risk_minor: 100_000 }),
        item({ subscription_id: 2, currency: 'USD', cycle_at_risk_minor: 2_900 }),
      ]),
    );
    mount();

    // Two tiles, one per currency — never one tile adding paise to cents.
    const inrTile = (await screen.findByText('At risk (INR)')).closest('div');
    const usdTile = screen.getByText('At risk (USD)').closest('div');
    expect(inrTile).toHaveTextContent('₹1,000.00 INR');
    expect(usdTile).toHaveTextContent('$29.00 USD');
    // A cross-currency sum (102,900) is never printed, in any tile.
    expect(screen.queryByText(/102,900/)).not.toBeInTheDocument();
  });

  it('leaves a row with no recorded price out of the totals rather than counting it as zero', async () => {
    // A USD-rail customer on a plan with no USD price is a data defect. The
    // server sends null; a console that read it as 0 would report a confident
    // total that is quietly short.
    get.mockResolvedValue(
      response([
        item({ subscription_id: 1, currency: 'USD', cycle_at_risk_minor: 2_900 }),
        item({ subscription_id: 2, currency: 'USD', cycle_at_risk_minor: null }),
      ]),
    );
    mount();

    const usdTile = (await screen.findByText('At risk (USD)')).closest('div');
    expect(usdTile).toHaveTextContent('$29.00 USD');
  });

  it('says which cycle an annual subscription’s figure covers', async () => {
    // The server used to send the monthly price whatever the cycle, so this
    // column carried a caveat. It now sends the annual price for an annual
    // subscription, and the caveat became a label.
    get.mockResolvedValue(response([item({ billing_cycle: 'annual', cycle_at_risk_minor: 1_499_000 })]));
    mount();
    expect(await screen.findByText('one annual cycle')).toBeInTheDocument();
    expect(screen.queryByText('monthly price of an annual plan')).not.toBeInTheDocument();
  });

  it('says whether the automated cadence has already reached the customer', async () => {
    get.mockResolvedValue(
      response([
        item({ subscription_id: 1, emails_sent: [] }),
        item({ subscription_id: 2, days_left: 4, emails_sent: ['day_1', 'day_3'] }),
      ]),
    );
    mount();
    expect(await screen.findByText('No dunning email sent yet')).toBeInTheDocument();
    expect(screen.getByText('2 emails sent (day_1, day_3)')).toBeInTheDocument();
  });

  it('names the grace period the platform is actually configured with', async () => {
    get.mockResolvedValue(response([item()]));
    mount();
    expect(await screen.findByText('7 days')).toBeInTheDocument();
  });

  /* ------------------------------------------------------- the four states */

  it('is busy while it loads', async () => {
    get.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByRole('table')).toHaveAttribute('aria-busy', 'true');
  });

  it('says nobody is failing, which is what a healthy month looks like', async () => {
    get.mockResolvedValue(response([]));
    mount();
    expect(await screen.findByText('Nobody is failing payment')).toBeInTheDocument();
  });

  it('explains a failure and offers the way back', async () => {
    const user = userEvent.setup();
    get.mockRejectedValueOnce(new Error('Database unreachable'));
    mount();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Database unreachable');

    get.mockResolvedValue(response([item()]));
    await user.click(within(alert).getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('ops@northwind.test')).toBeInTheDocument();
  });

  it('says the account is not permitted rather than showing an empty queue', async () => {
    get.mockRejectedValue(
      Object.assign(new Error('failed'), {
        response: { status: 403, data: { detail: 'No privileges.' } },
      }),
    );
    mount();
    expect(await screen.findByText('You cannot read dunning')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});
