import { useEffect, useState } from 'react';
import { getBillingGeo } from '../../services/api';

/**
 * Geo-aware price helper for the bot create flow, mirroring PlanModal's rule:
 * prefer the stored USD columns when the visitor's display currency is USD,
 * otherwise fall back to an INR→USD rate conversion; only country IN sees INR.
 *
 * `price(plan, cycle)` returns the **monthly-equivalent** minor units (cents)
 * plus the currency symbol. Annual columns are full-year totals, so the annual
 * cycle divides by 12 — matching how the wizard renders "$X/mo".
 *
 * The geo profile is fetched once on mount and cached for the hook's lifetime
 * (geo doesn't change mid-session). A failed fetch degrades to USD defaults.
 */
export function useBotPricing() {
    const [geo, setGeo] = useState(null);

    useEffect(() => {
        let cancelled = false;
        getBillingGeo()
            .then((profile) => { if (!cancelled) setGeo(profile); })
            .catch(() => { if (!cancelled) setGeo(null); });
        return () => { cancelled = true; };
    }, []);

    const price = (plan, cycle) => {
        if (!plan) return { cents: 0, symbol: '$' };
        const display = (geo?.display_currency || 'USD').toUpperCase();

        if (display === 'USD') {
            // Prefer the exact stored USD prices (what the gateway charges).
            const usdTotal = cycle === 'annual'
                ? (plan.annual_price_usd_cents ?? plan.monthly_price_usd_cents)
                : plan.monthly_price_usd_cents;
            if (usdTotal != null) {
                const cents = cycle === 'annual' ? Math.round(usdTotal / 12) : usdTotal;
                return { cents, symbol: '$' };
            }
            // No USD column → convert the INR price at the geo rate.
            const rate = Number(geo?.display_rate) || 94.67;
            const inr = cycle === 'annual'
                ? Math.round((plan.annual_price_cents ?? 0) / 12)
                : (plan.monthly_price_cents ?? 0);
            return { cents: Math.round((inr / 100 / rate) * 100), symbol: '$' };
        }

        // Country IN (or any non-USD display) → native INR.
        const inr = cycle === 'annual'
            ? Math.round((plan.annual_price_cents ?? 0) / 12)
            : (plan.monthly_price_cents ?? 0);
        return { cents: inr, symbol: '₹' };
    };

    return { geo, price };
}
