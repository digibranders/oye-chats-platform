import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TopupModal } from './TopupModal';

/**
 * What a credit-pack tile prints vs what Razorpay debits vs what we post.
 *
 * Pack prices are published exclusive of GST, so a pack carries two rupee
 * figures: `inr` (the base, and the amount the order route is called with, since
 * the server applies tax itself) and `gross_inr` (base + GST, what the sheet
 * shows). Printing the base made the tile disagree with the sheet by 18%;
 * posting the gross would tax an already-taxed amount. Both directions are
 * pinned here, in one test, so they cannot be transcribed apart.
 */

const getTopupPacks = vi.fn();
const initiateTopup = vi.fn();
const verifyTopupPayment = vi.fn();
const recordBillingEvent = vi.fn();
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
    isInr: true,
    taxRateBps: 1800,
    loading: false,
    format: (minor: number) => `₹${minor / 100}`,
    setCountry: () => undefined,
  }),
}));

/** The smallest live pack: ₹1,000 base, ₹1,180 charged. */
const TAXED_PACK = { inr: 1000, gross_inr: 1180, credits: 2000, bonus_pct: 0 };

function renderModal(packs: Array<Record<string, unknown>>): void {
  getTopupPacks.mockResolvedValue(packs);
  getCreditBalance.mockResolvedValue({});
  render(<TopupModal open onClose={() => undefined} />);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('TopupModal - base vs gross', () => {
  it('prints the gross and posts the base', async () => {
    renderModal([TAXED_PACK]);

    expect(await screen.findByText('₹1,180')).toBeInTheDocument();
    expect(screen.queryByText('₹1,000')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Pay securely'));
    // The order route adds the tax itself, so posting ₹1,180 would charge GST
    // on GST.
    await waitFor(() => expect(initiateTopup).toHaveBeenCalledWith(1000, { botId: null }));
  });

  it('drops the exclusive-of-GST note once every tile shows the charge', async () => {
    renderModal([TAXED_PACK]);

    await screen.findByText('₹1,180');
    expect(screen.queryByText(/Prices exclude GST/i)).not.toBeInTheDocument();
  });

  it('falls back to the base, plus the note, for a pack with no gross', async () => {
    renderModal([{ inr: 1000, credits: 2000, bonus_pct: 0 }]);

    expect(await screen.findByText('₹1,000')).toBeInTheDocument();
    expect(
      screen.getByText('Prices exclude GST. 18% GST is added at checkout.'),
    ).toBeInTheDocument();
  });

  it('keeps the note while any tile on screen is still a base price', async () => {
    renderModal([TAXED_PACK, { inr: 4000, credits: 9000, bonus_pct: 10 }]);

    expect(await screen.findByText('₹1,180')).toBeInTheDocument();
    expect(screen.getByText('₹4,000')).toBeInTheDocument();
    expect(
      screen.getByText('Prices exclude GST. 18% GST is added at checkout.'),
    ).toBeInTheDocument();
  });
});
