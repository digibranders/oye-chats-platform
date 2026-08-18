/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getBillingGeo } from '../services/api';
import { formatMoney } from '../lib/currency';

const CurrencyContext = createContext(null);

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
function chargeCurrencyFor(country) {
  const normalized = String(country || '').trim().toUpperCase();
  return normalized && normalized !== 'IN' ? 'usd' : 'inr';
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
export function CurrencyProvider({ children }) {
  const [country, setCountryState] = useState(null);
  // Trust grade of `country`: 'stored' (account fact) | 'detected' (IP geo,
  // display-only) | 'user' (picked in this session) | null. Money routes must
  // only ever receive a non-'detected' country as billing_country.
  const [countrySource, setCountrySource] = useState(null);
  const [currency, setCurrency] = useState(chargeCurrencyFor(null));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    getBillingGeo()
      .then((geo) => {
        if (!alive) return;
        setCountryState(geo?.country ?? null);
        setCountrySource(geo?.country_source ?? null);
        // A geo response missing display_currency is as unknown as no response
        // at all - fall back to the charge currency, not to USD.
        setCurrency(
          geo?.display_currency
            ? String(geo.display_currency).toLowerCase()
            : chargeCurrencyFor(geo?.country),
        );
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
      loading,
      format: (minor) => formatMoney(minor, currency),
      // Local override for a country the SERVER has already accepted (the
      // billing-details form calls this with the persisted response value, so
      // a billing_country_locked 409 never reaches here). /geo re-confirms it
      // next load. Cleared back to null -> INR, same unknown-means-domestic
      // rule as the initial state.
      setCountry: (next) => {
        const c = String(next || '').toUpperCase() || null;
        setCountryState(c);
        setCountrySource(c ? 'user' : null);
        setCurrency(chargeCurrencyFor(c));
      },
    }),
    [country, countrySource, currency, loading],
  );

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext);
  if (!ctx) throw new Error('useCurrency must be used within a CurrencyProvider');
  return ctx;
}
