import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Clock, Sparkles, X } from 'lucide-react';
import { useTrialStatus } from '../hooks/useTrialStatus';
import { markBannerDismissed, readBannerDismissed } from '../utils/trialBanner';
import { trialDaysLeft } from '../utils/trial';

/**
 * Persistent trial-status banner shown at the top of every authenticated
 * page in the admin app.
 *
 * Three visual states, ranked by urgency:
 *
 *   1. ``trialing`` with > 3 days left → indigo informational chip.
 *      Low-key, doesn't dominate the page.
 *   2. ``trialing`` with ≤ 3 days left → amber urgency strip with
 *      countdown copy.
 *   3. ``trial_expired``                → rose-red blocker bar. The bot is
 *      already offline on the customer's website; we want the customer to
 *      reactivate fast.
 *
 * Renders nothing for paying customers (``status === 'active'``), for
 * operators (the hook returns ``status: null``), and during the initial
 * fetch (avoids a layout flash before the payload lands).
 *
 * All CTAs route to ``/billing``. PR-X's plan modal already handles "Start
 * free trial — Plan" and the trial-swap flow; piping users there keeps a
 * single payment surface instead of duplicating the modal at the layout
 * level.
 *
 * Dismissal
 * ─────────
 * Every variant carries an X button. The dismissal lives in
 * ``sessionStorage`` keyed by status so the banner returns on the next
 * browser session — a customer who closes the "trial ends tomorrow"
 * strip on Monday still sees the expiry on Tuesday. The key includes the
 * status so dismissing the calm chip doesn't suppress the urgent strip
 * three days later, and dismissing while trialing never suppresses the
 * eventual ``trial_expired`` blocker.
 */

function useBannerDismissal(status) {
    // ``trackedStatus`` snapshots the status the dismissal flag was last
    // computed against. When ``status`` changes (trialing → expired) we
    // re-read sessionStorage so the new status starts with a clean slate
    // — without this, dismissing the calm chip would also suppress the
    // expired blocker.
    const [trackedStatus, setTrackedStatus] = useState(status);
    const [dismissed, setDismissed] = useState(() => readBannerDismissed(status));

    if (status !== trackedStatus) {
        setTrackedStatus(status);
        setDismissed(readBannerDismissed(status));
    }

    const dismiss = useCallback(() => {
        markBannerDismissed(status);
        setDismissed(true);
    }, [status]);

    return { dismissed, dismiss };
}

export default function TrialBanner() {
    const { status, daysRemaining, trialEndAt, isTrialing, isTrialExpired, loading } = useTrialStatus();
    const { dismissed, dismiss } = useBannerDismissal(status);

    if (loading) return null;
    if (!status || status === 'active') return null;
    if (dismissed) return null;

    if (isTrialExpired) {
        return (
            <div
                role="status"
                className="bg-rose-600 dark:bg-rose-700 text-white border-b border-rose-700 dark:border-rose-800"
            >
                <div className="max-w-7xl mx-auto px-4 md:px-6 lg:px-8 py-3 flex items-center gap-3 flex-wrap">
                    <AlertCircle size={18} className="shrink-0" />
                    <span className="text-[13px] font-medium leading-snug">
                        Your free trial ended.
                        <span className="opacity-90 ml-1">
                            Your bot is currently offline. Pick a plan to bring it back live —
                            your knowledge base, settings and chat history are kept for 15 days.
                        </span>
                    </span>
                    <Link
                        to="/billing?tab=seats"
                        className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-white text-rose-700 text-[13px] font-semibold hover:bg-rose-50 transition-colors"
                    >
                        Reactivate now
                    </Link>
                    <button
                        type="button"
                        onClick={dismiss}
                        aria-label="Dismiss trial-ended banner"
                        className="shrink-0 -mr-1 p-1.5 rounded-md text-white/85 hover:text-white hover:bg-white/15 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                    >
                        <X size={16} />
                    </button>
                </div>
            </div>
        );
    }

    if (isTrialing) {
        // Derive the count from the trial_end timestamp via the same ceil
        // helper the Billing badge uses, so the two surfaces always agree.
        // Fall back to the backend's value only if the timestamp is absent.
        const remaining = trialDaysLeft(trialEndAt) ?? Number(daysRemaining ?? 0);
        const isUrgent = remaining <= 3;

        if (isUrgent) {
            // Amber urgency strip — countdown copy.
            const daysCopy =
                remaining <= 0
                    ? 'ends today'
                    : remaining === 1
                        ? 'ends tomorrow'
                        : `ends in ${remaining} days`;
            return (
                <div
                    role="status"
                    className="bg-amber-100 dark:bg-amber-500/15 text-amber-900 dark:text-amber-200 border-b border-amber-200 dark:border-amber-500/30"
                >
                    <div className="max-w-7xl mx-auto px-4 md:px-6 lg:px-8 py-2.5 flex items-center gap-3 flex-wrap">
                        <Clock size={16} className="shrink-0" />
                        <span className="text-[13px] font-medium leading-snug">
                            Heads up — your free trial {daysCopy}.
                            <span className="opacity-80 ml-1">
                                Pick a plan to avoid your bot going offline.
                            </span>
                        </span>
                        <Link
                            to="/billing?tab=seats"
                            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-600 hover:bg-amber-700 text-white text-[13px] font-semibold transition-colors"
                        >
                            Choose a plan
                        </Link>
                        <button
                            type="button"
                            onClick={dismiss}
                            aria-label="Dismiss trial-ending banner"
                            className="shrink-0 -mr-1 p-1.5 rounded-md text-amber-900/70 hover:text-amber-900 hover:bg-amber-200/60 dark:text-amber-200/70 dark:hover:text-amber-100 dark:hover:bg-amber-500/20 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
                        >
                            <X size={16} />
                        </button>
                    </div>
                </div>
            );
        }

        // Calm indigo chip — plenty of runway left.
        const daysCopy = remaining === 1 ? '1 day left' : `${remaining} days left`;
        return (
            <div
                role="status"
                className="bg-indigo-50 dark:bg-indigo-500/10 text-indigo-900 dark:text-indigo-200 border-b border-indigo-200 dark:border-indigo-500/20"
            >
                <div className="max-w-7xl mx-auto px-4 md:px-6 lg:px-8 py-2 flex items-center gap-2.5 flex-wrap">
                    <Sparkles size={15} className="shrink-0 text-indigo-600 dark:text-indigo-300" />
                    <span className="text-[13px] leading-snug">
                        <span className="font-semibold">{daysCopy}</span> in your free trial.
                        <span className="opacity-80 ml-1">
                            Convert any time to keep your bot, credits and chat history.
                        </span>
                    </span>
                    <Link
                        to="/billing?tab=seats"
                        className="ml-auto inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-[12.5px] font-semibold transition-colors"
                    >
                        Pick a plan
                    </Link>
                    <button
                        type="button"
                        onClick={dismiss}
                        aria-label="Dismiss trial banner"
                        className="shrink-0 -mr-1 p-1 rounded-md text-indigo-900/60 hover:text-indigo-900 hover:bg-indigo-100 dark:text-indigo-200/70 dark:hover:text-indigo-100 dark:hover:bg-indigo-500/15 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
                    >
                        <X size={14} />
                    </button>
                </div>
            </div>
        );
    }

    // Any other status (``canceled``, ``past_due``, ``paused``) is out of
    // scope for the trial banner — surface nothing rather than pretend we
    // know what to say.
    return null;
}
