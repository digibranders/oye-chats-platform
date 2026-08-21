import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvoicesTab } from './InvoicesTab';
import { pickOption } from '../../test/select';
import type { InvoiceRow } from './types';

/**
 * The axios instance is mocked rather than the platform client, so these tests
 * exercise the real `platform.get`, the real envelope normalisation and the real
 * 403 handling — the parts most likely to be wrong.
 */
const get = vi.fn();
const post = vi.fn();

vi.mock('../../services/api', () => ({
  httpClient: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  getApiBaseUrl: () => '',
}));

function invoice(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 1284,
    client_id: 42,
    client_name: 'Northwind Security',
    invoice_number: 'DB/26-27/000114',
    invoice_type: 'tax_invoice',
    status: 'paid',
    amount_cents: 149_900,
    currency: 'INR',
    taxable_value_minor: 127_034,
    total_tax_minor: 22_866,
    supply_kind: 'intra',
    is_export: false,
    pdf_url: 'https://cdn.example/inv.pdf',
    credit_note_of_id: null,
    issued_at: '2026-08-19T11:59:00Z',
    created_at: '2026-08-19T11:59:00Z',
    ...overrides,
  };
}

function page(items: InvoiceRow[], total = items.length) {
  return { data: { total, page: 1, limit: 50, items } };
}

function forbidden() {
  return Object.assign(new Error('Request failed'), {
    response: { status: 403, data: { detail: 'You do not have superadmin privileges.' } },
  });
}

/** Reports the URL so a test can assert what a control wrote into it. */
function UrlProbe() {
  const location = useLocation();
  return <span data-testid="url">{`${location.pathname}${location.search}`}</span>;
}

function renderTab(url = '/platform/revenue/invoices') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <UrlProbe />
      <Routes>
        <Route path="/platform/revenue/invoices" element={<InvoicesTab />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('InvoicesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks the server for the first page, at the endpoint’s own page size', async () => {
    get.mockResolvedValue(page([invoice()], 1));
    renderTab();

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(get).toHaveBeenCalledWith(
      '/superadmin/invoices',
      expect.objectContaining({ params: expect.objectContaining({ page: 1, limit: 50 }) }),
    );
  });

  /**
   * Currency is not decoration. An invoice's amount is a legal record in a
   * specific currency and the aggregate USD figures elsewhere in this section
   * are a reporting convention laid over it — so this table renders the stored
   * amount untouched and names its currency in its own column.
   */
  it('renders an amount in the document’s own currency and names that currency', async () => {
    get.mockResolvedValue(page([invoice({ amount_cents: 149_900, currency: 'INR' })], 1));
    renderTab();

    expect(await screen.findByText('₹1,499.00')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /currency/i })).toBeInTheDocument();
    expect(screen.getByText('INR')).toBeInTheDocument();
    // Nothing was converted: no dollar figure appears anywhere in the table.
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument();
  });

  it('keeps INR and USD documents apart in the same list', async () => {
    get.mockResolvedValue(
      page(
        [
          invoice({ id: 1, invoice_number: 'DB/1', amount_cents: 149_900, currency: 'INR' }),
          invoice({ id: 2, invoice_number: 'DB/2', amount_cents: 2_900, currency: 'USD' }),
        ],
        2,
      ),
    );
    renderTab();

    expect(await screen.findByText('₹1,499.00')).toBeInTheDocument();
    expect(screen.getByText('$29.00')).toBeInTheDocument();
  });

  it('says so when the server did not record a currency, rather than guessing one', async () => {
    get.mockResolvedValue(page([invoice({ currency: null, amount_cents: 149_900 })], 1));
    renderTab();

    expect(await screen.findByText(/149,900 minor units \(currency not recorded\)/)).toBeInTheDocument();
    expect(screen.getByText('not recorded')).toBeInTheDocument();
  });

  /**
   * Server pagination, not a client-side pager over one page: the count in the
   * footer is the server's total, and turning the page asks the server for it.
   */
  it('reports the server’s total, not the number of rows on screen', async () => {
    get.mockResolvedValue(page([invoice()], 137));
    renderTab();

    await screen.findByText('DB/26-27/000114');
    const pager = screen.getByRole('navigation', { name: /pages/i });
    // The table's own count, in the pager: "1–50 of 137 documents".
    expect(within(pager).getByText('137')).toBeInTheDocument();
    expect(pager).toHaveTextContent('documents');
  });

  it('turns the page through the URL and refetches from the server', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue(page([invoice()], 137));
    renderTab();

    await screen.findByText('DB/26-27/000114');
    await user.click(screen.getByRole('button', { name: /next page/i }));

    await waitFor(() => expect(screen.getByTestId('url').textContent).toContain('page=2'));
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(
        '/superadmin/invoices',
        expect.objectContaining({ params: expect.objectContaining({ page: 2 }) }),
      ),
    );
  });

  it('starts on the page named in the URL, so a link to page three opens page three', async () => {
    get.mockResolvedValue(page([invoice()], 137));
    renderTab('/platform/revenue/invoices?page=3');

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(
        '/superadmin/invoices',
        expect.objectContaining({ params: expect.objectContaining({ page: 3 }) }),
      ),
    );
  });

  it('puts a filter in the URL and sends it to the server', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue(page([invoice()], 1));
    renderTab();

    await screen.findByText('DB/26-27/000114');
    await pickOption(user, screen.getByLabelText(/document type/i), 'Credit notes');

    await waitFor(() => expect(screen.getByTestId('url').textContent).toContain('type=credit_note'));
    await waitFor(() =>
      expect(get).toHaveBeenLastCalledWith(
        '/superadmin/invoices',
        expect.objectContaining({ params: expect.objectContaining({ invoice_type: 'credit_note' }) }),
      ),
    );
  });

  /* ------------------------------------------------------- the four states */

  it('is busy while the first page loads', async () => {
    get.mockReturnValue(new Promise(() => {}));
    renderTab();
    expect(await screen.findByRole('table')).toHaveAttribute('aria-busy', 'true');
  });

  it('says nothing has been issued when the list is empty and unfiltered', async () => {
    get.mockResolvedValue(page([], 0));
    renderTab();
    expect(await screen.findByText('No documents issued yet')).toBeInTheDocument();
  });

  it('says the filter matched nothing, which is a different fact', async () => {
    get.mockResolvedValue(page([], 0));
    renderTab('/platform/revenue/invoices?q=northwind');
    expect(await screen.findByText('Nothing matched')).toBeInTheDocument();
  });

  it('explains a failure and offers the way back', async () => {
    const user = userEvent.setup();
    get.mockRejectedValueOnce(new Error('Network is down'));
    renderTab();

    expect(await screen.findByRole('alert')).toHaveTextContent('Network is down');
    get.mockResolvedValue(page([invoice()], 1));
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('DB/26-27/000114')).toBeInTheDocument();
  });

  it('says the account is not permitted rather than showing an empty table', async () => {
    get.mockRejectedValue(forbidden());
    renderTab();
    expect(await screen.findByText('You do not have access to this')).toBeInTheDocument();
    // The column heads stay so the reader can see what they are locked out of;
    // no document row is rendered.
    expect(screen.queryAllByRole('cell')).toHaveLength(1);
  });
});
