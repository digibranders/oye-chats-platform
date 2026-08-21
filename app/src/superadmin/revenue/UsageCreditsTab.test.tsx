import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageCreditsTab } from './UsageCreditsTab';
import type { CreditLedgerRow, UsageRecordRow } from './types';

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

function usage(overrides: Partial<UsageRecordRow> = {}): UsageRecordRow {
  return {
    id: 5,
    client_id: 42,
    client_name: 'Northwind Security',
    plan_id: 3,
    plan_name: 'Standard',
    period_start: '2026-08-01T00:00:00Z',
    period_end: '2026-09-01T00:00:00Z',
    ai_messages_used: 412,
    ai_messages_limit: 500,
    live_chat_messages_used: 20,
    live_chat_messages_limit: 100,
    url_scans_used: 2,
    url_scans_limit: 10,
    storage_used_mb: 40,
    storage_limit_mb: 500,
    bots_count: 2,
    operators_count: 3,
    overage_messages: 0,
    overage_amount_cents: 0,
    ...overrides,
  };
}

function ledger(overrides: Partial<CreditLedgerRow> = {}): CreditLedgerRow {
  return {
    id: 900,
    client_id: 42,
    delta: -120,
    balance_after: 8_800,
    reason: 'AI message',
    grant_id: 12,
    expires_at: null,
    created_at: '2026-08-19T10:00:00Z',
    ...overrides,
  };
}

/**
 * Three lists load in parallel — the two the tab is about, plus the account
 * directory the one filter picks from — so the mock answers by path.
 */
function respond(usageRows: UsageRecordRow[], ledgerRows: CreditLedgerRow[]) {
  get.mockImplementation((path: string) => {
    if (path.includes('usage-records')) return Promise.resolve({ data: usageRows });
    if (path.includes('credits/ledger')) return Promise.resolve({ data: ledgerRows });
    return Promise.resolve({
      data: [{ id: 42, name: 'Northwind Security', email: 'ops@northwind.test' }],
    });
  });
}

function UrlProbe() {
  const location = useLocation();
  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

function mount(url = '/platform/revenue/usage') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <UrlProbe />
      <Routes>
        <Route path="/platform/revenue/usage" element={<UsageCreditsTab />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('UsageCreditsTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads both lists, unfiltered, on arrival', async () => {
    respond([usage()], [ledger()]);
    mount();
    await screen.findByText('Northwind Security');
    expect(get).toHaveBeenCalledWith('/superadmin/usage-records', { params: {} });
    expect(get).toHaveBeenCalledWith('/superadmin/credits/ledger', { params: {} });
  });

  /**
   * The filter names the account. It used to ask the operator to type its
   * integer primary key, which nobody knows.
   */
  it('applies one client filter to both lists, through the URL', async () => {
    const user = userEvent.setup();
    respond([usage()], [ledger()]);
    mount();

    await screen.findAllByText('Northwind Security');
    await user.click(screen.getByLabelText(/filter both lists by account/i));
    await user.click(await screen.findByRole('option', { name: /Northwind Security/ }));

    await waitFor(() => expect(screen.getByTestId('url').textContent).toContain('client=42'));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/superadmin/usage-records', { params: { client_id: '42' } }),
    );
    expect(get).toHaveBeenCalledWith('/superadmin/credits/ledger', { params: { client_id: '42' } });
  });

  /** The UNLIMITED sentinel is `-1` in the plan tables. It is never a number here. */
  it('renders an unlimited allowance as a word, never as -1', async () => {
    respond([usage({ ai_messages_limit: -1, ai_messages_used: 9_000 })], []);
    mount();
    expect(await screen.findByText('9,000 / Unlimited')).toBeInTheDocument();
    expect(screen.queryByText(/\/ -1/)).not.toBeInTheDocument();
  });

  it('escalates a quota that is nearly or fully spent', async () => {
    respond([usage({ ai_messages_used: 500, ai_messages_limit: 500 })], []);
    mount();
    expect(await screen.findByText('500 / 500')).toBeInTheDocument();
  });

  it('says “none” for no overage rather than printing a zero amount', async () => {
    respond([usage({ overage_messages: 0, overage_amount_cents: 0 })], []);
    mount();
    expect(await screen.findByText('None')).toBeInTheDocument();
  });

  it('labels overage as US dollars, which is what the server passes through', async () => {
    respond([usage({ overage_messages: 40, overage_amount_cents: 250 })], []);
    const user = userEvent.setup();
    mount();
    expect(await screen.findByText('$2.50')).toBeInTheDocument();
    // The head names the currency; the reason it is *not* the normalised figure
    // the rest of the section carries moved to the list's own note, because the
    // full clause set the column's width and pushed the table off the card.
    expect(screen.getByRole('columnheader', { name: /overage \(USD\)/i })).toBeInTheDocument();

    await user.hover(screen.getByRole('button', { name: /About Usage records/i }));
    expect(await screen.findByText(/real US dollars, not the normalised figure/i)).toBeInTheDocument();
  });

  /**
   * The server computes `balance_after` by walking the returned window forward
   * from zero, so on any account with more than 500 entries it is not the
   * balance. Calling the column "Balance" would be a lie on exactly the
   * accounts a support agent is most likely to be looking at.
   */
  it('does not call the ledger’s running figure a balance', async () => {
    respond([], [ledger()]);
    mount();
    expect(await screen.findByRole('columnheader', { name: /running total/i })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /^balance$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/not the account balance/)).toBeInTheDocument();
  });

  it('marks a credit that never expires rather than leaving the cell blank', async () => {
    respond([], [ledger({ expires_at: null })]);
    mount();
    expect(await screen.findByText('Does not expire')).toBeInTheDocument();
  });

  /* --------------------------------------------------------- four states */

  it('is busy while both lists load', async () => {
    get.mockReturnValue(new Promise(() => {}));
    mount();
    const tables = await screen.findAllByRole('table');
    for (const table of tables) expect(table).toHaveAttribute('aria-busy', 'true');
  });

  it('separates an empty platform from an empty client filter', async () => {
    respond([], []);
    const { unmount } = mount();
    expect(await screen.findByText('No usage recorded')).toBeInTheDocument();
    unmount();

    mount('/platform/revenue/usage?client=999');
    expect(await screen.findByText('No usage for that client')).toBeInTheDocument();
  });

  it('explains a failure and offers the way back', async () => {
    get.mockRejectedValue(new Error('Database unreachable'));
    mount();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((alert) => alert.textContent?.includes('Database unreachable'))).toBe(true);
  });

  it('says which of the two the account cannot read', async () => {
    get.mockImplementation((path: string) =>
      path.includes('credits')
        ? Promise.reject(
            Object.assign(new Error('failed'), {
              response: { status: 403, data: { detail: 'No privileges.' } },
            }),
          )
        : Promise.resolve({ data: [usage()] }),
    );
    mount();
    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
    // The half it can read still renders.
    expect(screen.getByText('Northwind Security')).toBeInTheDocument();
  });
});
