/**
 * The welcome screen that charged someone twice.
 *
 * A user picked Enterprise, paid at Razorpay, and the card never changed. The
 * step refetched immediately and once more at 3s - a Razorpay mandate takes
 * longer than that to reach `active`, so both reads returned Free, the notice
 * flashed and vanished, and the screen said nothing had happened. They clicked
 * Select again: second subscription, second ₹5,999.
 *
 * These tests drive the real step through the real checkout hook, mocking only
 * the network, and assert what the user can actually see.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WelcomePlanStep } from './WelcomePlanStep';
import { ACTIVATION_POLL_INTERVAL_MS, ACTIVATION_POLL_TIMEOUT_MS } from '../../workspace/billing/usePlanActivation';

const getCurrentSubscription = vi.fn();
const getSubscriptionPlans = vi.fn();
const getActivePromotion = vi.fn();
const createCheckoutSession = vi.fn();
const changePlan = vi.fn();
const startTrial = vi.fn();
const verifyRazorpaySubscription = vi.fn();
const recordBillingEvent = vi.fn();
const getCheckoutQuote = vi.fn();
const getReferralStatus = vi.fn();
const applyReferralCode = vi.fn();
const saveBillingDetails = vi.fn();
const getBillingDetails = vi.fn();
const openRazorpayCheckout = vi.fn();

vi.mock('../../../services/api', () => ({
  getCurrentSubscription: (...a: unknown[]) => getCurrentSubscription(...a),
  getSubscriptionPlans: (...a: unknown[]) => getSubscriptionPlans(...a),
  getActivePromotion: (...a: unknown[]) => getActivePromotion(...a),
  createCheckoutSession: (...a: unknown[]) => createCheckoutSession(...a),
  changePlan: (...a: unknown[]) => changePlan(...a),
  startTrial: (...a: unknown[]) => startTrial(...a),
  verifyRazorpaySubscription: (...a: unknown[]) => verifyRazorpaySubscription(...a),
  recordBillingEvent: (...a: unknown[]) => recordBillingEvent(...a),
  getCheckoutQuote: (...a: unknown[]) => getCheckoutQuote(...a),
  getReferralStatus: (...a: unknown[]) => getReferralStatus(...a),
  applyReferralCode: (...a: unknown[]) => applyReferralCode(...a),
  saveBillingDetails: (...a: unknown[]) => saveBillingDetails(...a),
  getBillingDetails: (...a: unknown[]) => getBillingDetails(...a),
}));

vi.mock('../../../lib/razorpay', () => ({
  openRazorpayCheckout: (...a: unknown[]) => openRazorpayCheckout(...a),
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

const refreshEntitlements = vi.fn();
vi.mock('../../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({ refresh: refreshEntitlements, planName: 'Free', hasFeature: () => false }),
}));

const PLANS = [
  { id: 1, slug: 'free', name: 'Free', monthly_price_cents: 0, sort_order: 1 },
  {
    id: 4,
    slug: 'enterprise',
    name: 'Enterprise',
    monthly_price_cents: 599900,
    annual_price_cents: 5999000,
    credits_per_month: 100000,
    included_operator_seats: 10,
    sort_order: 4,
  },
];

const ON_FREE = {
  plan: PLANS[0],
  subscription: { status: 'active' },
  trial_used: true,
};

const ON_ENTERPRISE = {
  plan: PLANS[1],
  subscription: { status: 'active' },
  trial_used: true,
};

const stepProps = {
  onContinue: vi.fn(),
  onBack: vi.fn(),
  isFirst: true,
  isLast: false,
};

function renderStep() {
  return render(
    <MemoryRouter>
      <WelcomePlanStep {...stepProps} />
    </MemoryRouter>,
  );
}

/** Total mandate-minting calls, whichever branch the money-path took. */
function chargeAttempts(): number {
  return changePlan.mock.calls.length + createCheckoutSession.mock.calls.length;
}

/** Pick Enterprise and pay - through the confirm modal, as a user does. */
async function payForEnterprise(): Promise<void> {
  const cards = await screen.findAllByRole('button', { name: /^Upgrade to Enterprise$/i });
  fireEvent.click(cards[0]);
  const dialog = await screen.findByRole('dialog');
  const pay = await within(dialog).findByRole('button', { name: /^Upgrade to Enterprise$/i });
  await act(async () => {
    fireEvent.click(pay);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  getSubscriptionPlans.mockResolvedValue(PLANS);
  getActivePromotion.mockResolvedValue({ active: false });
  getCheckoutQuote.mockResolvedValue({ amount_display: '₹5,999' });
  getReferralStatus.mockRejectedValue(new Error('none'));
  // A free-tier signup already holds an ACTIVE Free subscription, so the
  // money-path routes through change-plan; both branches mint a Razorpay
  // mandate, so both are stubbed and the test stays agnostic to the routing.
  const razorpaySession = {
    provider: 'razorpay',
    subscription_id: 'sub_1',
    key_id: 'rzp_test',
  };
  createCheckoutSession.mockResolvedValue(razorpaySession);
  changePlan.mockResolvedValue(razorpaySession);
  openRazorpayCheckout.mockResolvedValue({
    razorpay_payment_id: 'pay_1',
    razorpay_subscription_id: 'sub_1',
    razorpay_signature: 'sig',
  });
  // The mandate is authorised but not yet active locally.
  verifyRazorpaySubscription.mockResolvedValue({
    status: 'verified',
    subscription_known: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
  [
    getCurrentSubscription,
    getSubscriptionPlans,
    getActivePromotion,
    createCheckoutSession,
    changePlan,
    startTrial,
    verifyRazorpaySubscription,
    recordBillingEvent,
    getCheckoutQuote,
    getReferralStatus,
    applyReferralCode,
    openRazorpayCheckout,
    refreshEntitlements,
    stepProps.onContinue,
  ].forEach((fn) => fn.mockReset());
});

describe('WelcomePlanStep. Activation after payment', () => {
  it('holds a persistent “activating” state and updates the card when the plan lands on the 4th poll', async () => {
    // Free for the initial load and the first three polls - well past the 3s
    // the old code waited - then the activation webhook lands.
    getCurrentSubscription
      .mockResolvedValueOnce(ON_FREE) // initial page load
      .mockResolvedValueOnce(ON_FREE) // poll 1
      .mockResolvedValueOnce(ON_FREE) // poll 2
      .mockResolvedValueOnce(ON_FREE) // poll 3
      .mockResolvedValue(ON_ENTERPRISE); // poll 4 onwards

    renderStep();
    await payForEnterprise();

    // The screen says something, immediately and persistently.
    expect(await screen.findByText(/Activating your Enterprise plan/i)).toBeInTheDocument();
    expect(screen.getByText(/please don’t pay again/i)).toBeInTheDocument();

    // It is still there several seconds later - this is exactly the window in
    // which the old UI had already fallen silent.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVATION_POLL_INTERVAL_MS * 2);
    });
    expect(screen.getByText(/Activating your Enterprise plan/i)).toBeInTheDocument();

    // Poll 4 sees the live plan: the notice goes, the card updates.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVATION_POLL_INTERVAL_MS * 2);
    });
    await waitFor(() =>
      expect(screen.queryByText(/Activating your Enterprise plan/i)).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/You’re now on Enterprise\./i)).toBeInTheDocument();
    // The plan card itself now reads as the current plan, which is the thing
    // that never happened in production.
    expect(await screen.findByRole('button', { name: /^Current plan$/i })).toBeInTheDocument();
  });

  it('never offers a second purchase while the first is activating', async () => {
    getCurrentSubscription.mockResolvedValue(ON_FREE);

    renderStep();
    await payForEnterprise();
    await screen.findByText(/Activating your Enterprise plan/i);

    // Every CTA in the picker is retired - there is no button left to click
    // that could mint a second mandate.
    const selectable = screen
      .queryAllByRole('button')
      .filter((b) => /Upgrade to|Select|Continue with Free|Downgrade/i.test(b.textContent ?? ''));
    expect(selectable.length).toBeGreaterThan(0);
    selectable.forEach((button) => expect(button).toBeDisabled());

    // And no second mandate was minted by the flow itself.
    expect(chargeAttempts()).toBe(1);
  });

  it('advances on a settled purchase, which the stale `onClose` closure never did', async () => {
    // The subscription IS known: nothing to wait for, so the step moves on.
    // This is the half of the bug that had nothing to do with timing - the
    // modal's `onClose` prop is captured at render, so reading `planChosen`
    // state inside it always saw `false` and the flow silently dead-ended on
    // the welcome screen even when the payment had fully succeeded.
    getCurrentSubscription.mockResolvedValue(ON_FREE);
    verifyRazorpaySubscription.mockResolvedValue({
      status: 'verified',
      subscription_known: true,
    });

    renderStep();
    await payForEnterprise();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(stepProps.onContinue).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Activating your Enterprise plan/i)).not.toBeInTheDocument();
  });

  it('does not advance past the step while the poll is live', async () => {
    getCurrentSubscription.mockResolvedValue(ON_FREE);

    renderStep();
    await payForEnterprise();
    await screen.findByText(/Activating your Enterprise plan/i);

    // Advancing would unmount the poll AND the notice - back to silence.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(stepProps.onContinue).not.toHaveBeenCalled();
  });

  it('on timeout says the payment arrived, points at support, and offers no retry', async () => {
    // The activation never lands.
    getCurrentSubscription.mockResolvedValue(ON_FREE);

    renderStep();
    await payForEnterprise();
    await screen.findByText(/Activating your Enterprise plan/i);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVATION_POLL_TIMEOUT_MS + ACTIVATION_POLL_INTERVAL_MS);
    });

    const timeoutCopy = await screen.findByText(/activation is taking longer than usual/i);
    expect(timeoutCopy).toBeInTheDocument();
    // It states the money is safe...
    expect(screen.getByText(/have not been charged twice/i)).toBeInTheDocument();
    // ...points at support...
    expect(screen.getByRole('link', { name: /developer@oyechats\.com/i })).toBeInTheDocument();
    // ...and never invites another attempt. "Try again" here IS the second charge.
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
    screen.queryAllByRole('button').forEach((button) => {
      expect(button.textContent ?? '').not.toMatch(/try again|retry|pay again/i);
    });
    // The pay path stays closed after the timeout, not reopened.
    const selectable = screen
      .queryAllByRole('button')
      .filter((b) => /Upgrade to|Select/i.test(b.textContent ?? ''));
    selectable.forEach((button) => expect(button).toBeDisabled());
  });

  it('leaves nothing running when the user navigates away mid-activation', async () => {
    getCurrentSubscription.mockResolvedValue(ON_FREE);

    const { unmount } = renderStep();
    await payForEnterprise();
    await screen.findByText(/Activating your Enterprise plan/i);

    const readsBefore = getCurrentSubscription.mock.calls.length;
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVATION_POLL_INTERVAL_MS * 20);
    });

    // No orphaned interval, and no state update reaching a dead component.
    expect(getCurrentSubscription).toHaveBeenCalledTimes(readsBefore);
  });
});
