import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, X } from 'lucide-react';
import { getCurrentUser, resendVerification } from '../services/api';
import { getAuthItem, setAuthItem } from '../utils/authStorage';
import { getAuthState } from '../utils/auth';

/** sessionStorage flag — dismissal survives navigation but returns next session. */
const DISMISS_KEY = 'verify_email_banner_dismissed';

/**
 * Slim, dismissible "verify your email" nudge shown at the top of every
 * authenticated page for unverified CLIENT accounts.
 *
 * Context: organic email/password signups are no longer walled behind
 * ``/verify-email`` (see Login.jsx / Register.jsx). They enter the app
 * immediately and are nudged here instead. Verification is still enforced
 * server-side on billing/invite mutations (``require_verified_email``), so a
 * user who ignores the banner simply can't touch those surfaces until they
 * verify.
 *
 * Renders NOTHING when:
 *   - the account is verified,
 *   - the session is an operator (operators have no email-verification
 *     concept — ``getAuthState().isOperator``),
 *   - the banner was dismissed this session.
 *
 * Verification state is read optimistically from the persisted
 * ``admin_is_verified`` flag — hidden unless it is explicitly ``'false'`` so
 * verified/unknown sessions (e.g. a Google login that never wrote the flag)
 * never flash the banner — then confirmed against ``/auth/me`` on mount. A
 * failed ``/auth/me`` leaves the optimistic value in place: no crash, no
 * layout thrash, default hidden.
 */
export default function VerifyEmailBanner() {
    const isOperator = getAuthState().isOperator;

    // Show only when we positively know the account is unverified. ``null``
    // (unknown) and ``'true'`` both resolve to "verified" here; ``/auth/me``
    // can still flip a truly-unverified session below.
    const [isVerified, setIsVerified] = useState(
        () => getAuthItem('admin_is_verified') !== 'false',
    );
    const [dismissed, setDismissed] = useState(
        () => sessionStorage.getItem(DISMISS_KEY) === '1',
    );
    const [email, setEmail] = useState(() => getAuthItem('admin_pending_email') || '');
    const [resendState, setResendState] = useState('idle'); // idle | sending | sent | error

    useEffect(() => {
        // Operators have no verification state — skip the network call.
        if (isOperator) return undefined;
        let cancelled = false;
        (async () => {
            try {
                const me = await getCurrentUser();
                if (cancelled) return;
                const verified = Boolean(me?.is_verified);
                setIsVerified(verified);
                if (me?.email) setEmail((prev) => prev || me.email);
                // Keep the persisted flag fresh so later mounts don't flash.
                setAuthItem('admin_is_verified', verified ? 'true' : 'false');
            } catch {
                // Network/profile error — keep the optimistic flag-derived
                // value (default hidden unless the flag explicitly says false).
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [isOperator]);

    const handleResend = async () => {
        if (!email || resendState === 'sending') return;
        setResendState('sending');
        try {
            await resendVerification(email);
            setResendState('sent');
        } catch {
            setResendState('error');
        }
    };

    const handleDismiss = () => {
        sessionStorage.setItem(DISMISS_KEY, '1');
        setDismissed(true);
    };

    if (isOperator) return null;
    if (isVerified) return null;
    if (dismissed) return null;

    const verifyHref = email
        ? `/verify-email?email=${encodeURIComponent(email)}`
        : '/verify-email';

    const resendLabel =
        resendState === 'sending'
            ? 'Sending…'
            : resendState === 'sent'
                ? 'Code sent'
                : resendState === 'error'
                    ? 'Retry send'
                    : 'Resend';

    return (
        <div
            role="status"
            className="bg-primary-50 dark:bg-primary-500/10 text-primary-900 dark:text-primary-200 border-b border-primary-200 dark:border-primary-500/20"
        >
            <div className="max-w-7xl mx-auto px-4 md:px-6 lg:px-8 py-1.5 flex items-center gap-2.5">
                <Mail size={15} className="shrink-0 text-primary-600 dark:text-primary-300" />
                <span className="text-[13px] leading-snug flex-1 min-w-0">
                    <span className="font-semibold">Verify your email</span>
                    <span className="opacity-80 ml-1">
                        to unlock billing, invites, and payouts.
                    </span>
                </span>
                <button
                    type="button"
                    onClick={handleResend}
                    disabled={!email || resendState === 'sending' || resendState === 'sent'}
                    className="shrink-0 text-[12.5px] font-semibold text-primary-700 dark:text-primary-200 hover:text-primary-900 dark:hover:text-primary-100 disabled:opacity-60 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)] rounded"
                >
                    {resendLabel}
                </button>
                <Link
                    to={verifyHref}
                    className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1 rounded-md bg-primary-600 hover:bg-primary-700 text-white text-[12.5px] font-semibold transition-colors"
                >
                    Verify now
                </Link>
                <button
                    type="button"
                    onClick={handleDismiss}
                    aria-label="Dismiss verify-email banner"
                    className="shrink-0 -mr-1 p-1 rounded-md text-primary-900/60 hover:text-primary-900 hover:bg-primary-100 dark:text-primary-200/70 dark:hover:text-primary-100 dark:hover:bg-primary-500/15 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]"
                >
                    <X size={14} />
                </button>
            </div>
        </div>
    );
}
