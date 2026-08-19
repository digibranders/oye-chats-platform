import { describe, expect, it } from 'vitest';
import type { InvoiceRow } from '../revenue/types';
import {
  PDF_STUCK_AFTER_MS,
  canMarkPaid,
  canRefund,
  canRegeneratePdf,
  canResendEmail,
  invoiceName,
  invoiceStatusLabel,
  invoiceStatusTone,
  invoiceTypeLabel,
  pdfStatus,
} from './invoice';

const NOW = new Date('2026-08-19T12:00:00Z');

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

describe('invoice status vocabulary', () => {
  it('maps the statuses that matter and passes anything else through', () => {
    expect(invoiceStatusTone('paid')).toBe('success');
    expect(invoiceStatusTone('refunded')).toBe('danger');
    expect(invoiceStatusTone('partially_refunded')).toBe('warning');
    expect(invoiceStatusTone('something_new')).toBe('neutral');
    expect(invoiceStatusTone(null)).toBe('neutral');
  });

  it('always produces a readable word', () => {
    expect(invoiceStatusLabel('partially_refunded')).toBe('Partially refunded');
    expect(invoiceStatusLabel('paid')).toBe('Paid');
    expect(invoiceStatusLabel(null)).toBe('Unknown');
  });

  it('names an un-typed row as the legacy payment row it is', () => {
    expect(invoiceTypeLabel('tax_invoice')).toBe('Tax invoice');
    expect(invoiceTypeLabel('credit_note')).toBe('Credit note');
    expect(invoiceTypeLabel(null)).toBe('Legacy payment row');
  });

  it('names an un-numbered document by its row id', () => {
    expect(invoiceName(invoice())).toBe('DB/26-27/000114');
    expect(invoiceName(invoice({ invoice_number: null }))).toBe('payment row #1284');
  });
});

/**
 * The distinction the root CLAUDE.md warns about: a worker started without
 * pango logs "PDF renderer unavailable" and the render silently never happens,
 * so `pdf_url` stays null forever. A console that shows the same thing for that
 * and for a document issued forty seconds ago makes the failure invisible.
 */
describe('PDF state', () => {
  it('reports a rendered document as ready', () => {
    expect(pdfStatus(invoice(), NOW).state).toBe('ready');
    expect(pdfStatus(invoice(), NOW).tone).toBe('success');
  });

  it('reports a recently issued document as still rendering, not as failed', () => {
    const state = pdfStatus(invoice({ pdf_url: null }), NOW);
    expect(state.state).toBe('rendering');
    expect(state.tone).toBe('warning');
    expect(state.detail).toMatch(/five minutes/);
  });

  it('reports a document past the sweep window as a render failure', () => {
    const issued = new Date(NOW.getTime() - PDF_STUCK_AFTER_MS - 60_000).toISOString();
    const state = pdfStatus(invoice({ pdf_url: null, issued_at: issued }), NOW);
    expect(state.state).toBe('stuck');
    expect(state.tone).toBe('danger');
    expect(state.detail).toMatch(/pango/);
  });

  it('uses the same one-hour cutoff the server reconciliation report uses', () => {
    expect(PDF_STUCK_AFTER_MS).toBe(60 * 60 * 1000);
    const exactly = new Date(NOW.getTime() - PDF_STUCK_AFTER_MS).toISOString();
    expect(pdfStatus(invoice({ pdf_url: null, issued_at: exactly }), NOW).state).toBe('rendering');
  });

  it('says a legacy row has no document rather than calling it a failure', () => {
    const state = pdfStatus(invoice({ invoice_number: null, pdf_url: null }), NOW);
    expect(state.state).toBe('not-a-document');
    expect(state.tone).toBe('neutral');
  });
});

describe('what an operator is allowed to do', () => {
  it('refuses a second refund, and says why', () => {
    expect(canRefund(invoice()).allowed).toBe(true);
    const blocked = canRefund(invoice({ status: 'refunded' }));
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/already refunded/i);
  });

  it('refuses to refund a credit note, which is itself a reversal', () => {
    expect(canRefund(invoice({ invoice_type: 'credit_note' })).allowed).toBe(false);
  });

  it('refuses to mark a refunded document paid', () => {
    expect(canMarkPaid(invoice({ status: 'pending' })).allowed).toBe(true);
    expect(canMarkPaid(invoice({ status: 'paid' })).allowed).toBe(false);
    const blocked = canMarkPaid(invoice({ status: 'refunded' }));
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/contradict/i);
  });

  it('refuses to regenerate a document that does not exist', () => {
    expect(canRegeneratePdf(invoice()).allowed).toBe(true);
    const blocked = canRegeneratePdf(invoice({ invoice_number: null }));
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/409/);
  });

  it('refuses to email a document with no rendered PDF', () => {
    expect(canResendEmail(invoice()).allowed).toBe(true);
    expect(canResendEmail(invoice({ pdf_url: null })).allowed).toBe(false);
    expect(canResendEmail(invoice({ invoice_number: null })).allowed).toBe(false);
  });

  it('gives a reason for every refusal', () => {
    // A disabled control with no explanation is a dead end.
    const blocked = [
      canRefund(invoice({ status: 'refunded' })),
      canMarkPaid(invoice({ status: 'paid' })),
      canRegeneratePdf(invoice({ invoice_number: null })),
      canResendEmail(invoice({ pdf_url: null })),
    ];
    for (const availability of blocked) {
      expect(availability.allowed).toBe(false);
      expect(availability.reason.length).toBeGreaterThan(10);
    }
  });
});
