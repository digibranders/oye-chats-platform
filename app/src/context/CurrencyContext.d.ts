import { type ReactElement, type ReactNode } from 'react';

/**
 * Type shim for the legacy `context/CurrencyContext.jsx`. Runtime stays in the
 * `.jsx`; this types the provider + hook the new billing surfaces consume.
 *
 * Currency follows the account's billing country (IN → INR, else USD), fed by
 * GET /subscriptions/geo, so the provider MUST wrap the authenticated tree.
 * Before geo resolves (and if it never does) `currency` is the charge
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
   * Tax ADDED on top of every listed price at checkout, in basis points
   * (1800 = 18%), from `tax_rate_bps` on GET /subscriptions/geo. Prices in
   * this dashboard are published exclusive of tax, so this is the gap between
   * what a surface lists and what the rail debits.
   *
   * **0 is a legitimate answer, not a loading sentinel.** It means no tax is
   * added: an export of services carries no Indian GST, and a seller who is
   * not GST-registered adds none. A surface that reads 0 must therefore say
   * nothing about tax rather than assume a default rate. `loading` is the
   * only sentinel for "not known yet"; a missing or unreadable field on the
   * /geo response also resolves to 0, because the safest thing to say about
   * a rate we cannot read is nothing.
   *
   * Never multiply by this. Tax amounts come from the server (the checkout
   * quote's `gross_minor`/`tax_minor`, the add-on responses' `gross_*`
   * fields); this rate exists to word the disclosure, not to compute money.
   */
  taxRateBps: number;
  /**
   * True until /geo settles (resolved OR rejected). Any surface that renders
   * a PRICE must hold it back while this is true. `currency` is a safe
   * default, not yet an answer, and flipping it under the user on a money
   * surface reads as a price change.
   */
  loading: boolean;
  /** Format a minor-unit amount in the account's display currency. */
  format: (minor: number) => string;
  /** Optimistic local currency/country override (re-confirmed by /geo next load). */
  countrySource: 'stored' | 'detected' | 'user' | null;
  /**
   * Optimistic local override for a country the SERVER has already accepted.
   * A foreign country also zeroes `taxRateBps` immediately (an export carries
   * no Indian GST); moving to the domestic rail keeps the last rate /geo
   * served until /geo re-confirms it on the next load.
   */
  setCountry: (next: string | null) => void;
}

export const CurrencyProvider: (props: { children: ReactNode }) => ReactElement;
export function useCurrency(): CurrencyValue;
