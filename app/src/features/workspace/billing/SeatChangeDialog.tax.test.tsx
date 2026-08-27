import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SeatChangeDialog } from './SeatChangeDialog';

/**
 * What an extra operator seat costs, said once and consistently.
 *
 * The caller can only hand this dialog the plan's BASE per-seat price: no read
 * endpoint quotes a gross seat price, only POST /subscriptions/seats does, and
 * that runs after the customer confirms. So the dialog has two jobs. Before the
 * POST it must not present the base as the amount debited, and after it, once
 * the server has quoted `gross_extra_seat_price_cents`, every figure on screen
 * must be that charge.
 */

const changeOperatorSeats = vi.fn();
const verifyRazorpaySubscription = vi.fn();
const recordBillingEvent = vi.fn();
vi.mock('../../../services/api', () => ({
  changeOperatorSeats: (...args: unknown[]) => changeOperatorSeats(...args),
  verifyRazorpaySubscription: (...args: unknown[]) => verifyRazorpaySubscription(...args),
  recordBillingEvent: (...args: unknown[]) => recordBillingEvent(...args),
}));

const openRazorpayCheckout = vi.fn();
vi.mock('../../../lib/razorpay', () => ({
  openRazorpayCheckout: (...args: unknown[]) => openRazorpayCheckout(...args),
}));

const taxRateBps = vi.fn(() => 1800);
vi.mock('../../../context/CurrencyContext', () => ({
  useCurrency: () => ({
    country: 'IN',
    countrySource: 'stored',
    currency: 'inr',
    isInr: true,
    taxRateBps: taxRateBps(),
    loading: false,
    format: (minor: number) => `₹${minor / 100}`,
    setCountry: () => undefined,
  }),
}));

function renderDialog(): void {
  render(
    <SeatChangeDialog
      open
      onClose={() => undefined}
      delta={1}
      currentSeats={2}
      seatPriceLabel="₹449/mo"
      onSuccess={() => undefined}
    />,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  taxRateBps.mockReturnValue(1800);
});

describe('SeatChangeDialog - the amount debited', () => {
  it('never claims the base price is the recurring charge', () => {
    renderDialog();

    expect(screen.getByText('Per-seat price, before GST')).toBeInTheDocument();
    expect(screen.getByText('₹449/mo')).toBeInTheDocument();
    expect(screen.getByText(/₹449\/mo plus 18% GST is added to your subscription/)).toBeInTheDocument();
  });

  it('leaves the price unqualified on a rail that adds no tax', () => {
    taxRateBps.mockReturnValue(0);
    renderDialog();

    expect(screen.getByText('Per-seat price')).toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toMatch(/plus .*GST/);
  });

  it('switches to the server-quoted charge once the seat response carries one', async () => {
    // A dismissed Razorpay sheet leaves the dialog open. The customer deciding
    // whether to retry should be looking at what would actually be taken.
    changeOperatorSeats.mockResolvedValue({
      requires_authorization: true,
      checkout: { key_id: 'rzp_test', subscription_id: 'sub_test' },
      extra_seat_price_cents: 44900,
      gross_extra_seat_price_cents: 52982,
      tax_rate_bps: 1800,
      currency: 'INR',
    });
    openRazorpayCheckout.mockRejectedValue(
      Object.assign(new Error('dismissed'), { code: 'dismissed' }),
    );

    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /Add seat/i }));

    expect(await screen.findByText('Per-seat price, GST included')).toBeInTheDocument();
    expect(screen.getByText('₹529.82/mo')).toBeInTheDocument();
    // The base-price disclosure would now contradict the figure beside it.
    await waitFor(() => expect(screen.queryByText(/Prices exclude GST/i)).not.toBeInTheDocument());
    expect(screen.queryByText(/plus 18% GST/)).not.toBeInTheDocument();
  });
});
