import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaxNote } from './TaxNote';
import { TAX_NOTE_USD, formatTaxRatePercent, taxNoteInr } from './taxCopy';

/**
 * The tax disclosure is a legal statement about what a customer will be
 * charged, not decorative copy, so each of its four states is pinned here.
 *
 * - A positive rate is a domestic sale: that rate is added on top of the listed
 *   price, and the note must say so before the Razorpay sheet opens. The
 *   percentage comes from the server's basis points, never from a second
 *   hardcoded 18.
 * - A zero rate on the USD rail is an export of services: no Indian GST
 *   applies. A note mentioning GST there states a charge that will never appear
 *   on the invoice, so the string "GST" must not survive anywhere in the output.
 * - A zero rate on the INR rail means nothing is added, so there is nothing to
 *   disclose. Claiming a tax the seller does not charge is as wrong as hiding
 *   one it does.
 * - While /geo is unsettled `useCurrency` is reporting a default, not an
 *   answer. Rendering on it would tell an international buyer that GST is
 *   coming and then withdraw it a beat later, so the note stays absent.
 */

const useCurrency = vi.fn();
vi.mock('../../../context/CurrencyContext', () => ({
  useCurrency: () => useCurrency(),
}));

/** Mount the note on one rail. `loading` mirrors an unsettled GET /geo. */
function renderNote(rail: { isInr: boolean; loading: boolean; taxRateBps?: number }): void {
  useCurrency.mockReturnValue({
    country: rail.isInr ? 'IN' : 'US',
    countrySource: 'stored',
    currency: rail.isInr ? 'inr' : 'usd',
    isInr: rail.isInr,
    taxRateBps: rail.taxRateBps,
    loading: rail.loading,
    format: (minor: number) => String(minor),
    setCountry: () => undefined,
  });
  render(<TaxNote />);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('TaxNote', () => {
  it('tells a domestic buyer that the server-quoted rate is added on top', () => {
    renderNote({ isInr: true, loading: false, taxRateBps: 1800 });

    expect(screen.getByText(taxNoteInr(1800))).toBeInTheDocument();
    // The two claims that make the disclosure, asserted independently of the
    // exported helper so a rewrite that drops either one still fails.
    expect(taxNoteInr(1800)).toMatch(/exclude GST/i);
    expect(taxNoteInr(1800)).toMatch(/18% GST is added/i);
  });

  it('takes the percentage from the rate, so a rate change moves the copy', () => {
    renderNote({ isInr: true, loading: false, taxRateBps: 500 });

    expect(screen.getByText(/5% GST is added at checkout/i)).toBeInTheDocument();
    expect(screen.queryByText(/18%/)).not.toBeInTheDocument();
  });

  it('renders whole percentages without a trailing decimal', () => {
    expect(formatTaxRatePercent(1800)).toBe('18');
    expect(formatTaxRatePercent(500)).toBe('5');
    expect(formatTaxRatePercent(1850)).toBe('18.5');
  });

  it('never mentions GST to a USD buyer, because an export carries none', () => {
    renderNote({ isInr: false, loading: false, taxRateBps: 0 });

    expect(screen.getByText(TAX_NOTE_USD)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/gst/i);
    expect(TAX_NOTE_USD).toMatch(/not included/i);
  });

  it('says nothing to a domestic buyer when no tax is added', () => {
    // An unregistered seller adds nothing at checkout, so the listed price IS
    // the charge. There is no disclosure to make.
    renderNote({ isInr: true, loading: false, taxRateBps: 0 });

    expect(document.body.textContent).toBe('');
  });

  it('treats a response predating tax_rate_bps as no tax, not as 18%', () => {
    renderNote({ isInr: true, loading: false });

    expect(document.body.textContent).toBe('');
  });

  it('renders nothing until the rail is settled', () => {
    renderNote({ isInr: true, loading: true, taxRateBps: 1800 });

    expect(document.body.textContent).toBe('');
    expect(screen.queryByText(taxNoteInr(1800))).not.toBeInTheDocument();
    expect(screen.queryByText(TAX_NOTE_USD)).not.toBeInTheDocument();
  });
});
