import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CancelSubscriptionModal } from './CancelSubscriptionModal';
import { TopupModal } from './TopupModal';

/**
 * "Top-up credits never expire" is a term of sale. It is only true when
 * `pricing_config.topup_expiry_months` is 0 — a value the client cannot read,
 * because no endpoint exposes it. On any database whose row still says 12,
 * `grant_topup` stamps `expires_at` and the daily sweep deletes the credits, so
 * an unconditional promise in the purchase dialog is a false claim to a paying
 * customer.
 *
 * The one piece of evidence the client DOES have is the customer's own live
 * grants: `GET /credits/balance` returns `soonest_expiry`, non-null exactly when
 * a top-up they hold carries an expiry. `UsageHero` already gates on it. These
 * tests pin that same rule onto the two surfaces that were still promising
 * forever, and pin the third case the hero never had to answer: say NOTHING
 * when there is no evidence either way.
 */

const getTopupPacks = vi.fn();
const initiateTopup = vi.fn();
const verifyTopupPayment = vi.fn();
const recordBillingEvent = vi.fn();
const getCreditBalance = vi.fn();
const cancelSubscription = vi.fn();

vi.mock('../../../services/api', () => ({
  getTopupPacks: (...args: unknown[]) => getTopupPacks(...args),
  initiateTopup: (...args: unknown[]) => initiateTopup(...args),
  verifyTopupPayment: (...args: unknown[]) => verifyTopupPayment(...args),
  recordBillingEvent: (...args: unknown[]) => recordBillingEvent(...args),
  getCreditBalance: (...args: unknown[]) => getCreditBalance(...args),
  cancelSubscription: (...args: unknown[]) => cancelSubscription(...args),
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
    loading: false,
    format: (minor: number) => `₹${minor / 100}`,
    setCountry: () => undefined,
  }),
}));

/** A workspace holding top-ups whose earliest grant is dated (expiry IS on). */
const EXPIRING_BALANCE = {
  monthly_grant: 10000,
  plan: 1000,
  topup: 5000,
  total: 6000,
  soonest_expiry: '2026-11-30T12:00:00.000Z',
};

/** A workspace holding top-ups, none of them dated (lifetime is PROVEN). */
const LIFETIME_BALANCE = {
  monthly_grant: 10000,
  plan: 1000,
  topup: 5000,
  total: 6000,
  soonest_expiry: null,
};

/** A first-time buyer: no grants, therefore no evidence about the policy. */
const NO_TOPUPS_BALANCE = {
  monthly_grant: 10000,
  plan: 1000,
  topup: 0,
  total: 1000,
  soonest_expiry: null,
};

const PACK = { amount: 1599, credits: 2000, currency: 'INR' };

function renderTopup(): void {
  getTopupPacks.mockResolvedValue([PACK]);
  render(<TopupModal open onClose={() => undefined} />);
}

function renderCancel(): void {
  render(
    <CancelSubscriptionModal
      open
      onClose={() => undefined}
      onSuccess={() => undefined}
      planName="Standard"
      periodEnd="2026-09-01T12:00:00.000Z"
    />,
  );
}

describe('TopupModal top-up expiry copy', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('states the real expiry date instead of promising forever', async () => {
    getCreditBalance.mockResolvedValue(EXPIRING_BALANCE);
    renderTopup();

    expect(await screen.findByText(/30 Nov 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/never expire/i)).toBeNull();
  });

  it('promises forever only when the customer holds top-ups and none is dated', async () => {
    getCreditBalance.mockResolvedValue(LIFETIME_BALANCE);
    renderTopup();

    expect(await screen.findByText(/never expire/i)).toBeInTheDocument();
  });

  it('makes no expiry claim to a first-time buyer, who is evidence-free', async () => {
    getCreditBalance.mockResolvedValue(NO_TOPUPS_BALANCE);
    renderTopup();

    await screen.findByText('Pay securely');
    await waitFor(() => {
      expect(getCreditBalance).toHaveBeenCalled();
    });
    expect(screen.queryByText(/expire/i)).toBeNull();
  });

  it('makes no expiry claim when the balance call fails, and still sells packs', async () => {
    getCreditBalance.mockRejectedValue(new Error('network down'));
    renderTopup();

    await screen.findByText('Pay securely');
    await waitFor(() => {
      expect(getCreditBalance).toHaveBeenCalled();
    });
    expect(screen.queryByText(/expire/i)).toBeNull();
  });
});

describe('CancelSubscriptionModal top-up expiry copy', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('states the real expiry date instead of promising forever', async () => {
    getCreditBalance.mockResolvedValue(EXPIRING_BALANCE);
    renderCancel();

    expect(await screen.findByText(/earliest expires 30 Nov 2026/i)).toBeInTheDocument();
    expect(screen.queryByText(/never expire/i)).toBeNull();
  });

  it('promises forever only when the customer holds top-ups and none is dated', async () => {
    getCreditBalance.mockResolvedValue(LIFETIME_BALANCE);
    renderCancel();

    expect(await screen.findByText(/they never expire/i)).toBeInTheDocument();
  });

  it('falls back to the claim cancelling actually guarantees when evidence is absent', async () => {
    getCreditBalance.mockRejectedValue(new Error('network down'));
    renderCancel();

    await waitFor(() => {
      expect(getCreditBalance).toHaveBeenCalled();
    });
    expect(screen.getByText(/cancelling doesn’t remove them/i)).toBeInTheDocument();
    expect(screen.queryByText(/never expire/i)).toBeNull();
  });
});
