import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UsagePage } from './UsagePage';

/**
 * jsdom has no ResizeObserver, and Recharts' ResponsiveContainer constructs one
 * on mount. Without this the trend chart throws an uncaught exception that
 * fails every test in the file for a reason that has nothing to do with any of
 * them. Local to this file: `src/test/setup.ts` is shared and is not ours.
 */
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', StubResizeObserver);

/**
 * Usage answers "where did the credits go", and it has to answer it about a
 * stated period, at the rates that are actually in force, for a scope the
 * customer chose. All three were missing: the costs were hard-coded in a
 * component while a super-admin could retune them, figures floated over no
 * window, and the ledger was workspace-wide in the UI while being bot-scoped in
 * the database.
 */

const api = vi.hoisted(() => ({
  getCreditBalance: vi.fn(),
  getCreditHistory: vi.fn(),
  getCreditDaily: vi.fn(),
  getCurrentSubscription: vi.fn(),
  getSubscriptionPlans: vi.fn(),
  getInvoices: vi.fn(),
  getBillingDetails: vi.fn(),
  getActivePromotion: vi.fn(),
  getBillingGeo: vi.fn(),
  getPaymentRecovery: vi.fn(),
  getTopupPacks: vi.fn(),
  initiateTopup: vi.fn(),
  verifyTopupPayment: vi.fn(),
  recordBillingEvent: vi.fn(),
}));
vi.mock('../../services/api', () => api);
vi.mock('../../lib/razorpay', () => ({ openRazorpayCheckout: vi.fn() }));

const state = vi.hoisted(() => ({
  entitlements: {
    plan_slug: 'standard',
    limits: {} as Record<string, number>,
    features: { topup_allowed: true } as Record<string, unknown>,
    usage: {} as Record<string, number>,
  },
}));
vi.mock('../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({ entitlements: state.entitlements, hasFeature: () => true, limitFor: () => 0 }),
}));

const AGENT_POOL = {
  bot_id: 7,
  bot_name: 'Acme Support',
  bot_key: 'bot-acme',
  plan_name: 'Standard',
  monthly_grant: 3000,
  plan: 1800,
  topup: 0,
  total: 1800,
  period_start: '2026-08-01T00:00:00Z',
  resets_at: '2026-09-01T00:00:00Z',
  usage: { ai_chat: { credits_used: 1200, event_count: 1200 } },
  limits: { operators: 2, documents: -1, leads: 500 },
  limit_usage: { operators: 1, documents: 12, leads: 40 },
};

const BALANCE = {
  plan: 2400,
  topup: 500,
  total: 2900,
  monthly_grant: 3000,
  period_start: '2026-08-01T00:00:00Z',
  resets_at: '2026-09-01T00:00:00Z',
  soonest_expiry: null,
  costs: {
    ai_chat: 2,
    url_scan: 5,
    document_upload: 3,
    email_send: 1,
    email_verification: 10,
    company_name: 10,
  },
  usage: {
    ai_chat: { credits_used: 400, event_count: 200 },
    url_scan: { credits_used: 200, event_count: 40 },
  },
  currency: 'INR',
  bots: [AGENT_POOL],
  account_pool_bot_count: 1,
};

const LEDGER = [
  { id: 1, delta: 3000, reason: 'plan_grant', created_at: '2026-08-01T00:00:00Z', note: null },
  { id: 2, delta: -2, reason: 'ai_chat', created_at: '2026-08-02T09:12:00Z', note: null },
];

function renderPage(entry = '/billing/usage') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <UsagePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.entitlements = {
    plan_slug: 'standard',
    limits: {},
    features: { topup_allowed: true },
    usage: {},
  };
  for (const fn of Object.values(api)) fn.mockReset();
  api.getCreditBalance.mockResolvedValue(BALANCE);
  api.getCreditHistory.mockResolvedValue(LEDGER);
  api.getCreditDaily.mockResolvedValue({
    days: 30,
    series: [{ date: '2026-08-01', credits_used: 40 }],
  });
  api.getCurrentSubscription.mockResolvedValue({ subscription: null, plan: null });
  api.getSubscriptionPlans.mockResolvedValue([]);
  api.getInvoices.mockResolvedValue([]);
  api.getBillingDetails.mockResolvedValue({});
  api.getActivePromotion.mockResolvedValue({ active: false });
  api.getBillingGeo.mockResolvedValue({ country: 'IN', display_currency: 'INR', display_rate: 94.67 });
  api.getPaymentRecovery.mockResolvedValue({ past_due: false });
  api.getTopupPacks.mockResolvedValue([]);
});

describe('the four states', () => {
  it('shows a loading placeholder before the balance lands', () => {
    api.getCreditBalance.mockReturnValue(new Promise(() => {}));
    const { container } = renderPage();
    expect(container.querySelector('[aria-busy]')).not.toBeNull();
  });

  it('shows an error with a retry when the balance cannot be read', async () => {
    api.getCreditBalance.mockRejectedValue(new Error('Credits service is down'));
    renderPage();
    expect(await screen.findByText('Credits service is down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('shows a forbidden state, not an error, for a seat that may not read it', async () => {
    api.getCreditBalance.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    renderPage();
    expect(await screen.findByText(/cannot read this workspace's usage/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('explains an empty ledger rather than showing a blank table', async () => {
    api.getCreditHistory.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No credit movements yet')).toBeInTheDocument();
  });

  it('degrades the trend on its own without blanking the page', async () => {
    api.getCreditDaily.mockRejectedValue(new Error('Trend unavailable'));
    renderPage();
    expect(await screen.findByText('Trend unavailable')).toBeInTheDocument();
    // The balance is still on screen.
    expect(screen.getAllByText('Left to spend').length).toBeGreaterThan(0);
  });
});

describe('credit costs', () => {
  it('renders the rates the server sent, not a hard-coded price list', async () => {
    renderPage();
    const table = await screen.findByRole('table', { name: /credit cost per action/i });
    const chatRow = within(table).getByRole('row', { name: /AI reply/i });
    // The seeded default is 1 credit; this workspace has been retuned to 2 and
    // the UI must say 2.
    expect(chatRow.textContent).toContain('2 credits');
    expect(within(table).getByRole('row', { name: /Page crawled/i }).textContent).toContain('5 credits');
  });

  it('shows an em dash, never zero, for an action the pricing does not declare', async () => {
    api.getCreditBalance.mockResolvedValue({ ...BALANCE, costs: { ai_chat: 2 } });
    renderPage();
    const table = await screen.findByRole('table', { name: /credit cost per action/i });
    const crawlRow = within(table).getByRole('row', { name: /Page crawled/i });
    expect(crawlRow.textContent).toContain('—');
    expect(crawlRow.textContent).not.toContain('0 credits');
  });

  it('states the period the usage column covers', async () => {
    renderPage();
    await screen.findByRole('table', { name: /credit cost per action/i });
    expect(screen.getAllByText(/1 Aug 2026 to 1 Sept? 2026/).length).toBeGreaterThan(0);
  });
});

describe('scope', () => {
  it('reads the whole workspace by default and asks for no bot id', async () => {
    renderPage();
    await screen.findAllByText('Left to spend');
    expect(api.getCreditHistory).toHaveBeenCalledWith(
      expect.objectContaining({ botId: undefined }),
    );
  });

  it('scopes the ledger and the trend to one chatbot when the URL names one', async () => {
    renderPage('/billing/usage?chatbot=7');
    await screen.findAllByText('Acme Support');
    await waitFor(() =>
      expect(api.getCreditHistory).toHaveBeenCalledWith(expect.objectContaining({ botId: 7 })),
    );
    expect(api.getCreditDaily).toHaveBeenCalledWith(expect.objectContaining({ botId: 7 }));
  });

  it('switching scope moves it into the URL so the view can be linked', async () => {
    renderPage();
    await screen.findAllByText('Left to spend');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Usage scope' }), '7');
    await waitFor(() =>
      expect(api.getCreditHistory).toHaveBeenCalledWith(expect.objectContaining({ botId: 7 })),
    );
  });

  it('shows that chatbot`s plan ceilings, with the unlimited sentinel as a word', async () => {
    renderPage('/billing/usage?chatbot=7');
    await screen.findByText('Acme Support allowances');
    expect(screen.getByText('Operator seats')).toBeInTheDocument();
    expect(screen.getByText(/of unlimited/i)).toBeInTheDocument();
    expect(screen.queryByText('-1')).toBeNull();
  });
});

describe('the trend window', () => {
  it('asks the server for the window on screen', async () => {
    renderPage();
    await screen.findAllByText('Left to spend');
    expect(api.getCreditDaily).toHaveBeenCalledWith(expect.objectContaining({ days: 30 }));

    await userEvent.click(screen.getByRole('radio', { name: '7 days' }));
    await waitFor(() =>
      expect(api.getCreditDaily).toHaveBeenCalledWith(expect.objectContaining({ days: 7 })),
    );
  });
});

describe('top-ups', () => {
  it('is offered when the plan allows it', async () => {
    renderPage();
    await screen.findAllByText('Left to spend');
    expect(screen.getByRole('button', { name: /buy credits/i })).toBeEnabled();
  });

  it('is disabled and explained, not silently missing, when the plan does not', async () => {
    state.entitlements = { ...state.entitlements, features: { topup_allowed: false } };
    renderPage();
    await screen.findAllByText('Left to spend');
    expect(screen.getByRole('button', { name: /buy credits/i })).toBeDisabled();
    expect(screen.getByText(/not available on your plan/i)).toBeInTheDocument();
  });
});

describe('a paused chatbot', () => {
  /**
   * `GET /credits/balance` used to filter `Bot.is_active`, so a paused agent
   * with its own subscription lost its card entirely — no balance, no usage, no
   * expiry warning, for a ledger the customer is still funding. The query no
   * longer filters and discloses the pause on the entry, so the console must
   * render it: a card that vanishes is worse than a card that says "paused".
   */
  const PAUSED = { ...AGENT_POOL, is_active: false, topup: 400, soonest_expiry: '2026-09-15T00:00:00Z' };

  it('keeps the card and names the pause instead of dropping the agent', async () => {
    api.getCreditBalance.mockResolvedValue({ ...BALANCE, bots: [PAUSED] });
    renderPage();

    expect(await screen.findAllByText('Acme Support')).not.toHaveLength(0);
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(
      screen.getByText(/Not answering visitors, so it is spending nothing/i),
    ).toBeInTheDocument();
  });

  it('says the subscription and the expiry carry on, so pause is not read as cancelled', async () => {
    api.getCreditBalance.mockResolvedValue({ ...BALANCE, bots: [PAUSED] });
    renderPage('/billing/usage?chatbot=7');

    expect(await screen.findByText('This chatbot is paused')).toBeInTheDocument();
    const notice = screen.getByText('This chatbot is paused').closest('div');
    expect(notice?.textContent).toMatch(/subscription is still active and still billing/i);
    expect(notice?.textContent).toMatch(/expiry dates, which do not pause/i);
    // Never the vocabulary of an ended plan.
    expect(notice?.textContent).not.toMatch(/cancel|expired|broken/i);
  });

  it('keeps a paused agent selectable, labelled for what it is', async () => {
    api.getCreditBalance.mockResolvedValue({ ...BALANCE, bots: [PAUSED] });
    renderPage();
    await screen.findAllByText('Left to spend');

    expect(
      within(screen.getByRole('combobox', { name: 'Usage scope' })).getByRole('option', {
        name: 'Acme Support (paused)',
      }),
    ).toBeInTheDocument();
  });

  it('does not blame an empty balance on the pause, or the pause on the balance', async () => {
    api.getCreditBalance.mockResolvedValue({
      ...BALANCE,
      bots: [{ ...PAUSED, plan: 0, topup: 0, total: 0 }],
    });
    renderPage('/billing/usage?chatbot=7');

    expect(await screen.findByText('This chatbot is paused')).toBeInTheDocument();
    // Two separate facts, said separately: it is switched off, and it is also
    // out of credits, so resuming alone would not bring it back.
    expect(screen.getByText('This chatbot has no credits left either')).toBeInTheDocument();
  });

  it('still says "stopped answering" for an active agent that ran out', async () => {
    api.getCreditBalance.mockResolvedValue({
      ...BALANCE,
      bots: [{ ...AGENT_POOL, plan: 0, topup: 0, total: 0 }],
    });
    renderPage('/billing/usage?chatbot=7');

    expect(await screen.findByText('This chatbot has stopped answering')).toBeInTheDocument();
  });
});

describe('running out', () => {
  it('says the chatbot has stopped answering once the balance hits zero', async () => {
    api.getCreditBalance.mockResolvedValue({ ...BALANCE, plan: 0, topup: 0, total: 0, bots: [] });
    renderPage();
    expect(await screen.findByText(/stopped answering/i)).toBeInTheDocument();
  });
});
