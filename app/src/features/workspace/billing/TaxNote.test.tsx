import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TAX_NOTE_INR, TAX_NOTE_USD, TaxNote } from './TaxNote';

/**
 * The tax disclosure is a legal statement about what a customer will be
 * charged, not decorative copy, so each of its three states is pinned here.
 *
 * - INR is an Indian sale: 18% GST is added on top of the listed price, and the
 *   note must say so before the Razorpay sheet opens.
 * - USD is an export of services: no Indian GST applies. A note mentioning GST
 *   on that rail states a charge that will never appear on the invoice, so the
 *   string "GST" must not survive anywhere in the USD output.
 * - While /geo is unsettled `useCurrency` is reporting a default, not an
 *   answer. Rendering on it would tell an international buyer that 18% GST is
 *   coming and then withdraw it a beat later, so the note stays absent.
 */

const useCurrency = vi.fn();
vi.mock('../../../context/CurrencyContext', () => ({
  useCurrency: () => useCurrency(),
}));

/** Mount the note on one rail. `loading` mirrors an unsettled GET /geo. */
function renderNote(rail: { isInr: boolean; loading: boolean }): void {
  useCurrency.mockReturnValue({
    country: rail.isInr ? 'IN' : 'US',
    countrySource: 'stored',
    currency: rail.isInr ? 'inr' : 'usd',
    isInr: rail.isInr,
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
  it('tells an INR buyer that 18% GST is added on top of the listed price', () => {
    renderNote({ isInr: true, loading: false });

    expect(screen.getByText(TAX_NOTE_INR)).toBeInTheDocument();
    // The two claims that make the disclosure, asserted independently of the
    // exported constant so a rewrite that drops either one still fails.
    expect(TAX_NOTE_INR).toMatch(/exclude GST/i);
    expect(TAX_NOTE_INR).toMatch(/18% GST is added/i);
  });

  it('never mentions GST to a USD buyer, because an export carries none', () => {
    renderNote({ isInr: false, loading: false });

    expect(screen.getByText(TAX_NOTE_USD)).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/gst/i);
    expect(TAX_NOTE_USD).toMatch(/not included/i);
  });

  it('renders nothing until the rail is settled', () => {
    renderNote({ isInr: true, loading: true });

    expect(document.body.textContent).toBe('');
    expect(screen.queryByText(TAX_NOTE_INR)).not.toBeInTheDocument();
    expect(screen.queryByText(TAX_NOTE_USD)).not.toBeInTheDocument();
  });
});
