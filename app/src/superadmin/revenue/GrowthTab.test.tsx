import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GrowthTab } from './GrowthTab';
import type { BotGrowthEventRow, FunnelResponse, ReferralConversionRow } from './types';

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

const FUNNEL: FunnelResponse = {
  days: 30,
  stages: [
    { label: 'Sessions', value: 1000, pct: 100 },
    { label: 'Engaged', value: 620, pct: 62 },
    { label: 'Converted to paying', value: 12, pct: 1.2 },
  ],
};

function referral(overrides: Partial<ReferralConversionRow> = {}): ReferralConversionRow {
  return {
    id: 5,
    client_id: 42,
    client_name: 'Northwind Security',
    referral_code_id: 2,
    referral_code: 'PARTNER10',
    affiliate_id: 7,
    affiliate_name: 'Acme Partners',
    commission_bps: 2000,
    commission_pct: 20,
    customer_discount_bps: 1000,
    customer_discount_pct: 10,
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function growth(overrides: Partial<BotGrowthEventRow> = {}): BotGrowthEventRow {
  return {
    id: 11,
    bot_id: 9,
    bot_name: 'Support Concierge',
    event_type: 'demo_link_opened',
    created_at: '2026-08-18T00:00:00Z',
    ...overrides,
  };
}

function respond(options: {
  funnel?: FunnelResponse;
  referrals?: ReferralConversionRow[];
  growth?: BotGrowthEventRow[];
} = {}) {
  const { funnel = FUNNEL, referrals = [referral()], growth: events = [growth()] } = options;
  get.mockImplementation((path: string) => {
    if (path.includes('/funnel')) return Promise.resolve({ data: funnel });
    if (path.includes('referral-conversions')) return Promise.resolve({ data: referrals });
    return Promise.resolve({ data: events });
  });
}

function UrlProbe() {
  const location = useLocation();
  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

function mount(url = '/platform/revenue/growth') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <UrlProbe />
      <Routes>
        <Route path="/platform/revenue/growth" element={<GrowthTab />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('GrowthTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads all three lists with the ranges and filters the endpoints accept', async () => {
    respond();
    mount();
    await screen.findByText('Sessions');
    expect(get).toHaveBeenCalledWith('/superadmin/funnel', { params: { days: '30' } });
    expect(get).toHaveBeenCalledWith('/superadmin/referral-conversions', { params: {} });
    expect(get).toHaveBeenCalledWith('/superadmin/bot-growth-events', { params: {} });
  });

  /**
   * The server's `pct` is each stage as a share of stage one, not of the stage
   * before it. Labelling it step-to-step conversion would overstate every drop
   * after the first.
   */
  it('says each stage is a share of the first, not of the previous one', async () => {
    respond();
    mount();
    expect(await screen.findByText('62% of sessions')).toBeInTheDocument();
    expect(screen.getByText('1.2% of sessions')).toBeInTheDocument();
  });

  it('keeps the chosen range in the URL', async () => {
    const user = userEvent.setup();
    respond();
    mount();

    await screen.findByText('Sessions');
    await user.click(screen.getByRole('radio', { name: '7 days' }));

    await waitFor(() => expect(screen.getByTestId('url').textContent).toContain('days=7'));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/superadmin/funnel', { params: { days: '7' } }),
    );
  });

  it('renders snapshotted commission terms as percentages', async () => {
    respond();
    mount();
    expect(await screen.findByText('20%')).toBeInTheDocument();
    expect(screen.getByText('10%')).toBeInTheDocument();
  });

  /* --------------------------------------------------------- four states */

  it('is busy while the lists load', async () => {
    get.mockReturnValue(new Promise(() => {}));
    mount();
    const tables = await screen.findAllByRole('table');
    for (const table of tables) expect(table).toHaveAttribute('aria-busy', 'true');
  });

  it('says a funnel with no sessions has no denominator, rather than showing zeroes', async () => {
    respond({ funnel: { days: 30, stages: [{ label: 'Sessions', value: 0, pct: 0 }] } });
    mount();
    expect(await screen.findByText('No sessions in this window')).toBeInTheDocument();
  });

  it('separates an empty list from an empty filter result', async () => {
    respond({ referrals: [] });
    const { unmount } = mount();
    expect(await screen.findByText('No referral conversions yet')).toBeInTheDocument();
    unmount();

    mount('/platform/revenue/growth?affiliate=99');
    expect(await screen.findByText('No conversions for that affiliate')).toBeInTheDocument();
  });

  it('explains a failure and offers the way back', async () => {
    get.mockRejectedValue(new Error('Database unreachable'));
    mount();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((alert) => alert.textContent?.includes('Database unreachable'))).toBe(true);
  });

  it('says which list the account is not permitted to read', async () => {
    get.mockImplementation((path: string) =>
      path.includes('bot-growth-events')
        ? Promise.reject(
            Object.assign(new Error('failed'), {
              response: { status: 403, data: { detail: 'No privileges.' } },
            }),
          )
        : Promise.resolve({ data: path.includes('/funnel') ? FUNNEL : [referral()] }),
    );
    mount();
    expect(await screen.findByText('You cannot read growth events')).toBeInTheDocument();
    expect(screen.getByText('Acme Partners')).toBeInTheDocument();
  });
});
