import { useCallback, useEffect, useState } from 'react';
import { getEntitlements } from '../services/api';

/**
 * useEntitlements — single source of truth for plan-driven UI gating.
 *
 * Components call this hook ONCE per render tree (typically near the top of
 * a page) and pass the result down via props or context. Two derived
 * predicates handle every gate question the UI cares about:
 *
 *   const ent = useEntitlements();
 *   ent.hasFeature('live_chat')      → boolean
 *   ent.withinLimit('bots', 1)        → boolean
 *   ent.limits.documents              → number (-1 means unlimited)
 *   ent.usage.documents               → current count for display
 *   ent.planSlug                      → 'free' | 'starter' | ...
 *   ent.isFree                        → convenience boolean
 *
 * ## Caching
 *
 * Result is cached in module scope for 60 seconds. Multiple components in
 * the same render tree share one network request. After a plan change (e.g.
 * a successful upgrade purchase), call `entitlementsRefresh()` to bust the
 * cache and re-fetch.
 *
 * ## Failure mode
 *
 * If /auth/me/entitlements fails, the hook returns the most-restrictive
 * Free plan defaults so the UI degrades to "lock everything down" rather
 * than accidentally exposing paid features.
 */

const FREE_FALLBACK = {
    plan_slug: 'free',
    plan_name: 'Free',
    subscription_status: 'none',
    limits: {
        credits: 250,
        bots: 1,
        // max_bots_cap = 1 on Free: there are no purchasable bot seats on
        // this tier. Paid plans (Starter=3, Standard=5) override this in
        // the backend response.
        max_bots_cap: 1,
        operators: 0,
        // Leads dashboard is feature-locked on Free (sidebar gate); the
        // numeric quota is UNLIMITED so lead storage continues to work
        // for the Insights → Conversations view the customer can access.
        leads: -1,
        page_scraping: 30,
        documents: 5,
        chat_history_days: 7,
    },
    features: {
        live_chat: false,
        bant: false,
        branding_removable: false,
        webhooks: false,
        api_access: false,
        online_support: false,
        topup_allowed: false,
        integrations: 'reply_to_only',
    },
    usage: {},
    is_free: true,
    is_enterprise: false,
    topup_allowed: false,
    // Paid bot-seat add-on state. Always present so callers don't have
    // to special-case missing keys when the fallback path runs.
    extra_bot_seats: 0,
    bot_seat_pricing: {},
};

const UNLIMITED = -1;
const CACHE_TTL_MS = 60_000;

let _cache = null;
let _cacheLoadedAt = 0;
let _inFlightPromise = null;

// Subscribers receive a notification whenever the module-level cache is
// busted, so every mounted `useEntitlements` hook re-fetches in lockstep.
// Without this, a purchase made through one component's `refresh()` would
// only update that component — sibling components (like the Chatbot page
// that opened the upgrade modal) would still see the stale ceiling on
// their next render.
const _subscribers = new Set();

function _notifySubscribers() {
    _subscribers.forEach((fn) => {
        try {
            fn();
        } catch {
            // Subscriber errors must never break sibling subscribers.
        }
    });
}

/**
 * Bust the entitlements cache so the next hook call refetches.
 * Call this after any action that changes the plan (subscription upgrade,
 * topup purchase, manual super-admin update). Every mounted hook instance
 * is notified and re-loads — so a paid seat add-on bought in the modal
 * lifts the bot limit in the Chatbot page without a manual reload.
 */
export function entitlementsRefresh() {
    _cache = null;
    _cacheLoadedAt = 0;
    _inFlightPromise = null;
    _notifySubscribers();
}

async function fetchEntitlements() {
    // Coalesce concurrent calls into the same network request so a page
    // with five FeatureGate components doesn't fire five HTTP requests.
    if (_inFlightPromise) return _inFlightPromise;

    _inFlightPromise = (async () => {
        try {
            const data = await getEntitlements();
            _cache = data;
            _cacheLoadedAt = Date.now();
            return data;
        } finally {
            _inFlightPromise = null;
        }
    })();
    return _inFlightPromise;
}

/**
 * Decorate the raw payload with the helper methods components use most.
 * Done at the hook layer (not the API layer) so the helpers stay
 * frontend-only concerns and don't pollute backend payload contracts.
 */
function decorate(raw) {
    const data = raw || FREE_FALLBACK;
    const extraSeats = Number(data.extra_bot_seats || 0);
    const pricing = data.bot_seat_pricing || {};

    // Effective bot limit mirrors the backend's
    // plan_entitlements_service._effective_bot_limit so the UI matches the
    // enforcement layer exactly. Returns -1 (UNLIMITED) when either the
    // included quota or the hard cap is unlimited (Enterprise).
    const computeEffectiveBotLimit = () => {
        const included = (data.limits || {}).bots;
        const cap = (data.limits || {}).max_bots_cap;
        if (typeof included !== 'number') return 0;
        if (included === UNLIMITED) return UNLIMITED;
        if (cap === undefined || cap === null) return included;
        if (typeof cap !== 'number') return included;
        if (cap === UNLIMITED) return UNLIMITED;
        return Math.min(included + Math.max(0, extraSeats), cap);
    };

    return {
        ...data,
        planSlug: data.plan_slug,
        planName: data.plan_name,
        isFree: data.plan_slug === 'free' || data.is_free,
        isEnterprise: data.plan_slug === 'enterprise' || data.is_enterprise,
        topupAllowed: data.topup_allowed,
        extraBotSeats: extraSeats,
        botSeatPricing: pricing,
        // True when the client has a paid plan that hasn't yet reached the
        // hard bot cap. Drives the "Add a bot — $5/mo" CTA in the upgrade
        // modal: when false, the modal falls back to "Upgrade your plan".
        canPurchaseBotSeat: (() => {
            if (!pricing || !pricing.usd_cents) return false;
            const included = (data.limits || {}).bots;
            const cap = (data.limits || {}).max_bots_cap;
            if (included === UNLIMITED || cap === UNLIMITED) return false;
            if (typeof included !== 'number' || typeof cap !== 'number') return false;
            return included + Math.max(0, extraSeats) < cap;
        })(),
        hasFeature: (name) => Boolean((data.features || {})[name]),
        limitFor: (name) => {
            if (name === 'bots') return computeEffectiveBotLimit();
            const value = (data.limits || {})[name];
            return typeof value === 'number' ? value : 0;
        },
        withinLimit: (name, current) => {
            if (name === 'bots') {
                const eff = computeEffectiveBotLimit();
                if (eff === UNLIMITED) return true;
                return current < eff;
            }
            const value = (data.limits || {})[name];
            if (value === UNLIMITED) return true;
            if (typeof value !== 'number') return false;
            return current < value;
        },
        remaining: (name, current) => {
            if (name === 'bots') {
                const eff = computeEffectiveBotLimit();
                if (eff === UNLIMITED) return Infinity;
                return Math.max(0, eff - current);
            }
            const value = (data.limits || {})[name];
            if (value === UNLIMITED) return Infinity;
            if (typeof value !== 'number') return 0;
            return Math.max(0, value - current);
        },
    };
}

/**
 * Main hook. Returns { entitlements, loading, error, refresh } so callers
 * can render skeletons during the first fetch and react to errors. Most
 * callers can ignore the metadata and use just `entitlements`.
 */
export default function useEntitlements() {
    const [entitlements, setEntitlements] = useState(() => {
        // Synchronous cache hit — no flash of loading state on remounts.
        if (_cache && Date.now() - _cacheLoadedAt < CACHE_TTL_MS) {
            return decorate(_cache);
        }
        return decorate(FREE_FALLBACK);
    });
    const [loading, setLoading] = useState(() => !_cache);
    const [error, setError] = useState(null);

    const load = useCallback(async () => {
        if (_cache && Date.now() - _cacheLoadedAt < CACHE_TTL_MS) {
            setEntitlements(decorate(_cache));
            setLoading(false);
            return;
        }
        try {
            const raw = await fetchEntitlements();
            setEntitlements(decorate(raw));
            setError(null);
        } catch (err) {
            // Stay on the Free fallback; surface the error so callers can
            // optionally show a toast. Locking down is the safer default
            // than accidentally exposing paid features.
            setError(err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        load();
        // Subscribe to module-level cache busts so a `refresh()` from any
        // sibling component re-pulls entitlements here too.
        _subscribers.add(load);
        return () => {
            _subscribers.delete(load);
        };
    }, [load]);

    const refresh = useCallback(() => {
        entitlementsRefresh();
        // entitlementsRefresh already fanned out to subscribers; calling
        // load() ourselves is a no-op due to the in-flight coalescer.
        return load();
    }, [load]);

    return { entitlements, loading, error, refresh };
}
