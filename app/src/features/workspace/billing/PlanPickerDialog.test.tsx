import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGeo, buildPlan, type PlanView } from '../billingModel';
import { PlanPickerDialog } from './PlanPickerDialog';

/**
 * The plan picker is the one surface in the console where a mistake charges
 * money. Three guarantees are pinned here because each has already failed in
 * production or in the surface this replaces:
 *
 * 1. It cannot be dismissed while a charge is in flight. A customer who closes
 *    a dialog mid-payment cannot tell whether they were charged.
 * 2. A second click cannot open a second checkout. Two clicks dispatched before
 *    React flushes both reach the handler, and each mints a Razorpay
 *    subscription server-side.
 * 3. Once money has moved, the pay button never comes back - the silence after
 *    a charge is exactly what produced a duplicate subscription.
 */

const api = vi.hoisted(() => ({
  changePlan: vi.fn(),
  createCheckoutSession: vi.fn(),
  startTrial: vi.fn(),
  verifyRazorpaySubscription: vi.fn(),
  recordBillingEvent: vi.fn(),
  getCurrentSubscription: vi.fn(),
}));
const razorpay = vi.hoisted(() => ({ openRazorpayCheckout: vi.fn() }));

vi.mock('../../../services/api', () => api);
vi.mock('../../../lib/razorpay', () => razorpay);
vi.mock('../../../context/CurrencyContext', () => ({
  useCurrency: () => ({ country: 'IN', countrySource: 'stored', currency: 'inr', isInr: true, loading: false }),
}));

const FREE = buildPlan({
  id: 1,
  slug: 'free',
  name: 'Free',
  monthly_price_cents: 0,
  credits_per_month: 200,
  included_operator_seats: 0,
  sort_order: 1,
  limits: { bots: 1 },
}) as PlanView;

const STANDARD = buildPlan({
  id: 3,
  slug: 'standard',
  name: 'Standard',
  monthly_price_cents: 94900,
  annual_price_cents: 949000,
  monthly_price_usd_cents: 1900,
  credits_per_month: 3000,
  included_operator_seats: 2,
  trial_days: 7,
  sort_order: 3,
  limits: { bots: 1 },
}) as PlanView;

const INDIA = buildGeo({
  country: 'IN',
  country_source: 'stored',
  display_currency: 'INR',
  display_rate: 94.67,
  checkout_available: true,
});
const ABROAD = buildGeo({
  country: 'US',
  country_source: 'stored',
  display_currency: 'USD',
  display_rate: 94.67,
  checkout_available: true,
});

function renderDialog(overrides: Partial<React.ComponentProps<typeof PlanPickerDialog>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const onOpenChange = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <PlanPickerDialog
          open
          onOpenChange={onOpenChange}
          plans={[FREE, STANDARD]}
          currentPlan={FREE}
          currentStatus="active"
          hasActiveSubscription={false}
          trialUsed
          promotion={null}
          geo={INDIA}
          onChanged={vi.fn()}
          onBillingDetailsRequired={vi.fn()}
          {...overrides}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onOpenChange };
}

/** A checkout that hangs until the test releases it. */
function pendingCheckout() {
  let release: (value: unknown) => void = () => {};
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release({ razorpay_payment_id: 'pay_1', razorpay_signature: 'sig' }) };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  razorpay.openRazorpayCheckout.mockReset();
  api.getCurrentSubscription.mockResolvedValue({ plan: null, subscription: null });
});

describe('pricing', () => {
  it('shows the rupee price to a domestic buyer with nothing to disclose', () => {
    renderDialog();
    expect(screen.getByText('₹949')).toBeInTheDocument();
    expect(screen.queryByText(/charged as/i)).toBeNull();
  });

  it('shows a foreign buyer the dollar price AND the rupee amount that will be debited', () => {
    renderDialog({ geo: ABROAD });
    expect(screen.getByText('$19')).toBeInTheDocument();
    // The compliance point: a converted price must never stand in for the charge.
    expect(screen.getByText(/Charged as ₹949/)).toBeInTheDocument();
  });

  it('quotes the yearly price against the yearly cycle, never the monthly one', async () => {
    renderDialog();
    await userEvent.click(screen.getByRole('radio', { name: /yearly/i }));
    expect(screen.getByText('₹9,490')).toBeInTheDocument();
    expect(screen.queryByText('₹949')).toBeNull();
  });

  it('never prints the unlimited sentinel as a seat count', () => {
    const agency = buildPlan({
      id: 5,
      slug: 'enterprise',
      name: 'Enterprise',
      monthly_price_cents: 599900,
      included_operator_seats: -1,
      limits: { bots: -1 },
    }) as PlanView;
    renderDialog({ plans: [agency] });
    expect(screen.getByText('Unlimited operator seats')).toBeInTheDocument();
    expect(screen.getByText('Unlimited chatbots')).toBeInTheDocument();
    expect(screen.queryByText('-1')).toBeNull();
  });
});

describe('a charge in flight', () => {
  it('cannot be dismissed with Escape', async () => {
    const checkout = pendingCheckout();
    api.createCheckoutSession.mockResolvedValue({
      provider: 'razorpay',
      subscription_id: 'sub_1',
      key_id: 'rzp_test',
    });
    razorpay.openRazorpayCheckout.mockReturnValue(checkout.promise);

    const { onOpenChange } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: /subscribe/i }));
    await waitFor(() => expect(razorpay.openRazorpayCheckout).toHaveBeenCalled());

    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    checkout.release();
  });

  it('has no close button to press while the payment is open', async () => {
    const checkout = pendingCheckout();
    api.createCheckoutSession.mockResolvedValue({
      provider: 'razorpay',
      subscription_id: 'sub_1',
      key_id: 'rzp_test',
    });
    razorpay.openRazorpayCheckout.mockReturnValue(checkout.promise);

    renderDialog();
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /subscribe/i }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close' })).toBeNull());

    checkout.release();
  });

  it('does not mint a second subscription when the button is clicked twice', async () => {
    const checkout = pendingCheckout();
    api.createCheckoutSession.mockResolvedValue({
      provider: 'razorpay',
      subscription_id: 'sub_1',
      key_id: 'rzp_test',
    });
    razorpay.openRazorpayCheckout.mockReturnValue(checkout.promise);

    renderDialog();
    const pay = screen.getByRole('button', { name: /subscribe/i });
    await userEvent.click(pay);
    await userEvent.click(pay);
    await userEvent.click(pay);

    await waitFor(() => expect(api.createCheckoutSession).toHaveBeenCalledTimes(1));
    checkout.release();
  });
});

describe('after the money has moved', () => {
  it('holds an activating state and stops offering to pay again', async () => {
    api.createCheckoutSession.mockResolvedValue({
      provider: 'razorpay',
      subscription_id: 'sub_1',
      key_id: 'rzp_test',
    });
    razorpay.openRazorpayCheckout.mockResolvedValue({
      razorpay_payment_id: 'pay_1',
      razorpay_subscription_id: 'sub_1',
      razorpay_signature: 'sig',
    });
    // Verification failing is NOT a payment failure: the customer has already
    // been charged and the activation webhook reconciles.
    api.verifyRazorpaySubscription.mockRejectedValue(new Error('gateway timeout'));

    renderDialog();
    await userEvent.click(screen.getByRole('button', { name: /subscribe/i }));

    const notice = await screen.findByText(/do not pay again/i);
    expect(notice).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /subscribe/i })).toBeDisabled();
    // And it must never read as a failure.
    expect(screen.queryByText(/could not complete/i)).toBeNull();
  });
});

describe('paths that move no money', () => {
  it('routes a downgrade to Free through change-plan rather than checkout', async () => {
    api.changePlan.mockResolvedValue({});
    renderDialog({ currentPlan: STANDARD, hasActiveSubscription: true });

    await userEvent.click(screen.getByRole('button', { name: /move to free/i }));
    await waitFor(() => expect(api.changePlan).toHaveBeenCalledWith(1, 'monthly', null));
    expect(api.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('offers a card-free trial when one is available, and calls start-trial', async () => {
    api.startTrial.mockResolvedValue({});
    renderDialog({ trialUsed: false });

    const card = screen.getByRole('button', { name: /start 7-day trial/i });
    await userEvent.click(card);
    await waitFor(() => expect(api.startTrial).toHaveBeenCalledWith('standard'));
    expect(api.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('never offers a trial the backend would refuse', () => {
    renderDialog({ trialUsed: true });
    expect(screen.queryByRole('button', { name: /trial/i })).toBeNull();
    expect(screen.getByRole('button', { name: /subscribe/i })).toBeInTheDocument();
  });

  it('says so, rather than offering a dead button, when checkout is not wired', () => {
    renderDialog({ geo: buildGeo({ ...INDIA, checkout_available: false }) });
    expect(screen.getByText(/checkout is unavailable right now/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /subscribe/i })).toBeDisabled();
  });
});

describe('the keyboard path', () => {
  it('reaches the cycle toggle and a plan without a mouse', async () => {
    api.startTrial.mockResolvedValue({});
    renderDialog({ trialUsed: false });

    const group = screen.getByRole('radiogroup', { name: 'Billing cycle' });
    // Tab into the group: the roving tabindex means only the selected segment
    // is in the tab order, which is what makes a five-segment filter bar one
    // tab stop rather than five.
    await userEvent.tab();
    await waitFor(() =>
      expect(within(group).getByRole('radio', { name: 'Monthly' })).toHaveFocus(),
    );
    await userEvent.keyboard('{ArrowRight}');
    expect(within(group).getByRole('radio', { name: /yearly/i })).toBeChecked();

    await userEvent.keyboard('{ArrowLeft}');
    expect(within(group).getByRole('radio', { name: 'Monthly' })).toBeChecked();

    screen.getByRole('button', { name: /start 7-day trial/i }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(api.startTrial).toHaveBeenCalled());
  });
});
