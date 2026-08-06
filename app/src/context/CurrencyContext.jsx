/* eslint-disable react-refresh/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { getBillingGeo } from '../services/api';
import { formatMoney } from '../lib/currency';

const CurrencyContext = createContext(null);

/**
 * Single source of truth for the account's display currency across the admin
 * app. Currency follows the account's billing country (IN -> INR, else USD);
 * the display currency equals the charge currency, so every price the user
 * sees matches what Razorpay debits.
 *
 * Fed by GET /subscriptions/geo, which already derives display_currency from
 * the confirmed billing country. MUST wrap the AUTHENTICATED tree - /geo
 * requires client auth.
 */
export function CurrencyProvider({ children }) {
  const [country, setCountryState] = useState(null);
  // Trust grade of `country`: 'stored' (account fact) | 'detected' (IP geo,
  // display-only) | 'user' (picked in this session) | null. Money routes must
  // only ever receive a non-'detected' country as billing_country.
  const [countrySource, setCountrySource] = useState(null);
  const [currency, setCurrency] = useState('usd'); // lowercase -> matches formatMoney
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    getBillingGeo()
      .then((geo) => {
        if (!alive) return;
        setCountryState(geo?.country ?? null);
        setCountrySource(geo?.country_source ?? null);
        setCurrency(String(geo?.display_currency || 'USD').toLowerCase());
      })
      .catch(() => {
        /* keep the USD default on failure - never block the UI on geo */
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
      // Optimistic local override (checkout / billing-settings picker). The
      // server persists billing_country separately; /geo re-confirms next load.
      setCountry: (next) => {
        const c = String(next || '').toUpperCase() || null;
        setCountryState(c);
        setCountrySource(c ? 'user' : null);
        setCurrency(c === 'IN' ? 'inr' : 'usd');
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
