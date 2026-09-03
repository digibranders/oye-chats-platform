import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SeatDialog } from './SeatDialog';
import { buildPlan, type PlanView } from '../billingModel';

/**
 * Buying operator seats is a MONEY path, and its first purchase does not
 * complete on the POST.
 *
 * `POST /subscriptions/seats` answers `requires_authorization: true` with a
 * `checkout` payload for the seat add-on's own Razorpay mandate, and the route
 * deliberately leaves `operator_quantity` unchanged ("we do NOT grant
 * entitlement... the client opens this checkout"). The dialog used to discard
 * that response wholesale and announce "Added 1 seat. Your workspace now has
 * 3." — so a customer was told they had bought a seat that no payment sheet had
 * ever been opened for, and that the backend had explicitly not granted.
 *
 * What is pinned here: the checkout is opened, a dismissed sheet is reported as
 * "not charged" rather than as a purchase, and no path claims the seats are
 * live before the mandate is authorised.
 */

const api = vi.hoisted(() => ({ changeOperatorSeats: vi.fn() }));
const razorpay = vi.hoisted(() => ({ openRazorpayCheckout: vi.fn() }));
const billingApi = vi.hoisted(() => ({ verifyRazorpaySubscription: vi.fn() }));
vi.mock('../../../services/api', () => ({ ...api, ...billingApi }));
vi.mock('../../../lib/razorpay', () => razorpay);
// The dialog carries the tax disclosure, which reads the charge currency from
// `CurrencyProvider`. Stubbed so these tests stay about the purchase path.
vi.mock('../../../context/CurrencyContext', () => ({
  useCurrency: () => ({ isInr: true, loading: false, taxRateBps: 1800 }),
}));

const STANDARD = buildPlan({
  id: 3,
  slug: 'standard',
  name: 'Standard',
  monthly_price_cents: 94900,
  included_operator_seats: 2,
  extra_seat_price_cents: 44900,
  limits: { operators: 10 },
}) as PlanView;

function renderDialog(props: Partial<React.ComponentProps<typeof SeatDialog>> = {}) {
  const onChanged = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <SeatDialog
      open
      onOpenChange={onOpenChange}
      plan={STANDARD}
      currentSeats={2}
      seatsUsed={1}
      grossSeatPriceMinor={58882}
      taxRateBps={1800}
      botId={null}
      onChanged={onChanged}
      {...props}
    />,
  );
  return { onChanged, onOpenChange };
}

/** Render with control over `open`, for testing what survives a close. */
function renderDialogWithRerender() {
  const props = {
    onOpenChange: vi.fn(),
    plan: STANDARD,
    currentSeats: 2,
    seatsUsed: 1,
    grossSeatPriceMinor: 58882,
    taxRateBps: 1800,
    botId: null,
    onChanged: vi.fn(),
  };
  const view = render(<SeatDialog open {...props} />);
  return {
    rerender: (open: boolean) => view.rerender(<SeatDialog open={open} {...props} />),
  };
}

/** Set the seat total, then submit. */
async function setSeatsAndSubmit(total: string, button: RegExp) {
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: total } });
  await userEvent.click(screen.getByRole('button', { name: button }));
}

/** Raise the seat count by one and submit. */
async function addOneSeat() {
  await setSeatsAndSubmit('3', /continue to checkout/i);
}

const CHECKOUT = {
  key_id: 'rzp_test',
  subscription_id: 'sub_seat_1',
  name: 'OyeChats operator seats',
  description: '1 extra seat',
};

beforeEach(() => {
  api.changeOperatorSeats.mockReset();
  razorpay.openRazorpayCheckout.mockReset();
  billingApi.verifyRazorpaySubscription.mockReset();
});

describe('the first seat purchase', () => {
  it('opens the Razorpay checkout the server asked for', async () => {
    api.changeOperatorSeats.mockResolvedValue({
      requires_authorization: true,
      checkout: CHECKOUT,
      pending_seats: 1,
    });
    razorpay.openRazorpayCheckout.mockResolvedValue({
      razorpay_payment_id: 'pay_1',
      razorpay_subscription_id: 'sub_seat_1',
      razorpay_signature: 'sig',
    });
    billingApi.verifyRazorpaySubscription.mockResolvedValue({});

    renderDialog();
    await addOneSeat();

    await waitFor(() => expect(razorpay.openRazorpayCheckout).toHaveBeenCalledTimes(1));
    expect(razorpay.openRazorpayCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'rzp_test', subscription_id: 'sub_seat_1' }),
    );
  });

  it('never claims the seats are added while the mandate is unauthorised', async () => {
    api.changeOperatorSeats.mockResolvedValue({
      requires_authorization: true,
      checkout: CHECKOUT,
      pending_seats: 1,
    });
    razorpay.openRazorpayCheckout.mockResolvedValue({
      razorpay_payment_id: 'pay_1',
      razorpay_subscription_id: 'sub_seat_1',
      razorpay_signature: 'sig',
    });
    billingApi.verifyRazorpaySubscription.mockResolvedValue({});

    const { onChanged } = renderDialog();
    await addOneSeat();

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // The entitlement lands on the activation webhook, so the copy must not
    // assert a workspace seat count that the server has not moved.
    expect(onChanged.mock.calls[0][0]).not.toMatch(/now has 3/i);
  });

  it('reports a dismissed payment sheet as "not charged", not as a purchase', async () => {
    api.changeOperatorSeats.mockResolvedValue({
      requires_authorization: true,
      checkout: CHECKOUT,
      pending_seats: 1,
    });
    razorpay.openRazorpayCheckout.mockRejectedValue(
      Object.assign(new Error('closed'), { code: 'dismissed' }),
    );

    const { onChanged } = renderDialog();
    await addOneSeat();

    expect(await screen.findByText(/not been charged/i)).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('changes that move no money', () => {
  it('applies a reduction immediately, with no checkout', async () => {
    api.changeOperatorSeats.mockResolvedValue({ operator_quantity: 1 });

    const { onChanged } = renderDialog({ currentSeats: 3, seatsUsed: 0 });
    await setSeatsAndSubmit('1', /update seats/i);

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(razorpay.openRazorpayCheckout).not.toHaveBeenCalled();
    expect(onChanged.mock.calls[0][0]).toMatch(/removed/i);
  });
});

/**
 * What the dialog SAYS, which is the half that was wrong.
 *
 * Seats bill against one global Razorpay add-on, so the charge is the canonical
 * seat price. A plan row carries a copy of that price which is deliberately `0`
 * on every tier that sells no seats. The dialog multiplied the plan copy, so on
 * those tiers it quoted nothing and then reassured the customer that nothing
 * would be charged — while the server would have charged the canonical price.
 */
describe('the price it quotes', () => {
  it('names the per-seat price before anything is touched', () => {
    renderDialog();
    // ₹588.82 = ₹499 + 18% GST, the amount the seat mandate actually debits.
    expect(screen.getByText(/588\.82/)).toBeInTheDocument();
    expect(screen.getByText(/GST included/i)).toBeInTheDocument();
  });

  it('totals the extra seats, and only the extra ones', () => {
    // Standard includes 2. Going to 4 buys 2, not 4.
    renderDialog();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '4' } });
    expect(screen.getByText('2 extra seats')).toBeInTheDocument();
    expect(screen.getByText(/1,177\.64/)).toBeInTheDocument();
  });

  it('never says a charged seat is free', async () => {
    // The exact regression: a plan whose own row prices seats at 0 (Free, the
    // trial, Enterprise all seed it that way) used to render the reassurance.
    const freePriced = buildPlan({
      id: 9,
      slug: 'standard',
      name: 'Standard',
      included_operator_seats: 2,
      extra_seat_price_cents: 0,
      limits: { operators: 10 },
    }) as PlanView;
    renderDialog({ plan: freePriced });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '4' } });
    expect(screen.queryByText(/nothing extra is charged/i)).toBeNull();
    expect(screen.getByText(/1,177\.64/)).toBeInTheDocument();
  });

  it('refuses to start a purchase it could not price', () => {
    renderDialog({ grossSeatPriceMinor: null });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } });
    expect(screen.getByRole('button', { name: /continue to checkout/i })).toBeDisabled();
    expect(screen.getByText(/could not load the seat price/i)).toBeInTheDocument();
  });
});

describe('plans with nothing to sell', () => {
  it('explains a plan that includes no seats instead of offering a stepper', () => {
    const free = buildPlan({
      id: 1,
      slug: 'free',
      name: 'Free',
      included_operator_seats: 0,
      extra_seat_price_cents: 0,
      limits: { operators: 0 },
    }) as PlanView;
    renderDialog({ plan: free, currentSeats: 0, seatsUsed: 0 });
    expect(screen.getByText(/does not include operator seats/i)).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('explains an unlimited plan rather than selling against it', () => {
    const enterprise = buildPlan({
      id: 6,
      slug: 'enterprise',
      name: 'Enterprise',
      included_operator_seats: -1,
      extra_seat_price_cents: 0,
      limits: { operators: -1 },
    }) as PlanView;
    renderDialog({ plan: enterprise, currentSeats: -1, seatsUsed: 4 });
    expect(screen.getByText(/nothing to buy or remove/i)).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton')).toBeNull();
  });

  it('will not sell past the plan ceiling', () => {
    renderDialog();
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '11' } });
    expect(screen.getByText(/allows up to 10 seats/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue to checkout/i })).toBeDisabled();
  });
});

/**
 * Whose operators are being counted.
 *
 * `seatsUsed` reached this dialog as `entitlements.usage.operators`, which is
 * an ACCOUNT-WIDE count, while every other figure in it comes from one
 * chatbot's subscription. So a workspace with five operators, one of them on
 * this chatbot, was refused a reduction from two seats to one on this
 * chatbot's plan, a legal change the server would have accepted, under a
 * hint line that named three different scopes in one sentence.
 *
 * The count is now labelled by scope: a per-chatbot count is the floor for a
 * reduction, and an account-wide one is stated as such and may not block.
 */
describe('the scope of the filled-seat count', () => {
  it('will not reduce below the seats filled ON THIS CHATBOT', async () => {
    renderDialog({ currentSeats: 3, seatsUsed: 2, seatsUsedScope: 'chatbot' });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });

    expect(screen.getByText(/2 active operators on this chatbot/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /update seats/i })).toBeDisabled();
  });

  it('never blocks a reduction with a count taken across the whole workspace', async () => {
    renderDialog({ currentSeats: 2, seatsUsed: 5, seatsUsedScope: 'workspace' });
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } });

    expect(screen.queryByText(/deactivate one before reducing/i)).toBeNull();
    expect(screen.getByRole('button', { name: /update seats/i })).toBeEnabled();
    // It is still said, because a refusal from the server would otherwise
    // arrive with no explanation at all.
    expect(screen.getByText(/5 operators are active across this workspace/i)).toBeInTheDocument();
  });

  it('labels an account-wide count in the allowance hint rather than mixing scopes', () => {
    renderDialog({ currentSeats: 2, seatsUsed: 5, seatsUsedScope: 'workspace' });
    expect(screen.getByText(/5 filled across this workspace/i)).toBeInTheDocument();
  });

  it('leaves a per-chatbot hint unqualified, because every term is that chatbot’s', () => {
    renderDialog({ currentSeats: 2, seatsUsed: 1, seatsUsedScope: 'chatbot' });
    const hint = screen.getByText(/filled/i);
    expect(hint.textContent).toContain('1 filled');
    expect(hint.textContent).not.toMatch(/across this workspace/i);
  });
});

describe('the cancelled-purchase notice', () => {
  it('does not survive into a freshly opened dialog', async () => {
    api.changeOperatorSeats.mockResolvedValue({ requires_authorization: true, checkout: CHECKOUT });
    razorpay.openRazorpayCheckout.mockRejectedValue({ code: 'dismissed' });
    const { rerender } = renderDialogWithRerender();

    await setSeatsAndSubmit('3', /continue to checkout/i);
    expect(await screen.findByText(/not been charged/i)).toBeInTheDocument();

    // Close, reopen. The notice was cleared only inside `submit`, so it used to
    // reappear over an untouched dialog and tell someone a purchase they had
    // never started was cancelled.
    rerender(false);
    rerender(true);
    expect(screen.queryByText(/not been charged/i)).toBeNull();
  });

  it('clears as soon as the count is edited again', async () => {
    api.changeOperatorSeats.mockResolvedValue({ requires_authorization: true, checkout: CHECKOUT });
    razorpay.openRazorpayCheckout.mockRejectedValue({ code: 'dismissed' });
    renderDialog();

    await setSeatsAndSubmit('3', /continue to checkout/i);
    expect(await screen.findByText(/not been charged/i)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '4' } });
    expect(screen.queryByText(/not been charged/i)).toBeNull();
  });
});
