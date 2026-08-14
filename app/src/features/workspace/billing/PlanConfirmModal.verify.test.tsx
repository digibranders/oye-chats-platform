import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanConfirmModal } from './PlanConfirmModal';
import type { PlanView } from '../billingModel';

// The checkout money path is mocked so these tests drive one branch: the
// backend refusing with `email_verification_required` (403). The modal used to
// print "Please verify your email to continue." and leave the Upgrade button
// live underneath it, so the customer's only move was to click it again and
// collect another 403.
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
    loading: false,
    format: (minor: number) => `₹${minor / 100}`,
    setCountry: () => undefined,
  }),
}));

/** The 403 body both `require_verified_email` variants raise. */
const EMAIL_GATE_ERROR = {
  response: {
    data: {
      detail: {
        error: 'email_verification_required',
        message: 'Please verify your email to continue.',
        verify_url: '/verify-email',
      },
    },
  },
};

const ENTERPRISE: PlanView = {
  id: 4,
  slug: 'enterprise',
  name: 'Enterprise',
  isPaid: true,
  isContactSales: false,
  monthlyPriceMinor: 139900,
  annualPriceMinor: 1399000,
  creditsPerMonth: 100000,
  includedSeats: 10,
  trialDays: 0,
  limits: {},
} as PlanView;

function renderModal() {
  return render(
    <MemoryRouter>
      <PlanConfirmModal
        open
        onClose={() => undefined}
        plan={ENTERPRISE}
        cycle="monthly"
        currentPlanSlug="standard"
        currentSubscriptionStatus="active"
        hasActiveSubscription
        trialUsed
        currentMonthlyPriceMinor={94900}
        onSuccess={() => undefined}
      />
    </MemoryRouter>,
  );
}

describe('PlanConfirmModal - unverified email', () => {
  afterEach(() => {
    [
      changePlan,
      createCheckoutSession,
      startTrial,
      getCheckoutQuote,
      getReferralStatus,
      applyReferralCode,
      recordBillingEvent,
    ].forEach((fn) => fn.mockReset());
  });

  it('offers a way to verify instead of dead-ending', async () => {
    getCheckoutQuote.mockResolvedValue({ amount_display: '₹1,399' });
    getReferralStatus.mockRejectedValue(new Error('none'));
    changePlan.mockRejectedValue(EMAIL_GATE_ERROR);

    renderModal();

    const upgrade = await screen.findByRole('button', { name: /Upgrade to Enterprise/i });
    fireEvent.click(upgrade);

    // The server's message still shows...
    expect(await screen.findByText(/Please verify your email to continue/i)).toBeInTheDocument();
    // ...but now it carries an action pointing at the same place the banner goes.
    const verifyLink = screen.getByRole('link', { name: /Verify your email/i });
    expect(verifyLink).toHaveAttribute('href', '/verify-email');
  });

  it('stops offering the button that just 403d', async () => {
    getCheckoutQuote.mockResolvedValue({ amount_display: '₹1,399' });
    getReferralStatus.mockRejectedValue(new Error('none'));
    changePlan.mockRejectedValue(EMAIL_GATE_ERROR);

    renderModal();

    const upgrade = await screen.findByRole('button', { name: /Upgrade to Enterprise/i });
    fireEvent.click(upgrade);

    await screen.findByRole('link', { name: /Verify your email/i });
    // Re-clicking would produce the identical refusal, so the CTA retires.
    await waitFor(() => expect(upgrade).toBeDisabled());
    expect(changePlan).toHaveBeenCalledTimes(1);
  });

  it('leaves an ordinary failure fully retryable', async () => {
    getCheckoutQuote.mockResolvedValue({ amount_display: '₹1,399' });
    getReferralStatus.mockRejectedValue(new Error('none'));
    changePlan.mockRejectedValue(new Error('Gateway timeout.'));

    renderModal();

    const upgrade = await screen.findByRole('button', { name: /Upgrade to Enterprise/i });
    fireEvent.click(upgrade);

    expect(await screen.findByText(/Gateway timeout/i)).toBeInTheDocument();
    // No verification link, and the CTA stays live - this one is worth retrying.
    expect(screen.queryByRole('link', { name: /Verify your email/i })).not.toBeInTheDocument();
    expect(upgrade).not.toBeDisabled();
  });
});
