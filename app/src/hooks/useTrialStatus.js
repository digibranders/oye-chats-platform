import { useCallback, useEffect, useState } from 'react';
import { getCurrentUser } from '../services/api';

/**
 * One-shot hook that surfaces the authenticated client's trial state to
 * any layout / banner / button that needs to react to it.
 *
 * Backed by ``GET /auth/me`` whose ``trial`` payload was wired up in PR2.
 * The endpoint already returns a deterministic snapshot (``status``,
 * ``trial_end_at``, ``days_remaining``, ``credits_granted``) so this hook
 * is a thin pass-through with a stale-while-revalidate refresh.
 *
 * Two reasons it lives in its own hook rather than directly in TrialBanner:
 *
 * 1. The same status drives "show banner", "disable Upload knowledge",
 *    "show reactivate badge on Billing tab" — keeping one source of truth
 *    avoids three components disagreeing about whether the trial is over.
 * 2. Operators (X-Operator-Key) don't get a trial payload back from
 *    /auth/me — the hook short-circuits to ``status: null`` for them so
 *    nothing renders. Doing that check in every consumer would be noise.
 *
 * The hook does NOT poll. The auth-me payload only changes on register,
 * start-trial, conversion, or cron-driven expiry. Consumers that need to
 * see a fresh status (e.g. after the user clicks "Reactivate") should
 * call ``refresh()`` explicitly.
 */
export function useTrialStatus() {
    const [state, setState] = useState({
        status: null,             // 'trialing' | 'trial_expired' | 'active' | null
        daysRemaining: null,      // null for non-trialing
        trialEndAt: null,         // ISO-8601 string or null
        creditsGranted: null,     // number or null
        loading: true,
        error: null,
    });

    const refresh = useCallback(async () => {
        try {
            const me = await getCurrentUser();
            const trial = me?.trial || null;
            setState({
                status: trial?.status ?? null,
                daysRemaining: trial?.days_remaining ?? null,
                trialEndAt: trial?.trial_end_at ?? null,
                creditsGranted: trial?.credits_granted ?? null,
                loading: false,
                error: null,
            });
        } catch (err) {
            // Silent on auth failures — the auth flow handles redirects
            // upstream. We only surface the error so consumers can render
            // a fallback UI if they care to.
            setState((prev) => ({ ...prev, loading: false, error: err }));
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    // Convenience flags so consumers don't replicate the same predicates
    // (and stay in sync if we ever change what "read-only" means).
    const isTrialing = state.status === 'trialing';
    const isTrialExpired = state.status === 'trial_expired';
    const isReadOnly = isTrialExpired;

    return { ...state, isTrialing, isTrialExpired, isReadOnly, refresh };
}
