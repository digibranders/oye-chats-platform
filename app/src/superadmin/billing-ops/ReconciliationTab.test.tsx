import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReconciliationTab } from './ReconciliationTab';
import type { AnomalyBrief, AnomalyKey, ReconciliationResponse } from './types';

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

const KEYS: AnomalyKey[] = [
  'refunds_without_credit_note',
  'pdfs_pending',
  'emails_pending',
  'broken_totals',
  'unnumbered_charges',
  'exports_without_fx',
];

function brief(overrides: Partial<AnomalyBrief> = {}): AnomalyBrief {
  return {
    id: 1284,
    invoice_number: 'DB/26-27/000114',
    invoice_type: 'tax_invoice',
    status: 'paid',
    client_id: 42,
    amount_cents: 149_900,
    issued_at: '2026-08-19T09:00:00Z',
    ...overrides,
  };
}

function report(overrides: Partial<Record<AnomalyKey, AnomalyBrief[]>> = {}): ReconciliationResponse {
  const lists = Object.fromEntries(KEYS.map((key) => [key, overrides[key] ?? []])) as Record<
    AnomalyKey,
    AnomalyBrief[]
  >;
  const counts = Object.fromEntries(KEYS.map((key) => [key, lists[key].length])) as Record<
    AnomalyKey,
    number
  >;
  return { counts, ...lists };
}

/** The two reports load in parallel, so the mock answers by path. */
function respond(anomalies: ReconciliationResponse, runs: unknown[] = []) {
  get.mockImplementation((path: string) =>
    Promise.resolve({
      data: path.includes('reconciliation/gateway') ? { runs } : anomalies,
    }),
  );
}

function mount() {
  return render(
    <MemoryRouter>
      <ReconciliationTab />
    </MemoryRouter>,
  );
}

describe('ReconciliationTab', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says everything reconciles when every list is empty', async () => {
    respond(report());
    mount();
    // Twice: the banner and the table's own empty state. One table, so one
    // empty state — the six lists used to render six "Nothing here" blocks down
    // four screenfuls.
    expect(await screen.findAllByText('Everything reconciles')).toHaveLength(2);
    expect(screen.queryByRole('columnheader', { name: 'Condition' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /DB\/26-27/ })).not.toBeInTheDocument();
  });

  it('counts the documents that need a person', async () => {
    respond(report({ pdfs_pending: [brief()], unnumbered_charges: [brief({ id: 2, invoice_number: null })] }));
    mount();
    expect(await screen.findByText('2 documents need attention')).toBeInTheDocument();
  });

  it('names every condition on the filter, with how many are in it', async () => {
    respond(report({ pdfs_pending: [brief(), brief({ id: 2, invoice_number: 'DB/26-27/000115' })] }));
    const user = userEvent.setup();
    mount();
    await screen.findByRole('button', { name: /DB\/26-27\/000114/ });

    // The condition is a column now, so its name has to be reachable as a
    // facet rather than as one of six headings.
    await user.click(screen.getByLabelText(/filter by condition/i));
    expect(
      await screen.findByRole('option', { name: /Rendered nothing for over an hour · 2/ }),
    ).toBeInTheDocument();
  });

  it('shows the remedy for the condition being worked, and only that one', async () => {
    respond(
      report({
        pdfs_pending: [brief()],
        unnumbered_charges: [brief({ id: 2, invoice_number: 'DB/26-27/000115' })],
      }),
    );
    const user = userEvent.setup();
    mount();
    await screen.findByRole('button', { name: /DB\/26-27\/000114/ });

    // Unfiltered, no remedy is on screen: six remedies for six conditions is
    // five answers to questions the reader is not currently asking.
    expect(screen.queryByText(/pango library/)).not.toBeInTheDocument();

    await user.click(screen.getByLabelText(/filter by condition/i));
    await user.click(await screen.findByRole('option', { name: /Rendered nothing for over an hour/ }));

    expect(await screen.findByText(/pango library/)).toBeInTheDocument();
    expect(screen.queryByText(/seller profile has never been saved/)).not.toBeInTheDocument();
  });

  it('names the seller profile as the usual cause of un-numbered charges', async () => {
    respond(report({ unnumbered_charges: [brief({ invoice_number: null })] }));
    const user = userEvent.setup();
    mount();
    await screen.findByRole('button', { name: /#1284/ });

    await user.click(screen.getByLabelText(/filter by condition/i));
    await user.click(await screen.findByRole('option', { name: /Charged, but holding no document/ }));

    expect(await screen.findByText(/seller profile has never been saved/)).toBeInTheDocument();
  });

  /**
   * The endpoint's brief carries `amount_cents` with **no currency field**, so
   * there is no honest way to render it as money. Printing a rupee figure with
   * a dollar sign on a reconciliation screen is worse than printing nothing.
   */
  it('renders no money at all, because the endpoint sends no currency', async () => {
    respond(report({ broken_totals: [brief({ amount_cents: 149_900 })] }));
    mount();
    await screen.findByText('DB/26-27/000114');
    expect(screen.queryByText('₹1,499.00')).not.toBeInTheDocument();
    expect(screen.queryByText('$1,499.00')).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /amount/i })).not.toBeInTheDocument();
  });

  it('opens the invoice drawer straight from an anomaly row', async () => {
    const user = userEvent.setup();
    respond(report({ pdfs_pending: [brief()] }));
    mount();

    await user.click(await screen.findByRole('button', { name: /DB\/26-27\/000114/ }));

    await waitFor(() => expect(get).toHaveBeenCalledWith('/superadmin/invoices/1284', expect.anything()));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  /* ------------------------------------------------- gateway reconciliation */

  it('distinguishes a clean run from a run that found disagreements', async () => {
    respond(report(), [
      { id: 2, ran_at: '2026-08-19T02:00:00Z', delta_count: 0, report: {} },
      { id: 1, ran_at: '2026-08-18T02:00:00Z', delta_count: 3, report: { deltas: [1, 2, 3] } },
    ]);
    mount();
    expect(await screen.findByText('Razorpay and the platform agreed.')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('does not present “never ran” as a clean result', async () => {
    respond(report(), []);
    mount();
    expect(await screen.findByText('No reconciliation run recorded')).toBeInTheDocument();
    expect(screen.getByText(/not the same as a clean result/)).toBeInTheDocument();
  });

  /* --------------------------------------------------------- four states */

  it('is busy while both reports load', async () => {
    get.mockReturnValue(new Promise(() => {}));
    mount();
    // Both report busy rather than rendering an empty-state title with an
    // ellipsis on it, which never animates and reads as a broken empty list.
    // The anomaly table and the gateway table. It used to be one table per
    // anomaly block plus the gateway table — seven headers for two schemas.
    const tables = await screen.findAllByRole('table');
    expect(tables).toHaveLength(2);
    for (const table of tables) expect(table).toHaveAttribute('aria-busy', 'true');
  });

  it('explains a failure and offers the way back', async () => {
    get.mockRejectedValue(new Error('Database unreachable'));
    mount();
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((alert) => alert.textContent?.includes('Database unreachable'))).toBe(true);
  });

  it('says the account is not permitted rather than showing six clean lists', async () => {
    get.mockImplementation((path: string) =>
      path.includes('reconciliation/gateway')
        ? Promise.resolve({ data: { runs: [] } })
        : Promise.reject(
            Object.assign(new Error('failed'), {
              response: { status: 403, data: { detail: 'No privileges.' } },
            }),
          ),
    );
    mount();
    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
    expect(screen.queryByText('Everything reconciles')).not.toBeInTheDocument();
  });
});
