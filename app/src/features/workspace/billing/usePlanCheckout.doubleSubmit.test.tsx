/**
 * One click, one charge.
 *
 * `submitting` disables both CTAs, but that is not a guard: two clicks
 * dispatched before React flushes the state update both reach the handler, and
 * each one calls `createCheckoutSession` - which mints a Razorpay subscription
 * server-side. Client 18 ended up holding two subscriptions for the same month.
 *
 * The guard lives in the hook rather than on a button because two different
 * CTAs in the confirm modal (`paid` and the primary action) share this one
 * money-path, and a per-button fix would not serialise across them.
 *
 * Releasing matters as much as guarding: a customer who hits a recoverable
 * failure - gateway timeout, declined card - must be able to try again.
 */

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
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

/** A first paid purchase: no active subscription, so the money-path is checkout. */
function renderFreshPurchaseModal() {
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
      />
    </MemoryRouter>,
  );
}

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
  ].forEach((fn) => fn.mockReset());
});

describe('plan checkout re-entrancy', () => {
  it('creates one checkout session when the CTA is double-clicked', async () => {
    getCheckoutQuote.mockResolvedValue({ amount_display: '₹5,999' });
    getReferralStatus.mockRejectedValue(new Error('none'));
    // Still in flight when the second click lands - exactly the prod window.
    createCheckoutSession.mockReturnValue(new Promise(() => undefined));

    renderFreshPurchaseModal();
    const cta = await screen.findByRole('button', { name: /Subscribe & pay/i });

    await act(async () => {
      fireEvent.click(cta);
      fireEvent.click(cta);
    });

    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('serialises concurrent submits at the hook, across every caller', async () => {
    createCheckoutSession.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => usePlanCheckout(hookContext()));

    await act(async () => {
      void result.current.submit(ENTERPRISE, 'monthly', 'paid');
      void result.current.submit(ENTERPRISE, 'monthly', 'paid');
    });

    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('releases after a recoverable failure so the customer can retry', async () => {
    createCheckoutSession.mockRejectedValue(new Error('Gateway timeout.'));
    const { result } = renderHook(() => usePlanCheckout(hookContext()));

    await act(async () => {
      await result.current.submit(ENTERPRISE, 'monthly', 'paid');
    });
    expect(result.current.error).toBe('Gateway timeout.');

    createCheckoutSession.mockResolvedValue({ status: 'switched' });
    await act(async () => {
      await result.current.submit(ENTERPRISE, 'monthly', 'paid');
    });

    expect(createCheckoutSession).toHaveBeenCalledTimes(2);
  });

  it('releases after a refusal that returns early inside the catch', async () => {
    // `billing_details_required` hands off to a form and returns from the catch
    // block - a path that never touches the ordinary error state.
    const onBillingDetailsRequired = vi.fn();
    createCheckoutSession.mockRejectedValue({
      response: { data: { detail: { code: 'billing_details_required', missing: ['gstin'] } } },
    });
    const { result } = renderHook(() =>
      usePlanCheckout(hookContext({ onBillingDetailsRequired })),
    );

    await act(async () => {
      await result.current.submit(ENTERPRISE, 'monthly', 'paid');
    });
    expect(onBillingDetailsRequired).toHaveBeenCalledWith(['gstin']);

    // The customer fills the form and comes straight back.
    createCheckoutSession.mockResolvedValue({ status: 'switched' });
    await act(async () => {
      await result.current.submit(ENTERPRISE, 'monthly', 'paid');
    });

    expect(createCheckoutSession).toHaveBeenCalledTimes(2);
  });

  it('releases after the trial path and after a downgrade-to-Free', async () => {
    startTrial.mockRejectedValue(new Error('Trial unavailable.'));
    const { result } = renderHook(() =>
      usePlanCheckout(hookContext({ currentPlanSlug: 'free', trialUsed: false })),
    );

    await act(async () => {
      await result.current.submit(ENTERPRISE, 'monthly', 'trial');
    });
    expect(startTrial).toHaveBeenCalledTimes(1);

    createCheckoutSession.mockResolvedValue({ status: 'switched' });
    await act(async () => {
      await result.current.submit(ENTERPRISE, 'monthly', 'paid');
    });
    expect(createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('releases after a Free downgrade so a later plan change still submits', async () => {
    const FREE = { ...ENTERPRISE, id: 1, slug: 'free', name: 'Free', isPaid: false } as PlanView;
    changePlan.mockRejectedValue(new Error('Could not downgrade.'));
    const { result } = renderHook(() =>
      usePlanCheckout(hookContext({ hasActiveSubscription: true, currentPlanSlug: 'standard' })),
    );

    await act(async () => {
      await result.current.submit(FREE, 'monthly', 'paid');
    });
    expect(changePlan).toHaveBeenCalledTimes(1);

    changePlan.mockResolvedValue({ status: 'switched' });
    await act(async () => {
      await result.current.submit(ENTERPRISE, 'monthly', 'paid');
    });
    expect(changePlan).toHaveBeenCalledTimes(2);
  });
});
