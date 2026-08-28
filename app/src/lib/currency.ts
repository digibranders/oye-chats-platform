// Single source of truth for the INR→USD display fallback rate, used only
// when the server's geo `display_rate` is unavailable. Must match the backend
// DISPLAY_USD_TO_INR default so every surface shows the same USD price (O5).
export const FALLBACK_USD_TO_INR = 94.67;

/** An entity carrying both currency columns: plans, credit packs, seats. */
export interface DualCurrencyAmount {
  inrMinor?: number | null;
  usdMinor?: number | null;
}

/**
 * Money formatting for minor-unit amounts (paise / cents).
 *
 * INR renders with the rupee symbol and INDIAN digit grouping
 * (₹1,52,458 - lakh/crore commas), everything else falls back to the
 * dollar symbol with western grouping. Whole amounts drop the decimals
 * (₹499 not ₹499.00); fractional amounts always show 2dp - mirrors the
 * behaviour the Billing page's fmtCurrency has always had.
 *
 * e.g. "₹1,52,458" · "₹58.31" · "$19" · "$4.50"
 */
export function formatMoney(amountMinor: number | null | undefined, currency = 'usd'): string {
  const isInr = String(currency || '').toLowerCase() === 'inr';
  const symbol = isInr ? '₹' : '$';
  // en-IN gives lakh/crore grouping (1,52,458); en-US gives western (152,458).
  const locale = isInr ? 'en-IN' : 'en-US';
  const major = Number(amountMinor || 0) / 100;
  const useDecimals = !Number.isInteger(major);
  return `${symbol}${major.toLocaleString(locale, {
    minimumFractionDigits: useDecimals ? 2 : 0,
    maximumFractionDigits: useDecimals ? 2 : 0,
  })}`;
}

/**
 * Choose the minor-unit amount for the active currency from an entity that
 * carries BOTH an INR column and a USD column (plans, packs, seats).
 *
 * INR is the charge currency for Indian accounts, so the INR column is read
 * directly (never a converted USD figure) - the number shown then equals the
 * Razorpay debit. Returns 0 when the active currency's column is absent.
 */
export function pickAmount({ inrMinor, usdMinor }: DualCurrencyAmount, currency: string): number {
  const isInr = String(currency || '').toLowerCase() === 'inr';
  return Number((isInr ? inrMinor : usdMinor) ?? 0);
}
