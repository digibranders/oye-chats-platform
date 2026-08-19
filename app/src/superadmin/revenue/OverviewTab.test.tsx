import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OverviewTab } from './OverviewTab';
import type { RevenueCohort, RevenueMetrics } from './types';

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

const METRICS: RevenueMetrics = {
  currency: 'USD',
  mrr_cents: 418_200,
  arr_cents: 5_018_400,
  total_revenue_cents: 22_400_000,
  subscription_counts: {
    active: 214,
    trialing: 18,
    past_due: 6,
    canceled: 41,
    paused: 2,
    expired: 9,
  },
  total_paying_customers: 220,
};

const COHORTS: RevenueCohort[] = [
  { cohort: '2026-06', signups: 40, retained: 10, ltv_cents: 120_000 },
  { cohort: '2026-07', signups: 60, retained: 30, ltv_cents: 300_000 },
  { cohort: '2026-08', signups: 0, retained: 0, ltv_cents: 0 },
];

function respond(metrics: RevenueMetrics | null = METRICS, cohorts: RevenueCohort[] = COHORTS) {
  get.mockImplementation((path: string) =>
    Promise.resolve({ data: path.includes('cohorts') ? cohorts : metrics }),
  );
}

function mount() {
  return render(
    <MemoryRouter>
      <OverviewTab />
    </MemoryRouter>,
  );
}

describe('OverviewTab', () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * These figures are USD the server produced by dividing INR amounts by a
   * fixed internal rate. They look like real dollars and are not — so the page
   * says so, once, prominently, rather than in eight tooltips nobody opens.
   */
  it('states that its figures are a conversion, not a currency anyone was charged', async () => {
    respond();
    mount();
    const notice = await screen.findByText(/Every figure on this tab is normalised/);
    const alert = notice.closest('div');
    expect(alert).toHaveTextContent(/INR were converted/);
    expect(alert).toHaveTextContent(/not a market FX rate/);
  });

  it('labels each headline figure with the currency it is in', async () => {
    respond();
    mount();
    expect(await screen.findByText('$4,182')).toBeInTheDocument();
    expect(screen.getAllByText('USD (converted)').length).toBeGreaterThanOrEqual(3);
  });

  it('does not label a customer count as a currency', async () => {
    respond();
    mount();
    const tile = (await screen.findByText('Paying customers')).closest('div');
    expect(tile).toHaveTextContent('220');
    expect(tile).toHaveTextContent('Right now');
    expect(tile).not.toHaveTextContent('USD');
  });

  it('shows the subscription mix with a word beside every count', async () => {
    respond();
    mount();
    const chart = await screen.findByRole('list', { name: /subscriptions by status/i });
    expect(within(chart).getByText('Active')).toBeInTheDocument();
    expect(within(chart).getByText('Past due')).toBeInTheDocument();
    expect(within(chart).getByText('214')).toBeInTheDocument();
  });

  it('puts the most recent cohort first', async () => {
    respond();
    mount();
    await screen.findByText('2026-08');
    const months = screen
      .getAllByRole('row')
      .map((row) => row.textContent ?? '')
      .filter((text) => /2026-0/.test(text));
    expect(months[0]).toContain('2026-08');
    expect(months[2]).toContain('2026-06');
  });

  it('computes retention, and reports no rate at all for a cohort with no signups', async () => {
    respond();
    mount();
    await screen.findByText('2026-07');
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    // 0/0 is not 0% — an empty cohort has no retention rate.
    const emptyRow = screen.getAllByRole('row').find((row) => row.textContent?.includes('2026-08'));
    expect(emptyRow).toHaveTextContent('—');
  });

  it('sorts a cohort column on demand', async () => {
    const user = userEvent.setup();
    respond();
    mount();

    await screen.findByText('2026-08');
    await user.click(screen.getByRole('button', { name: /signups/i }));
    const header = screen.getByRole('columnheader', { name: /signups/i });
    expect(header).toHaveAttribute('aria-sort', 'ascending');
  });

  /* --------------------------------------------------------- four states */

  it('is busy while the figures load', async () => {
    get.mockReturnValue(new Promise(() => {}));
    mount();
    expect(await screen.findByRole('table')).toHaveAttribute('aria-busy', 'true');
  });

  it('says there are no cohorts and why', async () => {
    respond(METRICS, []);
    mount();
    expect(await screen.findByText('No cohorts yet')).toBeInTheDocument();
  });

  it('explains a failed read of the aggregates and offers the way back', async () => {
    get.mockImplementation((path: string) =>
      path.includes('cohorts')
        ? Promise.resolve({ data: COHORTS })
        : Promise.reject(new Error('Database unreachable')),
    );
    mount();
    // A live region, so a screen-reader user learns the figures failed rather
    // than being left with a card that never fills in.
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent('Database unreachable');
    expect(within(notice).getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('says the account is not permitted rather than showing zeroes', async () => {
    get.mockRejectedValue(
      Object.assign(new Error('failed'), {
        response: { status: 403, data: { detail: 'No privileges.' } },
      }),
    );
    mount();
    expect(await screen.findByText('You cannot read revenue')).toBeInTheDocument();
    expect(await screen.findByText('You cannot read cohorts')).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });
});
