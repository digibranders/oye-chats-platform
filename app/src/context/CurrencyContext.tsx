/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getBillingGeo, type BillingGeoResponse } from '../services/api';
import { formatMoney } from '../lib/currency';

/** The two currencies this dashboard can price in. */
export type DisplayCurrency = 'inr' | 'usd';

/** Trust grade of `country`. A 'detected' country is DISPLAY-ONLY. */
export type CountrySource = 'stored' | 'detected' | 'user' | null;

export interface CurrencyValue {
  /** ISO-2 billing country, or null before /geo resolves. */
  country: string | null;
  /** Lowercase display currency. */
  currency: DisplayCurrency;
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
  format: (minor: number | null | undefined) => string;
  /** Optimistic local currency/country override (re-confirmed by /geo next load). */
  countrySource: CountrySource;
  /**
   * Optimistic local override for a country the SERVER has already accepted.
   * A foreign country also zeroes `taxRateBps` immediately (an export carries
   * no Indian GST); moving to the domestic rail keeps the last rate /geo
   * served until /geo re-confirms it on the next load.
   */
  setCountry: (next: string | null) => void;
}

const CurrencyContext = createContext<CurrencyValue | null>(null);

/**
 * The currency an ISO-2 billing country is actually CHARGED in, the JS mirror
 * of the server's `charge_currency` (api/app/core/pricing.py).
 *
 * An unknown country (null/blank) is NOT a foreign one: every account that
 * predates the country-confirmation step has a NULL billing_country and an INR
 * mandate, and the top-up rail waves an unconfirmed buyer through as domestic.
 * So unknown resolves to INR, never USD.
 *
 * @param {string|null|undefined} country - ISO-2 code, any case, or null.
 * @returns {'inr'|'usd'} lowercase - matches formatMoney's expectation.
 */
function chargeCurrencyFor(country: string | null | undefined): DisplayCurrency {
  const normalized = String(country || '').trim().toUpperCase();
  return normalized && normalized !== 'IN' ? 'usd' : 'inr';
}

/**
 * The tax rate GET /subscriptions/geo says will be ADDED to this account's
 * charges, in basis points (1800 = 18%).
 *
 * Zero is a real answer, not a placeholder: an export pays no Indian GST, and
 * a seller who is not GST-registered adds none. Anything missing, negative or
 * unparseable also reads as zero, because the only safe thing to say about a
 * rate we cannot read is nothing at all. Consumers gate disclosure copy on
 * `loading`, never on this value.
 *
 * @param {unknown} geo - the /geo envelope, or undefined.
 * @returns {number} basis points, >= 0.
 */
function readTaxRateBps(geo: BillingGeoResponse | undefined): number {
  const raw = Number(geo?.tax_rate_bps);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 0;
}

/**
 * Single source of truth for the account's display currency across the admin
 * app. Currency follows the account's billing country (IN -> INR, else USD),
 * as resolved by GET /subscriptions/geo.
 *
 * `currency` is NOT unconditionally the charge currency: for a *detected* (IP
 * geo) foreign country /geo deliberately reports USD while the charge path
 * would confirm IN. That divergence is safe only because it can never become a
 * charge, the frontend never echoes a 'detected' country back as
 * billing_country (usePlanCheckout.ts) and the server 409s
 * billing_country_required rather than debiting on an IP signal.
 *
 * Every case /geo does NOT answer for, however, must resolve to the currency
 * that WOULD be charged, because nothing downstream will catch a wrong guess:
 * the pre-resolve default and the fetch-failure fallback are both INR
 * (`chargeCurrencyFor(null)`), matching the server's charge_currency(None).
 * USD there was a live money bug, the top-up modal rendered $13/$50/$125
 * while Razorpay debited ₹1,000/₹4,000/₹10,000.
 *
 * MUST wrap the AUTHENTICATED tree - /geo requires client auth.
 */
/**
 * The display currency /geo named, or the charge currency when it named none
 * this app can price in.
 *
 * "Missing display_currency is as unknown as no response at all" already drove
 * the fallback; an UNRECOGNISED code is the same condition. It matters because
 * `formatMoney` only special-cases 'inr' and renders everything else with a
 * '$', so letting an unhandled code through would print, say, EUR amounts as
 * dollars. Falling back keeps the invariant this module exists for: never
 * price a surface in a currency the rail will not debit.
 */
function normalizeDisplayCurrency(
  raw: string | undefined,
  country: string | null | undefined,
): DisplayCurrency {
  const lowered = String(raw ?? '').trim().toLowerCase();
  if (lowered === 'inr' || lowered === 'usd') return lowered;
  return chargeCurrencyFor(country);
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [country, setCountryState] = useState<string | null>(null);
  // Trust grade of `country`: 'stored' (account fact) | 'detected' (IP geo,
  // display-only) | 'user' (picked in this session) | null. Money routes must
  // only ever receive a non-'detected' country as billing_country.
  const [countrySource, setCountrySource] = useState<CountrySource>(null);
  const [currency, setCurrency] = useState<DisplayCurrency>(chargeCurrencyFor(null));
  // Tax added on top of every listed price, in basis points. Starts at 0 and
  // stays there unless /geo names a rate: quoting a tax the seller does not
  // charge is a worse failure than quoting none.
  const [taxRateBps, setTaxRateBps] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    getBillingGeo()
      .then((geo) => {
        if (!alive) return;
        setCountryState(geo?.country ?? null);
        setCountrySource(geo?.country_source ?? null);
        setCurrency(normalizeDisplayCurrency(geo?.display_currency, geo?.country));
        setTaxRateBps(readTaxRateBps(geo));
      })
      .catch(() => {
        /* Keep the charge-currency default - never block the UI on geo, and
           never let a geo outage price a surface in a currency the rail will
           not debit. Consumers that show money gate on `loading` so this
           value is only ever rendered once we know geo is not coming. */
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const value = useMemo(
    () => ({
      country, // ISO-2 or null
      countrySource, // 'stored' | 'detected' | 'user' | null
      currency, // 'inr' | 'usd'
      isInr: currency === 'inr',
      // Basis points added to every listed price at checkout. 0 is an answer.
      taxRateBps,
      loading,
      format: (minor: number | null | undefined) => formatMoney(minor, currency),
      // Local override for a country the SERVER has already accepted (the
      // billing-details form calls this with the persisted response value, so
      // a billing_country_locked 409 never reaches here). /geo re-confirms it
      // next load. Cleared back to null -> INR, same unknown-means-domestic
      // rule as the initial state.
      setCountry: (next: string | null) => {
        const c = String(next || '').toUpperCase() || null;
        setCountryState(c);
        setCountrySource(c ? 'user' : null);
        const nextCurrency = chargeCurrencyFor(c);
        setCurrency(nextCurrency);
        // An export carries no Indian GST whatever the seller's rate is, so a
        // foreign country zeroes the rate here and now. Moving TO the domestic
        // rail keeps the last rate /geo served: the seller's registration is
        // not knowable locally, and /geo re-confirms it on the next load.
        if (nextCurrency !== 'inr') setTaxRateBps(0);
      },
    }),
    [country, countrySource, currency, taxRateBps, loading],
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency(): CurrencyValue {
  const ctx = useContext(CurrencyContext);
  if (!ctx) throw new Error('useCurrency must be used within a CurrencyProvider');
  return ctx;
}
