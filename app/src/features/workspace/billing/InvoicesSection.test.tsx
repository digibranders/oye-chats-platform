import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { buildInvoice, type InvoiceView } from '../billingModel';
import { InvoicesSection } from './InvoicesSection';

/**
 * An invoice table is a record a customer hands to an accountant. Two things
 * make it usable and both were missing: the GST itemisation India requires,
 * and an honest answer about whether the PDF exists.
 */

const NOW = Date.parse('2026-08-19T12:00:00Z');

function invoice(overrides: Record<string, unknown>): InvoiceView {
  return buildInvoice(
    {
      id: 1,
      amount_cents: 112000,
      currency: 'inr',
      status: 'paid',
      invoice_number: 'DB/26-27/000012',
      invoice_type: 'tax_invoice',
      issued_at: '2026-08-01T00:00:00Z',
      period_start: '2026-08-01T00:00:00Z',
      period_end: '2026-08-31T00:00:00Z',
      taxable_value_minor: 94900,
      total_tax_minor: 17082,
      cgst_minor: 8541,
      sgst_minor: 8541,
      igst_minor: 0,
      tax_rate_bps: 1800,
      hsn_sac: '998314',
      supply_kind: 'intra_state',
      pdf_url: 'https://cdn.example/inv.pdf',
      ...overrides,
    },
    0,
    NOW,
  );
}

function renderSection(rows: InvoiceView[], props: Partial<React.ComponentProps<typeof InvoicesSection>> = {}) {
  return render(
    <InvoicesSection
      invoices={rows}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      {...props}
    />,
  );
}

describe('the table', () => {
  it('states the period each document covers', () => {
    renderSection([invoice({})]);
    expect(screen.getByText(/1 Aug 2026 – 31 Aug 2026/)).toBeInTheDocument();
  });

  it('offers a download only when a rendered PDF exists', () => {
    renderSection([invoice({})]);
    expect(screen.getAllByRole('link', { name: /pdf/i })[0]).toHaveAttribute(
      'href',
      'https://cdn.example/inv.pdf',
    );
  });

  it('says a freshly-issued document is still being prepared', () => {
    renderSection([invoice({ pdf_url: null, issued_at: '2026-08-19T11:58:00Z' })]);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Preparing')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /pdf/i })).toBeNull();
  });

  it('admits an old document has no PDF rather than showing a dead button', () => {
    // The render job can silently never run - the root CLAUDE.md documents the
    // whole class of bug. A button that does nothing is the worst answer.
    renderSection([invoice({ pdf_url: null, issued_at: '2026-07-01T00:00:00Z', invoice_url: null })]);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /pdf/i })).toBeNull();
  });

  it('falls back to the provider receipt when there is one', () => {
    renderSection([
      invoice({ pdf_url: null, issued_at: '2026-07-01T00:00:00Z', invoice_url: 'https://rzp/receipt' }),
    ]);
    expect(screen.getByRole('link', { name: /receipt/i })).toHaveAttribute(
      'href',
      'https://rzp/receipt',
    );
  });

  it('distinguishes an empty history from a failed one', () => {
    const { unmount } = renderSection([]);
    expect(screen.getByText('No invoices yet')).toBeInTheDocument();
    unmount();

    renderSection([], { error: 'The billing history did not load.' });
    expect(screen.getByText('The billing history did not load.')).toBeInTheDocument();
    expect(screen.queryByText('No invoices yet')).toBeNull();
  });
});

describe('the GST breakdown', () => {
  it('itemises an intra-state supply as CGST and SGST at half the rate each', async () => {
    renderSection([invoice({})]);
    await userEvent.click(screen.getByRole('button', { name: /DB\/26-27\/000012/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Taxable value')).toBeInTheDocument();
    expect(within(dialog).getByText('CGST at 9%')).toBeInTheDocument();
    expect(within(dialog).getByText('SGST at 9%')).toBeInTheDocument();
    expect(within(dialog).queryByText(/IGST/)).toBeNull();
    expect(dialog.textContent).toContain('998314');
    expect(dialog.textContent).toContain('₹1,120');
  });

  it('itemises an inter-state supply as a single IGST line at the full rate', async () => {
    renderSection([invoice({ cgst_minor: 0, sgst_minor: 0, igst_minor: 17082, supply_kind: 'inter_state' })]);
    await userEvent.click(screen.getByRole('button', { name: /DB\/26-27\/000012/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('IGST at 18%')).toBeInTheDocument();
    expect(within(dialog).queryByText(/CGST/)).toBeNull();
  });

  it('says an export is zero-rated rather than showing a missing tax line', async () => {
    renderSection([
      invoice({ cgst_minor: 0, sgst_minor: 0, igst_minor: 0, is_export: true, supply_kind: 'export' }),
    ]);
    await userEvent.click(screen.getByRole('button', { name: /DB\/26-27\/000012/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/zero-rated/i)).toBeInTheDocument();
  });

  it('explains a legacy row instead of printing a fabricated zero-rated breakdown', async () => {
    const legacy = buildInvoice(
      { id: 9, amount_cents: 94900, status: 'paid', created_at: '2025-01-01T00:00:00Z' },
      0,
      NOW,
    );
    renderSection([legacy]);
    await userEvent.click(screen.getByRole('button', { name: /payment/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/predates itemised tax invoices/i)).toBeInTheDocument();
    expect(within(dialog).queryByText(/CGST/)).toBeNull();
  });
});
