import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCreditBalance } from '../usage-model';
import { TopupDialog } from './TopupDialog';

/**
 * Buying credits is the smallest money path in the product and the one a
 * customer runs most often. What is pinned here is the currency contract (an
 * INR debit must never hide behind a USD figure), the dismissal rule (a dialog
 * closed mid-charge leaves the customer unable to tell whether they paid), and
 * the expiry claim, which is a term of sale and is read from the customer's own
 * ledger rather than asserted.
 */

const api = vi.hoisted(() => ({
  getTopupPacks: vi.fn(),
  initiateTopup: vi.fn(),
  verifyTopupPayment: vi.fn(),
  recordBillingEvent: vi.fn(),
}));
const razorpay = vi.hoisted(() => ({ openRazorpayCheckout: vi.fn() }));
vi.mock('../../../services/api', () => api);
vi.mock('../../../lib/razorpay', () => razorpay);

/**
 * The dialog carries the tax disclosure, which reads the charge currency from
 * `CurrencyProvider` (mounted for real in `ProtectedLayout`). Stubbed rather
 * than provided so these tests stay about the purchase path: what the note
 * itself says on each rail is pinned in `TaxNote.test.tsx`.
 */
vi.mock('../../../context/CurrencyContext', () => ({
  useCurrency: () => ({ isInr: true, loading: false, taxRateBps: 1800 }),
}));

const PACKS = [
  { inr: 1000, usd: 13, credits: 1000, bonus_pct: 0 },
  { inr: 4000, usd: 50, credits: 5000, bonus_pct: 20, badge: 'Best value' },
];

function balance(overrides: Record<string, unknown> = {}) {
  return parseCreditBalance({
    plan: 100,
    topup: 500,
    total: 600,
    monthly_grant: 3000,
    bots: [],
    ...overrides,
  });
}

function renderDialog(props: Partial<React.ComponentProps<typeof TopupDialog>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const onOpenChange = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <TopupDialog
        open
        onOpenChange={onOpenChange}
        displayCurrency="INR"
        balance={balance()}
        botId={null}
        botName={null}
        onPurchased={vi.fn()}
        onBillingDetailsRequired={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onOpenChange };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  razorpay.openRazorpayCheckout.mockReset();
  api.getTopupPacks.mockResolvedValue(PACKS);
});

describe('currency', () => {
  it('shows the rupee charge to a domestic buyer, with no conversion to explain', async () => {
    renderDialog();
    expect(await screen.findByText('₹1,000')).toBeInTheDocument();
    expect(screen.queryByText(/charged as/i)).toBeNull();
  });

  it('shows a foreign buyer the dollar price AND the rupee amount that is debited', async () => {
    renderDialog({ displayCurrency: 'USD' });
    expect(await screen.findByText('$13')).toBeInTheDocument();
    expect(screen.getByText('Charged as ₹1,000')).toBeInTheDocument();
  });

  it('sends the rupee price to the server, never the dollar figure', async () => {
    api.initiateTopup.mockResolvedValue({});
    renderDialog({ displayCurrency: 'USD' });
    await userEvent.click(await screen.findByRole('button', { name: /\$13/ }));
    await waitFor(() => expect(api.initiateTopup).toHaveBeenCalledWith(1000, { botId: undefined }));
  });
});

describe('expiry, which is a term of sale', () => {
  it('states the date when the customer holds a grant that expires', async () => {
    renderDialog({ balance: balance({ soonest_expiry: '2026-12-01T00:00:00Z' }) });
    expect(await screen.findByText(/earliest on 1 Dec 2026/)).toBeInTheDocument();
  });

  it('claims credits never expire only when that is demonstrably true for them', async () => {
    renderDialog({ balance: balance({ soonest_expiry: null, topup: 500 }) });
    expect(await screen.findByText(/never expire/i)).toBeInTheDocument();
  });

  it('makes no claim at all when there is no evidence either way', async () => {
    renderDialog({ balance: balance({ soonest_expiry: null, topup: 0 }) });
    await screen.findByText('₹1,000');
    expect(screen.queryByText(/never expire/i)).toBeNull();
    expect(screen.queryByText(/do expire/i)).toBeNull();
  });
});

describe('a purchase in flight', () => {
  it('cannot be dismissed with Escape', async () => {
    api.initiateTopup.mockResolvedValue({ key_id: 'rzp', order_id: 'order_1', amount: 100000 });
    razorpay.openRazorpayCheckout.mockReturnValue(new Promise(() => {}));

    const { onOpenChange } = renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: /₹1,000/ }));
    await waitFor(() => expect(razorpay.openRazorpayCheckout).toHaveBeenCalled());

    await userEvent.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('does not open a second checkout on a second click', async () => {
    api.initiateTopup.mockResolvedValue({ key_id: 'rzp', order_id: 'order_1', amount: 100000 });
    razorpay.openRazorpayCheckout.mockReturnValue(new Promise(() => {}));

    renderDialog();
    const pack = await screen.findByRole('button', { name: /₹1,000/ });
    await userEvent.click(pack);
    await userEvent.click(pack);
    await waitFor(() => expect(api.initiateTopup).toHaveBeenCalledTimes(1));
  });
});

describe('outcomes', () => {
  it('says the customer was not charged when they close the payment sheet', async () => {
    api.initiateTopup.mockResolvedValue({ key_id: 'rzp', order_id: 'order_1', amount: 100000 });
    razorpay.openRazorpayCheckout.mockRejectedValue(Object.assign(new Error('closed'), { code: 'dismissed' }));

    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: /₹1,000/ }));
    expect(await screen.findByText(/you have not been charged/i)).toBeInTheDocument();
  });

  it('never suggests paying again when verification fails after a real charge', async () => {
    api.initiateTopup.mockResolvedValue({ key_id: 'rzp', order_id: 'order_1', amount: 100000 });
    razorpay.openRazorpayCheckout.mockResolvedValue({
      razorpay_order_id: 'order_1',
      razorpay_payment_id: 'pay_1',
      razorpay_signature: 'sig',
    });
    api.verifyTopupPayment.mockRejectedValue(new Error('verification timed out'));

    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: /₹1,000/ }));
    const message = await screen.findByText(/payment went through but we could not confirm it/i);
    expect(message).toBeInTheDocument();
    expect(message.textContent).toMatch(/do not pay again/i);
  });

  it('refuses to open a broken checkout rather than showing an empty payment sheet', async () => {
    api.initiateTopup.mockResolvedValue({});
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: /₹1,000/ }));
    expect(await screen.findByText(/checkout is temporarily unavailable/i)).toBeInTheDocument();
    expect(razorpay.openRazorpayCheckout).not.toHaveBeenCalled();
  });
});
