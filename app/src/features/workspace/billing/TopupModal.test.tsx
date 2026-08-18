import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopupModal } from './TopupModal';

// The modal's money path is initiateTopup → openRazorpayCheckout →
// verifyTopupPayment. All are mocked; these tests drive the CANCELLATION
// branch: the customer closing the Razorpay sheet must (a) show the neutral
// "you were not charged" notice and (b) fire the checkout_abandoned funnel
// event, a dropped call site or typo'd surface string regressed nothing
// before this file existed.
const getTopupPacks = vi.fn();
const initiateTopup = vi.fn();
const verifyTopupPayment = vi.fn();
const recordBillingEvent = vi.fn();
// The dialog also reads the credit ledger to decide what it may truthfully say
// about top-up expiry (see creditExpiryCopy.test.tsx). Irrelevant to the money
// path under test here, but the import must resolve.
const getCreditBalance = vi.fn();
vi.mock('../../../services/api', () => ({
  getTopupPacks: (...args: unknown[]) => getTopupPacks(...args),
  initiateTopup: (...args: unknown[]) => initiateTopup(...args),
  verifyTopupPayment: (...args: unknown[]) => verifyTopupPayment(...args),
  recordBillingEvent: (...args: unknown[]) => recordBillingEvent(...args),
  getCreditBalance: (...args: unknown[]) => getCreditBalance(...args),
}));

const openRazorpayCheckout = vi.fn();
vi.mock('../../../lib/razorpay', () => ({
  openRazorpayCheckout: (...args: unknown[]) => openRazorpayCheckout(...args),
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

const PACK = { amount: 1599, credits: 2000, currency: 'INR' };

function mockHappyPathUntilCheckout() {
  getTopupPacks.mockResolvedValue([PACK]);
  getCreditBalance.mockResolvedValue({});
  initiateTopup.mockResolvedValue({
    key_id: 'rzp_test',
    order_id: 'order_test_1',
    amount: 159900,
    currency: 'INR',
  });
}

describe('TopupModal cancellation', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reports the abandonment and shows the neutral notice when the sheet is dismissed', async () => {
    mockHappyPathUntilCheckout();
    const dismissed = Object.assign(new Error('Checkout dismissed by user'), { code: 'dismissed' });
    openRazorpayCheckout.mockRejectedValue(dismissed);

    render(<TopupModal open onClose={() => undefined} />);
    fireEvent.click(await screen.findByText('Pay securely'));

    await waitFor(() => {
      expect(recordBillingEvent).toHaveBeenCalledWith('checkout_abandoned', 'topup', {
        amount: PACK.amount,
      });
    });
    expect(await screen.findByText('Payment cancelled - you were not charged.')).toBeTruthy();
    expect(verifyTopupPayment).not.toHaveBeenCalled();
  });

  it('reports a gateway decline as payment_failed', async () => {
    mockHappyPathUntilCheckout();
    const failed = Object.assign(new Error('Card declined'), { code: 'payment_failed' });
    openRazorpayCheckout.mockRejectedValue(failed);

    render(<TopupModal open onClose={() => undefined} />);
    fireEvent.click(await screen.findByText('Pay securely'));

    await waitFor(() => {
      expect(recordBillingEvent).toHaveBeenCalledWith('payment_failed', 'topup', {
        amount: PACK.amount,
      });
    });
    expect(verifyTopupPayment).not.toHaveBeenCalled();
  });

  it('fires no funnel event on a successful payment', async () => {
    mockHappyPathUntilCheckout();
    openRazorpayCheckout.mockResolvedValue({
      razorpay_order_id: 'order_test_1',
      razorpay_payment_id: 'pay_test_1',
      razorpay_signature: 'sig',
    });
    verifyTopupPayment.mockResolvedValue({ status: 'ok' });

    render(<TopupModal open onClose={() => undefined} onSuccess={() => undefined} />);
    fireEvent.click(await screen.findByText('Pay securely'));

    await waitFor(() => {
      expect(verifyTopupPayment).toHaveBeenCalled();
    });
    expect(recordBillingEvent).not.toHaveBeenCalled();
  });
});
