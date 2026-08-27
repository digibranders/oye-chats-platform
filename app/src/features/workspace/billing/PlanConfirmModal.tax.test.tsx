import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanConfirmModal } from './PlanConfirmModal';
import type { PlanView } from '../billingModel';

/**
 * The headline on the last screen before the Razorpay sheet.
 *
 * Prices are published exclusive of GST, so the quote's `amount_display` is a
 * BASE price and `gross_display` is what the mandate debits. This modal used to
 * print the base as the amount payable, understating an Indian customer's first
 * charge by 18% right where consent is given.
 *
 * Pinned here: the gross leads, the base and the tax stay legible under it, and
 * a response that predates the tax fields degrades to the base rather than
 * blanking the price.
 */

const changePlan = vi.fn();
const createCheckoutSession = vi.fn();
const startTrial = vi.fn();
const verifyRazorpaySubscription = vi.fn();
const recordBillingEvent = vi.fn();
const getCheckoutQuote = vi.fn();
const getReferralStatus = vi.fn();
const applyReferralCode = vi.fn();
vi.mock('../../../services/api', () => ({
  changePlan: (...args: unknown[]) => changePlan(...args),
  createCheckoutSession: (...args: unknown[]) => createCheckoutSession(...args),
  startTrial: (...args: unknown[]) => startTrial(...args),
  verifyRazorpaySubscription: (...args: unknown[]) => verifyRazorpaySubscription(...args),
  recordBillingEvent: (...args: unknown[]) => recordBillingEvent(...args),
  getCheckoutQuote: (...args: unknown[]) => getCheckoutQuote(...args),
  getReferralStatus: (...args: unknown[]) => getReferralStatus(...args),
  applyReferralCode: (...args: unknown[]) => applyReferralCode(...args),
}));

vi.mock('../../../lib/razorpay', () => ({
  openRazorpayCheckout: vi.fn(),
}));

vi.mock('../../../context/CurrencyContext', () => ({
  useCurrency: () => ({
    country: 'IN',
    countrySource: 'stored',
    currency: 'inr',
    isInr: true,
    taxRateBps: 1800,
    loading: false,
    format: (minor: number) => `₹${minor / 100}`,
    setCountry: () => undefined,
  }),
}));

const STANDARD: PlanView = {
  id: 2,
  slug: 'standard',
  name: 'Standard',
  isPaid: true,
  isContactSales: false,
  monthlyPriceMinor: 119900,
  annualPriceMinor: 1199000,
  creditsPerMonth: 10000,
  includedSeats: 2,
  trialDays: 0,
  limits: {},
} as PlanView;

/** The live GST-exclusive Standard quote: ₹1,199 base, ₹215.82 GST, ₹1,414.82 charged. */
const TAXED_QUOTE = {
  currency: 'INR',
  amount_minor: 119900,
  amount_display: '₹1,199',
  tax_minor: 21582,
  tax_rate_bps: 1800,
  gross_minor: 141482,
  gross_display: '₹1,414.82',
  checkout_supported: true,
};

function renderModal() {
  return render(
    <MemoryRouter>
      <PlanConfirmModal
        open
        onClose={() => undefined}
        plan={STANDARD}
        cycle="monthly"
        currentPlanSlug="free"
        currentSubscriptionStatus={null}
        hasActiveSubscription={false}
        trialUsed
        currentMonthlyPriceMinor={0}
        onSuccess={() => undefined}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  [getCheckoutQuote, getReferralStatus, changePlan, createCheckoutSession].forEach((fn) =>
    fn.mockReset(),
  );
});

describe('PlanConfirmModal - the amount payable', () => {
  it('leads with the gross the mandate debits, not the base price', async () => {
    getCheckoutQuote.mockResolvedValue(TAXED_QUOTE);
    getReferralStatus.mockRejectedValue(new Error('none'));

    renderModal();

    expect(await screen.findByText('₹1,414.82')).toBeInTheDocument();
    // The base survives only inside the breakdown, never as the headline.
    expect(screen.getByText('₹1,199 + ₹215.82 GST')).toBeInTheDocument();
  });

  it('drops the exclusive-of-GST note once the breakdown states the tax', async () => {
    getCheckoutQuote.mockResolvedValue(TAXED_QUOTE);
    getReferralStatus.mockRejectedValue(new Error('none'));

    renderModal();

    await screen.findByText('₹1,414.82');
    // "Prices exclude GST" under a figure that includes it contradicts the
    // number beside it.
    expect(screen.queryByText(/Prices exclude GST/i)).not.toBeInTheDocument();
  });

  it('falls back to the base, plus the note, when the quote carries no gross', async () => {
    // A cached or older response. Understating is bad; blanking the price on
    // the pay screen is worse, so the base shows and the note qualifies it.
    getCheckoutQuote.mockResolvedValue({ amount_display: '₹1,199', checkout_supported: true });
    getReferralStatus.mockRejectedValue(new Error('none'));

    renderModal();

    expect(await screen.findByText('₹1,199')).toBeInTheDocument();
    expect(
      screen.getByText('Prices exclude GST. 18% GST is added at checkout.'),
    ).toBeInTheDocument();
  });

  it('shows no breakdown on a rail that adds no tax', async () => {
    getCheckoutQuote.mockResolvedValue({
      currency: 'USD',
      amount_display: '$15',
      tax_minor: 0,
      tax_rate_bps: 0,
      gross_display: '$15',
      checkout_supported: true,
    });
    getReferralStatus.mockRejectedValue(new Error('none'));

    renderModal();

    expect(await screen.findByText('$15')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/\+ .* GST/);
  });
});
