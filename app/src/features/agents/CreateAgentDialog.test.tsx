/**
 * The pricing step's plan filter, the one place in the app that hides a plan
 * from a picker.
 *
 * `POST /bots/checkout` mints a subscription scoped to ONE agent, so a plan
 * whose `limits.bots` is the UNLIMITED sentinel cannot be sold here: its
 * credits would land in that single agent's isolated ledger while every other
 * agent it entitles drained the unfunded shared pool. The server refuses such
 * a plan, and this dialog's filter is the matching UI half, without it the
 * customer picks a tier, pays nothing, and gets a 400 they cannot act on.
 *
 * Nothing covered the predicate at the call site before this file: the filter
 * is applied inside `loadPlans`, so a wrong `buildPlan` shape or a dropped
 * clause showed up only in production. These tests drive the real component
 * through the real 402 → pricing-step transition and assert on what the list
 * actually renders.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateAgentDialog } from './CreateAgentDialog';

const createBot = vi.fn();
const createBotCheckout = vi.fn();
const getSubscriptionPlans = vi.fn();
const verifyBotCheckout = vi.fn();
vi.mock('../../services/api', () => ({
  createBot: (...args: unknown[]) => createBot(...args),
  createBotCheckout: (...args: unknown[]) => createBotCheckout(...args),
  getSubscriptionPlans: (...args: unknown[]) => getSubscriptionPlans(...args),
  verifyBotCheckout: (...args: unknown[]) => verifyBotCheckout(...args),
}));

vi.mock('../../lib/razorpay', () => ({
  openRazorpayCheckout: vi.fn(),
}));

/** The paywall signal `apiErrors.requiresSubscription` keys on. */
function mustSubscribeError(): Error & { status: number; data: unknown } {
  return Object.assign(new Error('Each additional chatbot needs its own paid subscription.'), {
    status: 402,
    data: { detail: { error: 'upgrade_required', metric: 'bots', must_subscribe: true } },
  });
}

function plan(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 1,
    slug: 'standard',
    name: 'Standard',
    monthly_price_cents: 94900,
    annual_price_cents: 911000,
    credits_per_month: 5000,
    limits: { bots: 1 },
    features: {},
    ...overrides,
  };
}

/** Mount the dialog and submit the name step, which the mocked API 402s. */
function submitNameStep(): void {
  createBot.mockRejectedValue(mustSubscribeError());
  render(
    <MemoryRouter>
      <CreateAgentDialog
        open
        onClose={vi.fn()}
        onCreated={vi.fn()}
        onCheckoutComplete={vi.fn()}
        gate={{ kind: 'requires_plan', agentCount: 1, agentLimit: 1 }}
        planName="Starter"
      />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText(/chatbot name/i), { target: { value: 'Second Assistant' } });
  fireEvent.click(screen.getByRole('button', { name: /continue to plans/i }));
}

/** Drive the dialog from the name step to a rendered plan list. */
async function openPricingStep(): Promise<void> {
  submitNameStep();
  await waitFor(() => expect(screen.getByRole('list', { name: /available plans/i })).toBeInTheDocument());
}

describe('CreateAgentDialog plan filter', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers paid, finite-quota plans and hides the unlimited-agents tier', async () => {
    getSubscriptionPlans.mockResolvedValue([
      plan({ id: 1, slug: 'starter', name: 'Starter', limits: { bots: 1 } }),
      plan({ id: 3, slug: 'professional', name: 'Professional', limits: { bots: 1 } }),
      plan({ id: 5, slug: 'enterprise', name: 'Enterprise', limits: { bots: -1 } }),
    ]);

    await openPricingStep();

    expect(screen.getByText('Starter')).toBeInTheDocument();
    expect(screen.getByText('Professional')).toBeInTheDocument();
    expect(screen.queryByText('Enterprise')).not.toBeInTheDocument();
  });

  /* `Plan.limits` is untyped JSONB and the server reads the quota through
     `int(...)`, which accepts `"-1"`. While the client only recognised the
     number, this row stayed in the picker and its checkout 400'd, the
     customer chose a plan the money path would never sell. */
  it('hides an unlimited-agents tier whose quota is stored as a string', async () => {
    getSubscriptionPlans.mockResolvedValue([
      plan({ id: 1, slug: 'starter', name: 'Starter', limits: { bots: 1 } }),
      plan({ id: 5, slug: 'enterprise', name: 'Enterprise', limits: { bots: '-1' } }),
    ]);

    await openPricingStep();

    expect(screen.getByText('Starter')).toBeInTheDocument();
    expect(screen.queryByText('Enterprise')).not.toBeInTheDocument();
  });

  /* The Free tier funds nothing, so it is not a per-agent product either.
     `POST /bots/checkout` refuses it by slug. */
  it('hides the free tier', async () => {
    getSubscriptionPlans.mockResolvedValue([
      plan({ id: 1, slug: 'starter', name: 'Starter', limits: { bots: 1 } }),
      plan({ id: 0, slug: 'free', name: 'Free', monthly_price_cents: 0, annual_price_cents: 0 }),
    ]);

    await openPricingStep();

    expect(screen.getByText('Starter')).toBeInTheDocument();
    expect(screen.queryByText('Free')).not.toBeInTheDocument();
  });

  /* Conservative on bad data, exactly like the server: a hand-provisioned row
     with no `bots` quota is NOT unlimited and must stay purchasable. Reading a
     missing key as unlimited would silently withdraw a bespoke tier from sale. */
  it('keeps a bespoke plan row that declares no agent quota', async () => {
    getSubscriptionPlans.mockResolvedValue([
      plan({ id: 9, slug: 'bespoke-acme', name: 'Acme Bespoke', limits: { credits: 5000 } }),
    ]);

    await openPricingStep();

    expect(screen.getByText('Acme Bespoke')).toBeInTheDocument();
  });

  /* Filtering happens before selection, so the preselected plan can never be
     one the server would refuse. */
  it('preselects the first plan that survived the filter, not the first returned', async () => {
    getSubscriptionPlans.mockResolvedValue([
      plan({ id: 5, slug: 'enterprise', name: 'Enterprise', limits: { bots: -1 } }),
      plan({ id: 3, slug: 'professional', name: 'Professional', limits: { bots: 1 } }),
    ]);

    await openPricingStep();

    const selected = screen.getAllByRole('button', { pressed: true });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('Professional');
  });

  it('says so plainly when the filter leaves nothing to sell', async () => {
    getSubscriptionPlans.mockResolvedValue([
      plan({ id: 5, slug: 'enterprise', name: 'Enterprise', limits: { bots: -1 } }),
    ]);

    submitNameStep();

    await waitFor(() => expect(screen.getByText(/no plans are available right now/i)).toBeInTheDocument());
    expect(screen.queryByRole('list', { name: /available plans/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Enterprise')).not.toBeInTheDocument();
  });
});
