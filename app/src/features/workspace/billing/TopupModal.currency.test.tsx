import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CurrencyProvider } from '../../../context/CurrencyContext';
import { TopupModal } from './TopupModal';

/**
 * Display currency vs CHARGE currency on the one surface where they can drift.
 *
 * The top-up rail is INR-only and waves an unconfirmed buyer through as
 * domestic, so every case the frontend has to *guess* must resolve to INR.
 * Unlike checkout, nothing downstream 409s a wrong guess here, the customer
 * simply sees one number and is debited another.
 *
 * These tests deliberately mount the REAL CurrencyProvider (the other TopupModal
 * suites stub `useCurrency`, which would stub out the exact code under test) and
 * assert the rendered price against the amount `initiateTopup` is actually
 * called with, so "shown" and "charged" cannot be transcribed apart.
 */

const getBillingGeo = vi.fn();
const getTopupPacks = vi.fn();
const initiateTopup = vi.fn();
const verifyTopupPayment = vi.fn();
const recordBillingEvent = vi.fn();
const getCreditBalance = vi.fn();
vi.mock('../../../services/api', () => ({
  getBillingGeo: (...args: unknown[]) => getBillingGeo(...args),
  getTopupPacks: (...args: unknown[]) => getTopupPacks(...args),
  initiateTopup: (...args: unknown[]) => initiateTopup(...args),
  verifyTopupPayment: (...args: unknown[]) => verifyTopupPayment(...args),
  recordBillingEvent: (...args: unknown[]) => recordBillingEvent(...args),
  getCreditBalance: (...args: unknown[]) => getCreditBalance(...args),
}));

const openRazorpayCheckout = vi.fn();
vi.mock('../../../lib/razorpay', () => ({
  openRazorpayCheckout: (...args: unknown[]) => openRazorpayCheckout(...args),
}));

/** The live smallest pack (credit_service.py `topup_packs`): ₹1,000 charged, $13 shown. */
const PACK = { inr: 1000, usd: 13, credits: 2000, bonus_pct: 0 };
const INR_PRICE = `₹${PACK.inr.toLocaleString('en-IN')}`;
const USD_PRICE = `$${PACK.usd.toLocaleString()}`;

function renderModal(): void {
  getTopupPacks.mockResolvedValue([PACK]);
  getCreditBalance.mockResolvedValue({});
  render(
    <CurrencyProvider>
      <TopupModal open onClose={() => undefined} />
    </CurrencyProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('TopupModal currency vs the amount charged', () => {
  it('prices in rupees when /geo fails, because rupees are what Razorpay debits', async () => {
    // The whole point: a geo outage must not become a pricing lie. The modal
    // used to hold a USD default here and render $13/$50/$125 over an INR debit.
    getBillingGeo.mockRejectedValue(new Error('network down'));
    renderModal();

    expect(await screen.findByText(INR_PRICE)).toBeInTheDocument();
    expect(screen.queryByText(USD_PRICE)).not.toBeInTheDocument();

    // ...and the number on the button is the number sent to the charge route.
    screen.getByRole('button', { name: /Pay securely/ }).click();
    await waitFor(() => expect(initiateTopup).toHaveBeenCalledWith(PACK.inr, { botId: null }));
  });

  it('prices in rupees when /geo resolves an unresolved country', async () => {
    // Server-side twin of the case above (fixed in 23ff3b5): no stored country
    // and no IP signal reports INR, and the client must not re-derive USD from
    // the null country it is handed alongside it.
    getBillingGeo.mockResolvedValue({
      country: null,
      country_source: null,
      display_currency: 'INR',
    });
    renderModal();

    expect(await screen.findByText(INR_PRICE)).toBeInTheDocument();
    expect(screen.queryByText(USD_PRICE)).not.toBeInTheDocument();
  });

  it('still shows dollars for a detected foreign country', async () => {
    // The deliberate divergence: IP geo is display-grade and shows USD. Safe
    // only because it can never become a charge. Checkout omits a 'detected'
    // country and the server 409s billing_country_required. Pinned so the
    // INR default above can't be over-applied into "always INR".
    getBillingGeo.mockResolvedValue({
      country: 'US',
      country_source: 'detected',
      display_currency: 'USD',
    });
    renderModal();

    expect(await screen.findByText(USD_PRICE)).toBeInTheDocument();
    expect(screen.queryByText(INR_PRICE)).not.toBeInTheDocument();
  });

  it('shows no price at all until /geo settles', async () => {
    // A default is not an answer. Rendering one before geo resolves would flip
    // the price under a buyer mid-decision, so the modal waits.
    getBillingGeo.mockReturnValue(new Promise(() => undefined));
    renderModal();

    await waitFor(() => expect(getTopupPacks).toHaveBeenCalled());
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText(INR_PRICE)).not.toBeInTheDocument();
    expect(screen.queryByText(USD_PRICE)).not.toBeInTheDocument();
  });
});
