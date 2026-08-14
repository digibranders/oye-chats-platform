/**
 * A customer who has just paid must never read their own receipt in red.
 *
 * Two separate defects converge here:
 *
 * 1. `/subscriptions/verify` answers `subscription_known: false` when the local
 *    row hasn't materialised yet. The hook used to assert "Payment received"
 *    once and close, which is a claim about a subscription nobody can see.
 * 2. Retrying a mandate that already charged now returns 409
 *    `subscription_activation_conflict`. There was no branch for it, so it fell
 *    through to `setError` - the reassuring message ("You don't need to pay
 *    again") rendered in DANGER styling, under a still-live pay button. That
 *    reads as "payment failed" and buys a third subscription.
 */
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanConfirmModal } from './PlanConfirmModal';
import { usePlanCheckout, type PlanCheckoutContext } from './usePlanCheckout';
import type { PlanView } from '../billingModel';

const changePlan = vi.fn();
const createCheckoutSession = vi.fn();
const startTrial = vi.fn();
const verifyRazorpaySubscription = vi.fn();
const recordBillingEvent = vi.fn();
const getCheckoutQuote = vi.fn();
const getReferralStatus = vi.fn();
const applyReferralCode = vi.fn();
const openRazorpayCheckout = vi.fn();

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
  openRazorpayCheckout: (...args: unknown[]) => openRazorpayCheckout(...args),
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

const ENTERPRISE: PlanView = {
  id: 4,
  slug: 'enterprise',
  name: 'Enterprise',
  isPaid: true,
  isContactSales: false,
  monthlyPriceMinor: 599900,
  annualPriceMinor: 5999000,
  creditsPerMonth: 100000,
  includedSeats: 10,
  trialDays: 0,
  limits: {},
} as PlanView;

/** The 409 body `SubscriptionActivationConflict` produces. */
const CONFLICT_409 = {
  response: {
    data: {
      detail: {
        reason: 'subscription_activation_conflict',
        message:
          'Your Enterprise payment went through — we’re activating your plan now. You don’t need to pay again; this usually takes under a minute.',
        payment_captured: true,
        support: 'developer@oyechats.com',
      },
    },
  },
};

function hookContext(overrides: Partial<PlanCheckoutContext> = {}): PlanCheckoutContext {
  return {
    currentPlanSlug: 'free',
    currentSubscriptionStatus: null,
    hasActiveSubscription: false,
    trialUsed: true,
    onSuccess: () => undefined,
    onDone: () => undefined,
    ...overrides,
  };
}

function renderFreshPurchaseModal(
  props: Partial<React.ComponentProps<typeof PlanConfirmModal>> = {},
) {
  return render(
    <MemoryRouter>
      <PlanConfirmModal
        open
        onClose={() => undefined}
        plan={ENTERPRISE}
        cycle="monthly"
        currentPlanSlug="free"
        currentSubscriptionStatus={null}
        hasActiveSubscription={false}
        trialUsed
        currentMonthlyPriceMinor={0}
        onSuccess={() => undefined}
        {...props}
      />
    </MemoryRouter>,
  );
}

afterEach(() => {
  [
    changePlan,
    createCheckoutSession,
    startTrial,
    verifyRazorpaySubscription,
    getCheckoutQuote,
    getReferralStatus,
    applyReferralCode,
    recordBillingEvent,
    openRazorpayCheckout,
  ].forEach((fn) => fn.mockReset());
});

describe('activation conflict (409) is reassurance, not an error', () => {
  it('renders the server’s message as a notice and never as an error', async () => {
    getCheckoutQuote.mockResolvedValue({ amount_display: '₹5,999' });
    getReferralStatus.mockRejectedValue(new Error('none'));
    createCheckoutSession.mockRejectedValue(CONFLICT_409);

    renderFreshPurchaseModal();
    const cta = await screen.findByRole('button', { name: /Subscribe & pay/i });
    fireEvent.click(cta);

    const message = await screen.findByText(/don’t need to pay again/i);
    // Tone is the whole point of this test: the notice region is info-toned,
    // the error region danger-toned. Same words, opposite meanings - a customer
    // who reads this sentence in red concludes the payment failed.
    const banner = message.closest('div');
    expect(banner?.className).toContain('ds-info');
    expect(banner?.className).not.toContain('ds-danger');
  });

  it('retires the pay button so the click cannot become a third charge', async () => {
    getCheckoutQuote.mockResolvedValue({ amount_display: '₹5,999' });
    getReferralStatus.mockRejectedValue(new Error('none'));
    createCheckoutSession.mockRejectedValue(CONFLICT_409);

    renderFreshPurchaseModal();
    const cta = await screen.findByRole('button', { name: /Subscribe & pay/i });
    fireEvent.click(cta);

    await waitFor(() => expect(cta).toBeDisabled());
    fireEvent.click(cta);
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('starts the host’s activation poll, because the plan really is activating', async () => {
    createCheckoutSession.mockRejectedValue(CONFLICT_409);
    const onActivationPending = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      usePlanCheckout(hookContext({ onActivationPending, onSuccess })),
    );

    await act(async () => {
      await result.current.submit(ENTERPRISE, 'monthly', 'paid');
    });

    expect(onActivationPending).toHaveBeenCalledWith(ENTERPRISE, undefined);
    expect(result.current.activationPending).toBe(true);
    expect(result.current.error).toBe('');
    expect(result.current.notice).toMatch(/don’t need to pay again/i);
    // No green "you're subscribed" claim - the poll owns that story now.
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('leaves every other refusal on the ordinary error path', async () => {
    createCheckoutSession.mockRejectedValue(new Error('Gateway timeout.'));
    const onActivationPending = vi.fn();
    const { result } = renderHook(() => usePlanCheckout(hookContext({ onActivationPending })));

    await act(async () => {
      await result.current.submit(ENTERPRISE, 'monthly', 'paid');
    });

    expect(result.current.error).toBe('Gateway timeout.');
    expect(result.current.activationPending).toBe(false);
    expect(onActivationPending).not.toHaveBeenCalled();
  });
});

describe('an unconfirmed verify enters activation instead of asserting success', () => {
  const CHECKOUT_SESSION = {
    provider: 'razorpay',
    subscription_id: 'sub_live_1',
    key_id: 'rzp_test',
  };
  const RAZORPAY_CALLBACK = {
    razorpay_payment_id: 'pay_1',
    razorpay_subscription_id: 'sub_live_1',
    razorpay_signature: 'sig',
  };

  it('routes `subscription_known: false` to the poll, not to a success message', async () => {
    createCheckoutSession.mockResolvedValue(CHECKOUT_SESSION);
    openRazorpayCheckout.mockResolvedValue(RAZORPAY_CALLBACK);
    // `status: "verified"` describes the SIGNATURE. Reading it as "active" is
    // the mistake that told a charged customer they had a plan.
    verifyRazorpaySubscription.mockResolvedValue({
      status: 'verified',
      subscription_known: false,
      retry_after_seconds: 4,
    });

    const onActivationPending = vi.fn();
    const onSuccess = vi.fn();
    const onDone = vi.fn();
    const { result } = renderHook(() =>
      usePlanCheckout(hookContext({ onActivationPending, onSuccess, onDone })),
    );

    await act(async () => {
      await result.current.submit(ENTERPRISE, 'monthly', 'paid');
    });

    expect(onActivationPending).toHaveBeenCalledWith(ENTERPRISE, { retryAfterSeconds: 4 });
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(result.current.activationPending).toBe(true);
  });

  it('routes the explicit `activation_pending` flag the same way', async () => {
    createCheckoutSession.mockResolvedValue(CHECKOUT_SESSION);
    openRazorpayCheckout.mockResolvedValue(RAZORPAY_CALLBACK);
    verifyRazorpaySubscription.mockResolvedValue({
      status: 'verified',
      subscription_known: true,
      activation_pending: true,
    });

    const onActivationPending = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      usePlanCheckout(hookContext({ onActivationPending, onSuccess })),
    );

    await act(async () => {
      await result.current.submit(ENTERPRISE, 'monthly', 'paid');
    });

    expect(onActivationPending).toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('a verify that throws is still a paid customer, so it polls too', async () => {
    createCheckoutSession.mockResolvedValue(CHECKOUT_SESSION);
    openRazorpayCheckout.mockResolvedValue(RAZORPAY_CALLBACK);
    verifyRazorpaySubscription.mockRejectedValue(new Error('500'));

    const onActivationPending = vi.fn();
    const { result } = renderHook(() => usePlanCheckout(hookContext({ onActivationPending })));

    await act(async () => {
      await result.current.submit(ENTERPRISE, 'monthly', 'paid');
    });

    expect(onActivationPending).toHaveBeenCalledWith(ENTERPRISE, undefined);
    expect(result.current.error).toBe('');
  });

  it('still asserts success when the subscription IS known', async () => {
    createCheckoutSession.mockResolvedValue(CHECKOUT_SESSION);
    openRazorpayCheckout.mockResolvedValue(RAZORPAY_CALLBACK);
    verifyRazorpaySubscription.mockResolvedValue({
      status: 'verified',
      subscription_known: true,
    });

    const onActivationPending = vi.fn();
    const onSuccess = vi.fn();
    const { result } = renderHook(() =>
      usePlanCheckout(hookContext({ onActivationPending, onSuccess })),
    );

    await act(async () => {
      await result.current.submit(ENTERPRISE, 'monthly', 'paid');
    });

    expect(onSuccess).toHaveBeenCalledWith('You’re now subscribed to Enterprise.');
    expect(onActivationPending).not.toHaveBeenCalled();
  });
});
