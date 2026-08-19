import { describe, expect, it } from 'vitest';
import {
  UNLIMITED,
  USD_NORMALISED_NOTE,
  bpsLabel,
  docMoney,
  docMoneyWithCode,
  limitLabel,
  normaliseCurrency,
  usageFraction,
  usageLabel,
  usageTone,
  usdCents,
  usdCentsRounded,
} from './money';

/**
 * Currency is the thing this section is most able to get catastrophically
 * wrong, so it is the thing tested hardest. Three denominations are in play —
 * INR paise, USD cents, and the server's fixed-rate USD normalisation — and the
 * only defence against confusing them is that every amount goes through one of
 * two functions that each state which they are.
 */
describe('currency labelling', () => {
  it('renders a normalised aggregate as US dollars', () => {
    expect(usdCents(418_200)).toBe('$4,182.00');
    expect(usdCentsRounded(418_249)).toBe('$4,182');
  });

  it('renders an absent aggregate as an em dash, never as zero', () => {
    expect(usdCents(null)).toBe('—');
    expect(usdCents(undefined)).toBe('—');
    expect(usdCents(Number.NaN)).toBe('—');
    expect(usdCentsRounded(null)).toBe('—');
  });

  it('says out loud that a normalised figure is a conversion', () => {
    // The note is what stops "$4,182" being read as money anybody was charged.
    expect(USD_NORMALISED_NOTE).toMatch(/USD/);
    expect(USD_NORMALISED_NOTE).toMatch(/INR/);
    expect(USD_NORMALISED_NOTE).toMatch(/converted/i);
    expect(USD_NORMALISED_NOTE).toMatch(/not a market/i);
  });

  it('renders a document in its own currency, never converted', () => {
    // The same integer means two very different sums depending on the code.
    expect(docMoney(149_900, 'INR')).toBe('₹1,499.00');
    expect(docMoney(149_900, 'USD')).toBe('$1,499.00');
    expect(docMoney(149_900, 'inr')).toBe('₹1,499.00');
  });

  it('appends the ISO code where a column mixes currencies', () => {
    expect(docMoneyWithCode(149_900, 'INR')).toBe('₹1,499.00 INR');
    expect(docMoneyWithCode(149_900, 'usd')).toBe('$1,499.00 USD');
  });

  it('refuses to guess a symbol when the server sent no usable currency', () => {
    // Legacy rows predate the currency column. Printing "$" over a rupee amount
    // is worse than printing no symbol at all.
    expect(docMoney(149_900, null)).toBe('149,900 minor units (currency not recorded)');
    expect(docMoney(149_900, '')).toBe('149,900 minor units (currency not recorded)');
    expect(docMoney(149_900, 'rupees')).toBe('149,900 minor units (currency not recorded)');
    expect(docMoneyWithCode(149_900, null)).toBe('149,900 minor units (currency not recorded)');
  });

  it('does not throw on a currency Intl would reject', () => {
    // `Intl.NumberFormat` raises a RangeError for a malformed code, which would
    // take out the whole table rather than one cell.
    expect(() => docMoney(100, '€€€')).not.toThrow();
    expect(() => docMoney(100, '12')).not.toThrow();
  });

  it('normalises a currency code, or reports that it cannot', () => {
    expect(normaliseCurrency(' inr ')).toBe('INR');
    expect(normaliseCurrency('usd')).toBe('USD');
    expect(normaliseCurrency('rupee')).toBeNull();
    expect(normaliseCurrency(null)).toBeNull();
    expect(normaliseCurrency(undefined)).toBeNull();
  });

  it('renders an absent document amount as an em dash', () => {
    expect(docMoney(null, 'INR')).toBe('—');
    expect(docMoneyWithCode(undefined, 'INR')).toBe('—');
  });

  it('renders a genuine zero as zero, not as absent', () => {
    // "An invoice for nothing" and "no invoice" are different facts.
    expect(docMoney(0, 'INR')).toBe('₹0.00');
    expect(usdCents(0)).toBe('$0.00');
  });
});

describe('plan limits', () => {
  it('never renders the UNLIMITED sentinel as a number', () => {
    expect(UNLIMITED).toBe(-1);
    expect(limitLabel(UNLIMITED)).toBe('Unlimited');
    expect(limitLabel(-5)).toBe('Unlimited');
    expect(usageLabel(412, UNLIMITED)).toBe('412 / Unlimited');
  });

  it('distinguishes a zero allowance from an unknown one', () => {
    expect(limitLabel(0)).toBe('0');
    expect(limitLabel(null)).toBe('—');
    expect(limitLabel(undefined)).toBe('—');
  });

  it('formats a real ceiling with separators', () => {
    expect(limitLabel(10_000)).toBe('10,000');
    expect(usageLabel(412, 500)).toBe('412 / 500');
    expect(usageLabel(null, 500)).toBe('— / 500');
  });

  it('has no fraction for an unlimited or zero allowance', () => {
    // Dividing by either yields Infinity or NaN, and a meter drawn from that
    // paints a full bar for a customer who has used nothing.
    expect(usageFraction(412, UNLIMITED)).toBeNull();
    expect(usageFraction(412, 0)).toBeNull();
    expect(usageFraction(250, 500)).toBe(0.5);
  });

  it('escalates tone at 80% and again at the limit', () => {
    expect(usageTone(100, 500)).toBe('neutral');
    expect(usageTone(400, 500)).toBe('warning');
    expect(usageTone(500, 500)).toBe('danger');
    expect(usageTone(900, 500)).toBe('danger');
    expect(usageTone(900, UNLIMITED)).toBe('neutral');
  });
});

describe('basis points', () => {
  it('renders whole percentages without decimals', () => {
    expect(bpsLabel(1800)).toBe('18%');
    expect(bpsLabel(0)).toBe('0%');
  });

  it('keeps two decimals when the rate is not whole', () => {
    expect(bpsLabel(1875)).toBe('18.75%');
  });

  it('renders an absent rate as an em dash', () => {
    expect(bpsLabel(null)).toBe('—');
    expect(bpsLabel(undefined)).toBe('—');
  });
});
