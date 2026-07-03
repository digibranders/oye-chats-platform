/**
 * Money formatting for minor-unit amounts (paise / cents).
 *
 * INR renders with the rupee symbol and INDIAN digit grouping
 * (₹1,52,458 — lakh/crore commas), everything else falls back to the
 * dollar symbol with western grouping. Whole amounts drop the decimals
 * (₹499 not ₹499.00); fractional amounts always show 2dp — mirrors the
 * behaviour the Billing page's fmtCurrency has always had.
 *
 * @param {number} amountMinor - Amount in the currency's minor unit (paise for INR, cents for USD).
 * @param {string} [currency='usd'] - ISO currency code, case-insensitive ('inr' | 'usd' | ...).
 * @returns {string} e.g. "₹1,52,458" · "₹58.31" · "$19" · "$4.50"
 */
export function formatMoney(amountMinor, currency = 'usd') {
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
