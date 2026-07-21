/**
 * Type shim for the legacy currency helpers (`lib/currency.js`).
 * Runtime stays in the `.js`; this only types the exports new TS code uses.
 */

/** Fallback USD→INR rate used when the geo profile carries no live rate. */
export const FALLBACK_USD_TO_INR: number;

/** Format a minor-unit amount (paise/cents) with the currency symbol + grouping. */
export function formatMoney(amountMinor: number, currency?: string): string;

/** Pick the amount matching the active currency from an INR/USD minor-unit pair. */
export function pickAmount(
  amounts: { inrMinor?: number; usdMinor?: number },
  currency: string,
): number;
