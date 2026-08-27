import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BillingPage } from './BillingPage';

/**
 * The billing page's job is to be believed.
 *
 * Everything pinned here is a fact a customer would act on: whether their last
 * payment went through, when their plan ends, how many chatbots they may run,
 * and what cancelling actually does. Each of them was either absent from the
 * surface this replaces or was stated without the date, the period or the
 * currency that makes it true.
 */

const api = vi.hoisted(() => ({
  getCurrentSubscription: vi.fn(),
  getSubscriptionPlans: vi.fn(),
  getInvoices: vi.fn(),
  getBillingDetails: vi.fn(),
  getActivePromotion: vi.fn(),
  getBillingGeo: vi.fn(),
  getPaymentRecovery: vi.fn(),
  getCreditBalance: vi.fn(),
  getPaymentMethods: vi.fn(),
  deletePaymentMethod: vi.fn(),
  updateBillingDetails: vi.fn(),
  cancelSubscription: vi.fn(),
  cancelScheduledChange: vi.fn(),
  resumeSubscription: vi.fn(),
  changeOperatorSeats: vi.fn(),
  changePlan: vi.fn(),
  createCheckoutSession: vi.fn(),
  startTrial: vi.fn(),
  verifyRazorpaySubscription: vi.fn(),
  recordBillingEvent: vi.fn(),
}));

vi.mock('../../services/api', () => api);
vi.mock('../../lib/razorpay', () => ({ openRazorpayCheckout: vi.fn() }));
vi.mock('../../context/CurrencyContext', () => ({
  useCurrency: () => ({
    country: 'IN',
    countrySource: 'stored',
    currency: 'inr',
    isInr: true,
    loading: false,
  }),
}));

const state = vi.hoisted(() => ({
  entitlements: {
    plan_slug: 'standard',
    limits: { bots: 1, operators: 2, credits: 3000 } as Record<string, number>,
    features: { topup_allowed: true } as Record<string, unknown>,
    usage: { bots: 1, operators: 1 } as Record<string, number>,
  },
}));
vi.mock('../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    entitlements: state.entitlements,
    hasFeature: () => true,
    limitFor: () => 0,
  }),
}));

const PLAN = {
  id: 3,
  slug: 'standard',
  name: 'Standard',
  monthly_price_cents: 94900,
  annual_price_cents: 949000,
  monthly_price_usd_cents: 1900,
  credits_per_month: 3000,
  included_operator_seats: 2,
  extra_seat_price_cents: 29900,
  overage_rate_cents: 50,
  trial_days: 7,
  sort_order: 3,
  limits: { bots: 1, operators: 2 },
  features: {},
};

const AGENCY_PLAN = {
  ...PLAN,
  id: 5,
  slug: 'enterprise',
  name: 'Enterprise',
  limits: { bots: -1 },
};

function subscriptionPayload(overrides: Record<string, unknown> = {}) {
  return {
    subscription: {
      id: 1,
      status: 'active',
      billing_cycle: 'monthly',
      operator_quantity: 2,
      current_period_end: '2026-09-14T00:00:00Z',
      payment_provider: 'razorpay',
      cancel_at_period_end: false,
      ...overrides,
    },
    plan: PLAN,
    trial_used: false,
    reauth: null,
  };
}

const BALANCE = {
  plan: 2400,
  topup: 500,
  total: 2900,
  monthly_grant: 3000,
  period_start: '2026-08-01T00:00:00Z',
  resets_at: '2026-09-01T00:00:00Z',
  costs: {
    ai_chat: 1,
    url_scan: 3,
    document_upload: 3,
    email_send: 1,
    email_verification: 10,
    company_name: 10,
  },
  usage: { ai_chat: { credits_used: 600, event_count: 600 } },
  currency: 'INR',
  bots: [],
  account_pool_bot_count: 1,
};

function renderPage(entry = '/billing') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <BillingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.entitlements = {
    plan_slug: 'standard',
    limits: { bots: 1, operators: 2, credits: 3000 },
    features: { topup_allowed: true },
    usage: { bots: 1, operators: 1 },
  };
  for (const fn of Object.values(api)) fn.mockReset();
  api.getCurrentSubscription.mockResolvedValue(subscriptionPayload());
  api.getSubscriptionPlans.mockResolvedValue([PLAN]);
  api.getInvoices.mockResolvedValue([]);
  api.getBillingDetails.mockResolvedValue({ legal_name: 'Acme Pvt Ltd', billing_country: 'IN' });
  api.getActivePromotion.mockResolvedValue({ active: false });
  api.getBillingGeo.mockResolvedValue({
    country: 'IN',
    country_source: 'stored',
    display_currency: 'INR',
    display_rate: 94.67,
    checkout_available: true,
  });
  api.getPaymentRecovery.mockResolvedValue({ past_due: false, recoverable: false });
  api.getCreditBalance.mockResolvedValue(BALANCE);
  api.getPaymentMethods.mockResolvedValue([]);
  api.cancelSubscription.mockResolvedValue({});
  api.cancelScheduledChange.mockResolvedValue({});
  api.resumeSubscription.mockResolvedValue({});
});

describe('the page frame', () => {
  it('has exactly one h1, from the page header', async () => {
    renderPage();
    await screen.findByText('Standard');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('offers the three money destinations as real links', async () => {
    renderPage();
    const nav = screen.getByRole('navigation', { name: 'Billing sections' });
    // Links, not buttons: middle-click and copy-link-address both matter on a
    // page a customer forwards to whoever holds the company card.
    expect(within(nav).getByRole('link', { name: 'Usage' })).toHaveAttribute(
      'href',
      '/billing/usage',
    );
    expect(within(nav).getByRole('link', { name: 'Reports' })).toHaveAttribute(
      'href',
      '/billing/reports',
    );
    await screen.findByText('Standard');
  });

  it('uses no native title attributes anywhere', async () => {
    const { container } = renderPage();
    await screen.findByText('Standard');
    expect(container.querySelectorAll('[title]')).toHaveLength(0);
  });
});

describe('the four states', () => {
  it('shows a loading skeleton before the subscription lands', () => {
    let release: (value: unknown) => void = () => {};
    api.getCurrentSubscription.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const { container } = renderPage();
    expect(container.querySelector('[aria-busy]')).not.toBeNull();
    release(subscriptionPayload());
  });

  it('shows an error with a retry when the subscription cannot be read', async () => {
    api.getCurrentSubscription.mockRejectedValue(new Error('Subscription service is down'));
    renderPage();
    expect(await screen.findByText('Subscription service is down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('shows a forbidden state, not an error, when the seat may not read billing', async () => {
    const forbidden = Object.assign(new Error('Forbidden'), { status: 403 });
    api.getCurrentSubscription.mockRejectedValue(forbidden);
    renderPage();
    expect(
      await screen.findByText(/only visible to workspace owners and admins/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('shows an empty invoice table that explains why it is empty', async () => {
    renderPage();
    expect(await screen.findByText('No invoices yet')).toBeInTheDocument();
    expect(screen.getByText(/appears here the moment a paid plan is charged/i)).toBeInTheDocument();
  });
});

describe('dunning', () => {
  it('tells a past-due customer what happens, when, and gives them the hosted page', async () => {
    api.getPaymentRecovery.mockResolvedValue({
      past_due: true,
      recoverable: true,
      recovery_url: 'https://rzp.io/i/recover',
      days_left: 3,
      plan_name: 'Standard',
    });
    renderPage();
    const banner = await screen.findByText(/could not take your last payment/i);
    expect(banner.textContent).toContain('in 3 days');
    expect(screen.getByRole('link', { name: /pay now/i })).toHaveAttribute(
      'href',
      'https://rzp.io/i/recover',
    );
  });

  it('offers a plan choice, not a dead retry, once the mandate is settled', async () => {
    api.getPaymentRecovery.mockResolvedValue({ past_due: true, recoverable: false, days_left: 1 });
    renderPage();
    await screen.findByText(/could not take your last payment/i);
    expect(screen.queryByRole('link', { name: /pay now/i })).toBeNull();
    expect(screen.getByRole('button', { name: /choose a plan/i })).toBeInTheDocument();
  });

  it('offers a re-check, and claims nothing, when the gateway could not be reached', async () => {
    api.getPaymentRecovery.mockResolvedValue({ past_due: true, recoverable: null, days_left: 5 });
    renderPage();
    const banner = await screen.findByText(/could not reach the payment gateway/i);
    expect(banner).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /check again/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /pay now/i })).toBeNull();
  });

  it('never renders a downgrade re-auth grace row as a failed payment', async () => {
    api.getCurrentSubscription.mockResolvedValue({
      ...subscriptionPayload({ status: 'past_due' }),
      reauth: {
        required: true,
        reason: 'downgrade_reauth',
        target_plan_name: 'Starter',
        grace_until: '2026-09-01T00:00:00Z',
        days_left: 4,
      },
    });
    renderPage();
    expect(await screen.findByText(/finish switching to your new plan/i)).toBeInTheDocument();
    expect(
      screen.getByText(/nothing failed and you have not been charged twice/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/could not take your last payment/i)).toBeNull();
  });
});

describe('the plan summary', () => {
  it('anchors the price to its cycle', async () => {
    renderPage();
    await screen.findByText('₹949');
    expect(screen.getByText('Per month')).toBeInTheDocument();
    // The charge currency is stated only when it differs from the displayed
    // one. "Charged in INR" under a price already printed in INR is a line of
    // type carrying nothing.
    expect(screen.queryByText('Charged in INR')).toBeNull();
  });

  it('shows the overage rate the plan configures', async () => {
    renderPage();
    expect(await screen.findByText('₹0.50')).toBeInTheDocument();
    expect(screen.getByText('Extra credits')).toBeInTheDocument();
  });

  it('never renders the unlimited sentinel as a number', async () => {
    api.getCurrentSubscription.mockResolvedValue({
      ...subscriptionPayload(),
      plan: { ...AGENCY_PLAN, included_operator_seats: -1 },
    });
    state.entitlements = { ...state.entitlements, usage: { bots: 4, operators: 3 } };
    renderPage();
    expect(await screen.findByText('Unlimited chatbots', { exact: false })).toBeInTheDocument();
    expect(screen.queryByText('-1')).toBeNull();
    expect(screen.getAllByText(/of unlimited/i).length).toBeGreaterThan(0);
  });

  it('states the renewal date rather than a bare "renews"', async () => {
    renderPage();
    expect(await screen.findByText('Renews')).toBeInTheDocument();
    expect(screen.getByText(/14 Sept? 2026/)).toBeInTheDocument();
  });
});

describe('scheduled changes', () => {
  it('names the plan and the date, and offers to call it off', async () => {
    api.getCurrentSubscription.mockResolvedValue(
      subscriptionPayload({
        scheduled_change: {
          plan_id: 2,
          plan_name: 'Starter',
          effective_at: '2026-09-14T00:00:00Z',
        },
      }),
    );
    renderPage();
    expect(await screen.findByText('Switching to Starter')).toBeInTheDocument();
    expect(screen.getByText(/takes effect on 14 Sept? 2026/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /call it off/i }));
    await waitFor(() => expect(api.cancelScheduledChange).toHaveBeenCalled());
  });

  it('lets a customer who has cancelled change their mind, scoped to the same subscription', async () => {
    api.getCurrentSubscription.mockResolvedValue(
      subscriptionPayload({ cancel_at_period_end: true }),
    );
    renderPage('/billing?chatbot=7');
    await screen.findByText('Your subscription is set to end');

    await userEvent.click(screen.getAllByRole('button', { name: /keep my plan/i })[0]);
    // The bot scope must travel with it: without it the backend resolves the
    // account subscription, which for a per-chatbot plan is a different row.
    await waitFor(() => expect(api.resumeSubscription).toHaveBeenCalledWith(7));
  });
});

describe('cancelling', () => {
  it('is a confirm dialog that states the real consequence, with the real date', async () => {
    renderPage();
    await screen.findByText('Standard');

    await userEvent.click(screen.getByRole('button', { name: /cancel subscription/i }));
    const dialog = await screen.findByRole('alertdialog');

    expect(within(dialog).getByText(/Cancel Standard\?/)).toBeInTheDocument();
    expect(dialog.textContent).toMatch(/14 Sept? 2026/);
    expect(dialog.textContent).toContain('credit grant stops');
    expect(dialog.textContent).toContain('500 purchased top-up credits');
    expect(dialog.textContent).toContain('chatbots, documents and conversations are kept');
    // Never the empty threat.
    expect(dialog.textContent).not.toContain('cannot be undone');
  });

  it('defaults to the safe answer and only cancels on the explicit control', async () => {
    renderPage();
    await screen.findByText('Standard');
    await userEvent.click(screen.getByRole('button', { name: /cancel subscription/i }));
    const dialog = await screen.findByRole('alertdialog');

    // Focus lands on the way out, not on the destructive button. Waited for
    // rather than asserted outright: `findByRole` resolves as soon as the
    // dialog is in the DOM, and Base UI moves focus into it a tick later, so
    // the bare assertion caught focus still on the page's own trigger. It
    // failed every run in isolation and passed under the full suite, where the
    // machine is busy enough for the focus to land first.
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Keep my plan' })).toHaveFocus(),
    );
    expect(api.cancelSubscription).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel subscription' }));
    await waitFor(() => expect(api.cancelSubscription).toHaveBeenCalledWith(null, null));
  });

  it('can be dismissed from the keyboard without cancelling anything', async () => {
    renderPage();
    await screen.findByText('Standard');
    await userEvent.click(screen.getByRole('button', { name: /cancel subscription/i }));
    await screen.findByRole('alertdialog');

    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.cancelSubscription).not.toHaveBeenCalled();
  });
});

describe('credits at a glance', () => {
  it('states the period every figure covers', async () => {
    renderPage();
    await screen.findByText('Standard');
    const periods = await screen.findAllByText(/1 Aug 2026 to 1 Sept? 2026/);
    expect(periods.length).toBeGreaterThan(0);
  });

  it('warns before the balance runs out, and differently once it has', async () => {
    api.getCreditBalance.mockResolvedValue({ ...BALANCE, plan: 100, topup: 0, total: 100 });
    renderPage();
    expect(await screen.findByText(/nearly out/i)).toBeInTheDocument();

    api.getCreditBalance.mockResolvedValue({ ...BALANCE, plan: 0, topup: 0, total: 0 });
    renderPage();
    expect(await screen.findByText(/stopped answering/i)).toBeInTheDocument();
  });
});
