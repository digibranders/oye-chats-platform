/**
 * One click, one charge, the per-agent purchase half.
 *
 * `submitting` disables both CTAs, but that is not a guard: two clicks
 * dispatched before React flushes the state update both reach the handler, and
 * each one calls `createBotCheckout`, which mints a Razorpay subscription
 * server-side. Two authorised mandates each charge a full cycle.
 *
 * `usePlanCheckout` got this latch for the account-level money path, but this
 * dialog never went through that hook: it imports `createBotCheckout` and runs
 * its own inline submit, so it was left holding only the disabled button. This
 * is the same guard on the path a Starter / Standard / Professional customer
 * uses to buy an additional agent.
 *
 * Releasing matters as much as guarding: a customer who hits a recoverable
 * failure (gateway timeout, declined card, a dismissed Razorpay sheet) must
 * be able to try again.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreateAgentDialog } from './CreateAgentDialog';
import { openRazorpayCheckout } from '../../lib/razorpay';

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

const openCheckout = vi.mocked(openRazorpayCheckout);

/** The paywall signal `apiErrors.requiresSubscription` keys on. */
function mustSubscribeError(): Error & { status: number; data: unknown } {
  return Object.assign(new Error('Each additional chatbot needs its own paid subscription.'), {
    status: 402,
    data: { detail: { error: 'upgrade_required', metric: 'bots', must_subscribe: true } },
  });
}

function renderDialog(): void {
  render(
    <MemoryRouter>
      <CreateAgentDialog
        open
        onOpenChange={vi.fn()}
        onCreated={vi.fn()}
        onCheckoutComplete={vi.fn()}
        gate={{ kind: 'requires_plan', agentCount: 1, agentLimit: 1 }}
        planName="Starter"
      />
    </MemoryRouter>,
  );
}

/** Drive the dialog from the name step to a rendered, preselected plan list. */
async function openPricingStep(): Promise<void> {
  createBot.mockRejectedValue(mustSubscribeError());
  getSubscriptionPlans.mockResolvedValue([
    {
      id: 1,
      slug: 'standard',
      name: 'Standard',
      monthly_price_cents: 94900,
      annual_price_cents: 911000,
      credits_per_month: 5000,
      limits: { bots: 1 },
      features: {},
    },
  ]);
  renderDialog();
  fireEvent.change(screen.getByLabelText(/chatbot name/i), { target: { value: 'Second Assistant' } });
  fireEvent.click(screen.getByRole('button', { name: /continue to plans/i }));
  await waitFor(() => expect(screen.getByRole('list', { name: /available plans/i })).toBeInTheDocument());
}

/** The pay CTA on the pricing step. */
function payButton(): HTMLElement {
  return screen.getByRole('button', { name: /subscribe|pay|create/i });
}

describe('per-agent checkout re-entrancy', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('mints one mandate when the pay button is clicked twice in one batch', async () => {
    await openPricingStep();
    // Never settles: the window between the click and the response is exactly
    // where the second click lands.
    createBotCheckout.mockReturnValue(new Promise(() => undefined));

    const button = payButton();
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    // The whole point: one call, so one Razorpay subscription server-side.
    expect(createBotCheckout).toHaveBeenCalledTimes(1);
  });

  it('releases the latch after a recoverable failure so the customer can retry', async () => {
    await openPricingStep();
    createBotCheckout.mockRejectedValueOnce(new Error('gateway timeout'));

    await act(async () => {
      fireEvent.click(payButton());
    });
    await waitFor(() => expect(screen.getByText(/gateway timeout/i)).toBeInTheDocument());

    createBotCheckout.mockReturnValue(new Promise(() => undefined));
    await act(async () => {
      fireEvent.click(payButton());
    });

    // A failed attempt must not lock the customer out of paying.
    expect(createBotCheckout).toHaveBeenCalledTimes(2);
  });

  it('releases the latch when the customer dismisses the Razorpay sheet', async () => {
    await openPricingStep();
    createBotCheckout.mockResolvedValue({ subscription_id: 'sub_1', key_id: 'rzp_test' });
    // Dismissal returns from inside the `try`, so only the `finally` releases it.
    openCheckout.mockRejectedValueOnce(Object.assign(new Error('dismissed'), { code: 'dismissed' }));

    await act(async () => {
      fireEvent.click(payButton());
    });
    await waitFor(() => expect(createBotCheckout).toHaveBeenCalledTimes(1));

    await act(async () => {
      fireEvent.click(payButton());
    });

    // Closing the payment sheet is not an error. Reopening it must work.
    expect(createBotCheckout).toHaveBeenCalledTimes(2);
  });

  it('creates one agent when the name step is submitted twice in one batch', async () => {
    createBot.mockReturnValue(new Promise(() => undefined));
    renderDialog();
    fireEvent.change(screen.getByLabelText(/chatbot name/i), { target: { value: 'First Assistant' } });

    const button = screen.getByRole('button', { name: /continue to plans|create/i });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(createBot).toHaveBeenCalledTimes(1);
  });
});
