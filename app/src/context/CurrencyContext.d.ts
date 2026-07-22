import { type ReactElement, type ReactNode } from 'react';

/**
 * Type shim for the legacy `context/CurrencyContext.jsx`. Runtime stays in the
 * `.jsx`; this types the provider + hook the new billing surfaces consume.
 *
 * Currency follows the account's billing country (IN → INR, else USD); the
 * display currency equals the charge currency. Fed by GET /subscriptions/geo,
 * so the provider MUST wrap the authenticated tree.
 */
export interface CurrencyValue {
  /** ISO-2 billing country, or null before /geo resolves. */
  country: string | null;
  /** Lowercase display currency: 'inr' | 'usd'. */
  currency: string;
  isInr: boolean;
  loading: boolean;
  /** Format a minor-unit amount in the account's display currency. */
  format: (minor: number) => string;
  /** Optimistic local currency/country override (re-confirmed by /geo next load). */
  setCountry: (next: string | null) => void;
}

export const CurrencyProvider: (props: { children: ReactNode }) => ReactElement;
export function useCurrency(): CurrencyValue;
