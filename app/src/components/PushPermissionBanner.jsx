import { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, ShieldAlert, X } from 'lucide-react';

/**
 * PushPermissionBanner — refined floating card surfacing three actionable states:
 *
 *   1. ``default`` — they haven't been asked yet. Indigo nudge with a clear
 *      "Enable notifications" CTA. Fires the browser permission prompt.
 *   2. ``denied``  — they previously blocked. Browsers don't let us re-prompt
 *      from JS, so we show recovery instructions instead. Calm amber, not
 *      alarming red — this isn't an error, it's a config drift.
 *   3. ``granted`` but subscription error — soft amber + retry button.
 *
 * Hidden on:
 *   • Anonymous visitors / unsupported browsers
 *   • The happy path (granted && subscribed && no error)
 *   • Routes where it would clash with focused work (login, settings forms,
 *     full-screen modals) — caller decides; the layout still wraps it.
 *
 * Design rationale:
 *   • A floating bottom-right card (Linear / Stripe / Vercel pattern) feels
 *     like a settings nudge, not a system alert. Full-width banners read as
 *     "something is broken" and degrade the dashboard's premium feel.
 *   • One-time slide-in animation on mount — subtle motion to draw the eye
 *     without being distracting. No looping pulse.
 *   • Tight typography hierarchy: bold 13px title, muted 12.5px body, 12px
 *     button label — same scale as the rest of the admin app.
 *   • Dark mode tuned with translucent zinc surfaces + backdrop-blur for a
 *     glass-card feel that sits cleanly over any background.
 *
 * Dismissal is session-scoped — closing suppresses the card until the next
 * tab session, but a re-login or browser restart brings it back. Prevents
 * a user from accidentally locking themselves out of alerts permanently.
 */

const DISMISS_KEY = 'oye_push_banner_dismissed';

function readDismissed() {
    try {
        return sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
        return false;
    }
}

function markDismissed() {
    try {
        sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
        /* sessionStorage disabled — no-op */
    }
}

/**
 * Visual variant config keyed by state. Centralising it keeps each branch's
 * markup identical so the card looks consistent across all three states —
 * only the icon, copy, and accent change.
 */
const VARIANTS = {
    default: {
        Icon: Bell,
        iconBg: 'bg-indigo-100 dark:bg-indigo-500/15',
        iconColor: 'text-indigo-600 dark:text-indigo-300',
        accentRing: 'ring-indigo-200/60 dark:ring-indigo-400/15',
        buttonClass:
            'bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 text-white shadow-sm shadow-indigo-600/20',
        title: 'Stay reachable when this tab is closed',
        body: 'Turn on browser notifications and we will alert you the moment a visitor wants to chat — even when the dashboard tab is in the background.',
        actionLabel: 'Enable notifications',
    },
    denied: {
        Icon: BellOff,
        iconBg: 'bg-amber-100 dark:bg-amber-500/15',
        iconColor: 'text-amber-600 dark:text-amber-300',
        accentRing: 'ring-amber-200/60 dark:ring-amber-400/15',
        buttonClass:
            'bg-amber-600 hover:bg-amber-500 active:bg-amber-700 text-white shadow-sm shadow-amber-600/20',
        title: 'Notifications are blocked in your browser',
        // Two-sentence explanation with the recovery path concrete enough
        // that the user can complete it without bouncing to a help article.
        body: 'Click the lock icon next to the URL → Notifications → Allow, then click below. We will then ping you the instant a visitor needs help.',
        actionLabel: 'Re-check permission',
    },
    error: {
        Icon: ShieldAlert,
        iconBg: 'bg-amber-100 dark:bg-amber-500/15',
        iconColor: 'text-amber-600 dark:text-amber-300',
        accentRing: 'ring-amber-200/60 dark:ring-amber-400/15',
        buttonClass:
            'bg-amber-600 hover:bg-amber-500 active:bg-amber-700 text-white shadow-sm shadow-amber-600/20',
        title: 'Notifications could not be activated',
        body: null, // filled at render time with the actual error message
        actionLabel: 'Try again',
    },
};

export default function PushPermissionBanner({ push }) {
    const [dismissed, setDismissed] = useState(readDismissed);
    // One-time slide-in. We flip `mounted` to true on the first paint after
    // mount so the from/to CSS transition kicks in cleanly. No further state
    // changes after that — the animation runs once and stays put.
    const [mounted, setMounted] = useState(false);
    // Set when a permission request resolves to "denied" — browsers won't show
    // the prompt once blocked, so we surface the manual lock-icon path instead
    // of leaving the click feeling broken.
    const [stillBlocked, setStillBlocked] = useState(false);

    useEffect(() => {
        const id = requestAnimationFrame(() => setMounted(true));
        return () => cancelAnimationFrame(id);
    }, []);

    const onDismiss = useCallback(() => {
        markDismissed();
        setDismissed(true);
    }, []);

    // Whole-card activation: ask the browser for permission. On the `default`
    // state this shows the OS prompt; on `denied` the browser resolves to
    // "denied" without prompting (no JS re-prompt is allowed), so we flag
    // `stillBlocked` to keep the lock-icon recovery path visible. Must run from
    // this click handler — the user-gesture requirement is satisfied here.
    const onActivate = useCallback(async () => {
        if (!push?.request) return;
        const result = await push.request();
        setStillBlocked(result === 'denied');
    }, [push]);

    const onKeyActivate = useCallback(
        (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onActivate();
            }
        },
        [onActivate],
    );

    if (!push) return null;
    const { supported, isAuthenticated, permission, subscribed, error, initializing } = push;

    if (!isAuthenticated) return null;
    if (!supported) return null;
    // Skip rendering during the brief hook-init window. Without this gate, a
    // returning user (permission already "granted", subscription still present
    // at the browser layer) sees the indigo "Enable notifications" card flash
    // for ~10ms while the hook awaits ``getSubscription()`` + re-posts to the
    // backend — confusing UX since they're about to land back in the happy
    // path. The hook flips ``initializing`` to false the moment the first
    // subscribe attempt resolves, so the banner appears immediately for
    // genuinely-unsubscribed users and stays hidden for everyone else.
    if (initializing) return null;
    if (permission === 'granted' && subscribed && !error) return null;
    if (dismissed) return null;

    // Pick the variant. ``error`` only applies when permission is granted —
    // a "default" + error means we never got far enough to error, so it
    // falls back to the default invitation.
    let variantKey = 'default';
    if (permission === 'denied') variantKey = 'denied';
    else if (permission === 'granted' && error) variantKey = 'error';

    const variant = VARIANTS[variantKey];
    const body = variantKey === 'error' && error ? error : variant.body;

    return (
        <div
            role="status"
            aria-live="polite"
            className={`fixed z-40 bottom-5 right-5 left-5 sm:left-auto sm:bottom-6 sm:right-6 max-w-sm transition-all duration-300 ease-out ${
                mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
            }`}
        >
            <div
                className={`relative rounded-2xl bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md shadow-xl shadow-black/[0.07] dark:shadow-black/40 ring-1 ${variant.accentRing} p-4 sm:p-[18px]`}
            >
                <button
                    type="button"
                    onClick={onDismiss}
                    aria-label="Dismiss"
                    className="absolute top-3 right-3 p-1 rounded-md text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800/80 transition"
                >
                    <X size={14} strokeWidth={2.25} />
                </button>

                <div
                    role="button"
                    tabIndex={0}
                    onClick={onActivate}
                    onKeyDown={onKeyActivate}
                    aria-label={
                        permission === 'denied'
                            ? 'Re-check browser notification permission'
                            : 'Enable browser notifications'
                    }
                    className="group flex items-start gap-3 pr-6 w-full text-left cursor-pointer rounded-xl -m-1 p-1 transition hover:bg-zinc-50/70 dark:hover:bg-zinc-800/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/60 dark:focus-visible:ring-indigo-400/40"
                >
                    <div className={`shrink-0 w-9 h-9 rounded-full grid place-items-center ${variant.iconBg}`}>
                        <variant.Icon size={17} className={variant.iconColor} strokeWidth={2} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold leading-tight text-zinc-900 dark:text-zinc-50">
                            {variant.title}
                        </p>
                        {body ? (
                            <p className="mt-1 text-[12.5px] leading-relaxed text-zinc-600 dark:text-zinc-400">
                                {body}
                            </p>
                        ) : null}
                        {stillBlocked && permission === 'denied' ? (
                            <p className="mt-1.5 text-[12px] leading-relaxed font-medium text-amber-600 dark:text-amber-400">
                                Still blocked — set it to Allow via the lock icon, then click again (or reload).
                            </p>
                        ) : null}
                        {variant.actionLabel ? (
                            <span
                                className={`mt-3 inline-flex items-center justify-center h-8 px-3 rounded-lg text-[12.5px] font-medium tracking-tight transition ${variant.buttonClass} group-hover:brightness-110`}
                            >
                                {variant.actionLabel}
                            </span>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}
