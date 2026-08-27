import { Loader2, ShieldAlert } from 'lucide-react';
import { useTranslation } from '../i18n/useTranslation';

/**
 * Full-screen terminal notice for an impersonation session.
 *
 * Used in three places, all of which are dead ends by design:
 *   1. `main.jsx` while the hand-off token is being redeemed (`busy`).
 *   2. `main.jsx` when redemption fails - the app must NOT fall through to the
 *      login screen, because a super-admin landing on /login would be prompted
 *      for the customer's password.
 *   3. `ImpersonationBanner` when a live session expires, is revoked, or the
 *      super-admin hits Exit - rendered over the still-mounted app so no
 *      further interaction is possible.
 *
 * Deliberately dependency-free (no router, no providers, no data contexts): it
 * renders before and after the app tree exists.
 */
export default function ImpersonationNotice({ title, message, busy = false }) {
  const { t } = useTranslation();
    const Icon = busy ? Loader2 : ShieldAlert;

    return (
        <div
            role="alertdialog"
            aria-modal="true"
            aria-label={title}
            className="fixed inset-0 z-[200] flex items-center justify-center bg-[var(--bg)] p-6"
        >
            <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-8 text-center shadow-xl">
                <span
                    className={
                        busy
                            ? 'mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface-100 text-surface-500 dark:bg-surface-800 dark:text-surface-400'
                            : 'mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400'
                    }
                >
                    <Icon size={22} aria-hidden="true" className={busy ? 'animate-spin' : undefined} />
                </span>
                <h1 className="mt-5 text-lg font-semibold text-[var(--text)]">{title}</h1>
                <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">{message}</p>
                {!busy && (
                    <p className="mt-6 text-xs text-[var(--text-muted)]">
                        {t('app.closeThisTabAndIssue') || 'Close this tab and issue a new impersonation link from the super-admin console.'}
                    </p>
                )}
            </div>
        </div>
    );
}
