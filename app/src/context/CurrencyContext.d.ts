import { type ReactElement, type ReactNode } from 'react';

/**
 * Type shim for the legacy `context/CurrencyContext.jsx`. Runtime stays in the
 * `.jsx`; this types the provider + hook the new billing surfaces consume.
 *
 * Currency follows the account's billing country (IN → INR, else USD), fed by
 * GET /subscriptions/geo, so the provider MUST wrap the authenticated tree.
 * Before geo resolves — and if it never does — `currency` is the charge
 * currency for an unconfirmed buyer ('inr'), so a surface that renders it
 * anyway can only ever show what the rail would debit.
 */
export interface CurrencyValue {
  /** ISO-2 billing country, or null before /geo resolves. */
  country: string | null;
  /** Lowercase display currency: 'inr' | 'usd'. */
  currency: string;
  isInr: boolean;
  /**
   * True until /geo settles (resolved OR rejected). Any surface that renders
   * a PRICE must hold it back while this is true — `currency` is a safe
   * default, not yet an answer, and flipping it under the user on a money
   * surface reads as a price change.
   */
  loading: boolean;
  /** Format a minor-unit amount in the account's display currency. */
  format: (minor: number) => string;
  /** Optimistic local currency/country override (re-confirmed by /geo next load). */
  countrySource: 'stored' | 'detected' | 'user' | null;
  setCountry: (next: string | null) => void;
}

export const CurrencyProvider: (props: { children: ReactNode }) => ReactElement;
export function useCurrency(): CurrencyValue;
