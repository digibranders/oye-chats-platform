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
    expect(await screen.findByText('Everything reconciles')).toBeInTheDocument();
    expect(screen.getAllByText('Nothing here').length).toBe(KEYS.length);
  });

  it('counts the documents that need a person', async () => {
    respond(report({ pdfs_pending: [brief()], unnumbered_charges: [brief({ id: 2, invoice_number: null })] }));
    mount();
    expect(await screen.findByText('2 documents need attention')).toBeInTheDocument();
  });

  it('says what each condition means and what to do about it', async () => {
    respond(report({ pdfs_pending: [brief()] }));
    mount();
    expect(await screen.findByText('Rendered nothing for over an hour')).toBeInTheDocument();
    expect(screen.getByText(/pango library/)).toBeInTheDocument();
  });

  it('names the seller profile as the usual cause of un-numbered charges', async () => {
    respond(report({ unnumbered_charges: [brief({ invoice_number: null })] }));
    mount();
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
    // One per anomaly block, plus the gateway table's own busy state.
    expect(await screen.findAllByText('Checking…')).toHaveLength(KEYS.length);
    expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
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
    expect(await screen.findByText('You cannot read reconciliation')).toBeInTheDocument();
    expect(screen.queryByText('Everything reconciles')).not.toBeInTheDocument();
  });
});
