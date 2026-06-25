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
 *   ent.withinLimit('documents', 3)   → boolean
 *   ent.limits.documents              → number (-1 means unlimited)
 *   ent.usage.documents               → current count for display
 *   ent.planSlug                      → 'free' | 'starter' | ...
 *   ent.isFree                        → convenience boolean
 *
 * ## Per-bot billing model
 *
 * Bot creation is no longer governed by a per-plan ``bots`` ceiling. Free
 * accounts get exactly one bot; paid accounts can hold an unlimited number
 * of bots, each as its own subscription. The dashboard's "Add Bot"
 * affordance gates with the simple rule "free + already has a bot → open
 * upgrade modal" — the canonical decision happens server-side via
 * ``can_client_add_new_bot`` (which returns 402 with
 * ``detail.must_subscribe`` when the client should be paywalled).
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
 * is notified and re-loads in lockstep.
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

    return {
        ...data,
        planSlug: data.plan_slug,
        planName: data.plan_name,
        isFree: data.plan_slug === 'free' || data.is_free,
        isEnterprise: data.plan_slug === 'enterprise' || data.is_enterprise,
        topupAllowed: data.topup_allowed,
        hasFeature: (name) => Boolean((data.features || {})[name]),
        limitFor: (name) => {
            const value = (data.limits || {})[name];
            return typeof value === 'number' ? value : 0;
        },
        withinLimit: (name, current) => {
            const value = (data.limits || {})[name];
            if (value === UNLIMITED) return true;
            if (typeof value !== 'number') return false;
            return current < value;
        },
        remaining: (name, current) => {
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
