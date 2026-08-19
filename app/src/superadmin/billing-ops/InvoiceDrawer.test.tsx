import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InvoiceDrawer } from './InvoiceDrawer';
import type { InvoiceDetail, InvoiceRow } from '../revenue/types';

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

const NUMBER = 'DB/26-27/000114';

function row(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 1284,
    client_id: 42,
    client_name: 'Northwind Security',
    invoice_number: NUMBER,
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

function detail(overrides: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    ...row(),
    razorpay_payment_id: 'pay_QaBcDeFgHiJkLm',
    razorpay_invoice_id: null,
    tax_rate_bps: 1800,
    cgst_minor: 11_433,
    sgst_minor: 11_433,
    igst_minor: 0,
    hsn_sac: '997331',
    place_of_supply: '29',
    seller_snapshot: null,
    buyer_snapshot: { email: 'ops@northwind.test' },
    line_items: null,
    description: 'Standard plan, monthly',
    period_start: '2026-08-01T00:00:00Z',
    period_end: '2026-08-31T00:00:00Z',
    invoice_url: null,
    ...overrides,
  };
}

/**
 * Mount the drawer over one document.
 *
 * The same overrides build both the list row the caller hands in and the full
 * record the server returns, because that is the real relationship: the
 * fallback is what the list already knew, and the detail supersedes it. Making
 * them disagree in a test would prove nothing about the component.
 */
function mount(
  overrides: Partial<InvoiceDetail> = {},
  options: { resolve?: boolean; fallback?: boolean } = {},
) {
  const { resolve = true, fallback = true } = options;
  const full = detail(overrides);
  if (resolve) get.mockResolvedValue({ data: full });
  return render(
    <MemoryRouter>
      <InvoiceDrawer
        invoiceId={full.id}
        fallback={fallback ? full : null}
        onOpenChange={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('InvoiceDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({ data: detail() });
    post.mockResolvedValue({ data: { ok: true } });
  });

  /* ------------------------------------------------------------- refund */

  /**
   * A refund moves real money at Razorpay and cannot be taken back from the
   * console. It is the one action in these two sections that earns a typed
   * confirmation phrase.
   */
  describe('refund', () => {
    it('does not fire on the first click — it opens a confirmation', async () => {
      const user = userEvent.setup();
      mount({ status: 'paid' });

      await user.click(screen.getByRole('button', { name: 'Refund' }));

      expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
      expect(post).not.toHaveBeenCalled();
    });

    it('names the amount, its currency and the customer in the confirmation', async () => {
      const user = userEvent.setup();
      mount({ status: 'paid' });
      await user.click(screen.getByRole('button', { name: 'Refund' }));

      const dialog = await screen.findByRole('alertdialog');
      expect(dialog).toHaveTextContent('₹1,499.00 INR');
      expect(dialog).toHaveTextContent('Northwind Security');
      expect(dialog).toHaveTextContent(NUMBER);
      expect(dialog).toHaveTextContent(/cannot be undone/i);
    });

    it('refuses to confirm until the invoice number is typed out', async () => {
      const user = userEvent.setup();
      mount({ status: 'paid' });
      await user.click(screen.getByRole('button', { name: 'Refund' }));

      const dialog = await screen.findByRole('alertdialog');
      const confirm = within(dialog).getByRole('button', { name: 'Refund' });
      expect(confirm).toBeDisabled();

      await user.type(within(dialog).getByRole('textbox'), 'not the number');
      expect(confirm).toBeDisabled();
      expect(post).not.toHaveBeenCalled();
    });

    it('issues the refund once the phrase matches', async () => {
      const user = userEvent.setup();
      mount({ status: 'paid' });
      await user.click(screen.getByRole('button', { name: 'Refund' }));

      const dialog = await screen.findByRole('alertdialog');
      await user.type(within(dialog).getByRole('textbox'), NUMBER);
      await user.click(within(dialog).getByRole('button', { name: 'Refund' }));

      await waitFor(() =>
        expect(post).toHaveBeenCalledWith('/superadmin/invoices/1284/refund', {}),
      );
    });

    it('says when no money will move at the gateway', async () => {
      const user = userEvent.setup();
      mount({ status: 'paid', razorpay_payment_id: null });

      await waitFor(() => expect(get).toHaveBeenCalled());
      await user.click(screen.getByRole('button', { name: 'Refund' }));

      const dialog = await screen.findByRole('alertdialog');
      expect(dialog).toHaveTextContent(/no Razorpay payment reference/i);
      expect(dialog).toHaveTextContent(/marked refunded locally/i);
    });

    it('is unavailable on an already-refunded document, and says why', async () => {
      mount({ status: 'refunded' });
      expect(screen.getByRole('button', { name: 'Refund' })).toBeDisabled();
      expect(await screen.findByText(/Refund — Already refunded/)).toBeInTheDocument();
    });

    it('keeps the confirmation open and shows the server’s refusal', async () => {
      const user = userEvent.setup();
      post.mockRejectedValue(
        Object.assign(new Error('failed'), {
          response: { status: 502, data: { detail: 'Razorpay refused the refund.' } },
        }),
      );
      mount({ status: 'paid' });

      await user.click(screen.getByRole('button', { name: 'Refund' }));
      const dialog = await screen.findByRole('alertdialog');
      await user.type(within(dialog).getByRole('textbox'), NUMBER);
      await user.click(within(dialog).getByRole('button', { name: 'Refund' }));

      expect(await within(dialog).findByText('Razorpay refused the refund.')).toBeInTheDocument();
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    });
  });

  /* ---------------------------------------------------------- mark paid */

  /**
   * Marking an unpaid invoice paid moves no money, which is exactly why it is
   * dangerous: it changes what the customer's tax document says. It confirms,
   * but does not demand a typed phrase — asking for one on every reconciliation
   * entry trains people to type past it.
   */
  describe('mark paid', () => {
    it('does not fire on the first click', async () => {
      const user = userEvent.setup();
      mount({ status: 'pending' });

      await user.click(screen.getByRole('button', { name: 'Mark paid' }));

      expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
      expect(post).not.toHaveBeenCalled();
    });

    it('states the consequence, the customer, the amount and the current status', async () => {
      const user = userEvent.setup();
      mount({ status: 'pending' });
      await user.click(screen.getByRole('button', { name: 'Mark paid' }));

      const dialog = await screen.findByRole('alertdialog');
      expect(dialog).toHaveTextContent('Northwind Security');
      expect(dialog).toHaveTextContent('₹1,499.00 INR');
      expect(dialog).toHaveTextContent('pending');
      expect(dialog).toHaveTextContent(/No money is collected/i);
      expect(dialog).toHaveTextContent(/changes what the financial record says/i);
    });

    it('does not ask for a typed phrase', async () => {
      const user = userEvent.setup();
      mount({ status: 'pending' });
      await user.click(screen.getByRole('button', { name: 'Mark paid' }));

      const dialog = await screen.findByRole('alertdialog');
      expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Mark paid' })).toBeEnabled();
    });

    it('records the payment once confirmed', async () => {
      const user = userEvent.setup();
      mount({ status: 'pending' });
      await user.click(screen.getByRole('button', { name: 'Mark paid' }));

      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Mark paid' }));

      await waitFor(() =>
        expect(post).toHaveBeenCalledWith('/superadmin/invoices/1284/mark-paid', {}),
      );
    });

    it('is unavailable on a document already recorded as paid', async () => {
      mount({ status: 'paid' });
      expect(screen.getByRole('button', { name: 'Mark paid' })).toBeDisabled();
    });

    it('says a numbered document keeps its frozen supply date', async () => {
      const user = userEvent.setup();
      mount({ status: 'pending', invoice_number: NUMBER });
      await user.click(screen.getByRole('button', { name: 'Mark paid' }));
      expect(await screen.findByRole('alertdialog')).toHaveTextContent(/supply date is frozen/i);
    });
  });

  /* ------------------------------------------------------- PDF recovery */

  describe('PDF recovery', () => {
    it('distinguishes a render that has not happened yet from one that failed', async () => {
      mount({
        pdf_url: null,
        issued_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      });
      expect(await screen.findByText('Render failed')).toBeInTheDocument();
      expect(screen.getByText(/pango/)).toBeInTheDocument();
    });

    it('queues a render and reports the outcome where it can be read', async () => {
      const user = userEvent.setup();
      mount({ pdf_url: null });

      await user.click(screen.getByRole('button', { name: /regenerate pdf/i }));

      await waitFor(() =>
        expect(post).toHaveBeenCalledWith('/superadmin/invoices/1284/regenerate-pdf', {}),
      );
      // An inline alert, not only a toast: the operator still needs this while
      // they decide whether to go and check the worker.
      expect(await screen.findByText(/A fresh render is queued/)).toBeInTheDocument();
    });

    it('shows the server’s refusal instead of claiming success', async () => {
      const user = userEvent.setup();
      post.mockRejectedValue(
        Object.assign(new Error('failed'), {
          response: { status: 403, data: { detail: 'Read-only super-admin: writes are not permitted.' } },
        }),
      );
      mount({ pdf_url: null });

      await user.click(screen.getByRole('button', { name: /regenerate pdf/i }));

      expect(
        await screen.findByText('Read-only super-admin: writes are not permitted.'),
      ).toBeInTheDocument();
    });

    it('will not offer to regenerate a legacy row that has no document', async () => {
      mount({ invoice_number: null, pdf_url: null });
      expect(screen.getByRole('button', { name: /regenerate pdf/i })).toBeDisabled();
      expect(await screen.findByText(/Regenerate PDF — Legacy rows/)).toBeInTheDocument();
    });

    it('will not offer to email a document with no rendered PDF', async () => {
      mount({ pdf_url: null });
      expect(screen.getByRole('button', { name: /resend email/i })).toBeDisabled();
      expect(await screen.findByText(/Resend email — There is no rendered PDF/)).toBeInTheDocument();
    });

    it('resends the email when there is something to send', async () => {
      const user = userEvent.setup();
      mount();
      await user.click(screen.getByRole('button', { name: /resend email/i }));
      await waitFor(() =>
        expect(post).toHaveBeenCalledWith('/superadmin/invoices/1284/resend-email', {}),
      );
    });
  });

  /* ------------------------------------------------------------- states */

  it('waits for the record when the caller has no row to show', async () => {
    // The reconciliation report's brief carries no currency and no PDF url, so
    // the drawer must not render badges derived from fields nobody sent.
    get.mockReturnValue(new Promise(() => {}));
    mount({}, { resolve: false, fallback: false });
    expect(screen.getByText('Reading the document…')).toBeInTheDocument();
    expect(screen.queryByText('Rendered')).not.toBeInTheDocument();
  });

  it('says the account is not permitted rather than showing a blank panel', async () => {
    get.mockRejectedValue(
      Object.assign(new Error('failed'), {
        response: { status: 403, data: { detail: 'No privileges.' } },
      }),
    );
    mount({}, { resolve: false });
    expect(await screen.findByText('You cannot read this document')).toBeInTheDocument();
  });

  it('explains a failed read and offers the way back', async () => {
    get.mockRejectedValue(new Error('Gateway timeout'));
    mount({}, { resolve: false });
    expect(await screen.findByText(/Gateway timeout/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('shows the tax breakdown once the full record arrives', async () => {
    mount();
    expect(await screen.findByText(/Tax at 18%/)).toBeInTheDocument();
    expect(screen.getByText(/CGST ₹114.33/)).toBeInTheDocument();
  });
});
