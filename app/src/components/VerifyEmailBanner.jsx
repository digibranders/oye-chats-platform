import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, X } from 'lucide-react';
import { getCurrentUser, resendVerification } from '../services/api';
import { getAuthItem, setAuthItem } from '../utils/authStorage';
import { getAuthState } from '../utils/auth';
import { useTranslation } from '../i18n/useTranslation';

/**
 * Slim, dismissible "verify your email" nudge shown at the top of every
 * authenticated page for unverified CLIENT accounts.
 *
 * Context: organic email/password signups are not walled behind
 * ``/verify-email`` (see Login.jsx / Register.jsx). They enter the app
 * immediately and are nudged here instead. Verification is still enforced
 * server-side on billing/invite mutations (``require_verified_email``), so a
 * user who ignores the banner simply can't touch those surfaces until they
 * verify. It also covers the account that becomes unverified LATER, via an
 * email change - that user is already inside the app, so a signup-time gate
 * would never catch them.
 *
 * Renders NOTHING when:
 *   - the account is verified,
 *   - the session is an operator (operators have no email-verification
 *     concept of their own - ``/auth/me`` mirrors the workspace OWNER's flag,
 *     and an operator cannot act on someone else's inbox),
 *   - the banner was dismissed in this page view.
 *
 * Dismissal is deliberately in-memory (React state, not web storage): an
 * unverified account is a state we want to keep surfacing, so the nudge
 * returns on the next reload or session. Dismissing only buys quiet for the
 * current page view - the shell keeps this mounted across route changes, so
 * that is enough to stop it nagging mid-task without ever letting the account
 * forget it is unverified.
 *
 * Verification state is read optimistically from the persisted
 * ``admin_is_verified`` flag - hidden unless it is explicitly ``'false'`` so
 * verified/unknown sessions (e.g. a Google login that never wrote the flag)
 * never flash the banner - then confirmed against ``/auth/me`` on mount. A
 * failed ``/auth/me`` leaves the optimistic value in place: no crash, no
 * layout thrash, default hidden.
 */
export default function VerifyEmailBanner() {
  const { t } = useTranslation();
    const isOperator = getAuthState().isOperator;

    // Show only when we positively know the account is unverified. ``null``
    // (unknown) and ``'true'`` both resolve to "verified" here; ``/auth/me``
    // can still flip a truly-unverified session below.
    const [isVerified, setIsVerified] = useState(
        () => getAuthItem('admin_is_verified') !== 'false',
    );
    const [dismissed, setDismissed] = useState(false);
    const [email, setEmail] = useState(() => getAuthItem('admin_pending_email') || '');
    const [resendState, setResendState] = useState('idle'); // idle | sending | sent | error

    useEffect(() => {
        // Operators have no verification state - skip the network call.
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
                // Network/profile error - keep the optimistic flag-derived
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

    const handleDismiss = () => setDismissed(true);

    if (isOperator) return null;
    if (isVerified) return null;
    if (dismissed) return null;

    const verifyHref = email
        ? `/verify-email?email=${encodeURIComponent(email)}`
        : '/verify-email';

    const resendLabel =
        resendState === 'sending'
            ? t('app.sending') || 'Sending…'
            : resendState === 'sent'
                ? t('app.codeSent') || 'Code sent'
                : resendState === 'error'
                    ? t('app.retrySend') || 'Retry send'
                    : t('app.resend') || 'Resend';

    return (
        // Design-system tokens, not the legacy `primary-*` scale: this sits
        // directly beside PastDueBanner / DowngradeReauthBanner in the shell,
        // and a second palette there reads as a bug.
        <div
            role="status"
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--ds-border)] bg-[var(--ds-warning-soft)] px-4 py-2.5 md:px-6"
        >
            <Mail size={16} aria-hidden="true" className="shrink-0 text-[var(--ds-warning)]" />
            <p className="min-w-0 flex-1 text-[13px] text-[var(--ds-text)]">
                <span className="font-medium">{t('app.verifyYourEmail') || 'Verify your email'}</span>
                <span className="text-[var(--ds-text-muted)]">
                    {' '}
                    {t('app.toUnlockCheckoutPlanChanges') || 'to unlock checkout, plan changes, and team invites.'}
                </span>
            </p>
            <button
                type="button"
                onClick={handleResend}
                disabled={!email || resendState === 'sending' || resendState === 'sent'}
                className="shrink-0 rounded text-[13px] font-medium text-[var(--ds-text-muted)] underline-offset-2 transition-colors hover:text-[var(--ds-text)] hover:underline disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:no-underline"
            >
                {resendLabel}
            </button>
            <Link
                to={verifyHref}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-[var(--ds-accent)] px-3 py-1.5 text-[13px] font-medium text-[var(--ds-accent-fg)] transition-opacity hover:opacity-90"
            >
                {t('app.verifyNow') || 'Verify now'}
            </Link>
            <button
                type="button"
                onClick={handleDismiss}
                aria-label={t('app.dismissVerifyEmailBanner') || 'Dismiss verify-email banner'}
                className="shrink-0 rounded-md p-1 text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-bg-subtle)] hover:text-[var(--ds-text)]"
            >
                <X size={14} aria-hidden="true" />
            </button>
        </div>
    );
}
