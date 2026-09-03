import { useCallback, useState } from 'react';
import { X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { isCountingDown, useSessionClientId, useTrialState } from './useTrialState';
import { useTranslation } from '../i18n/useTranslation';

/** Per-account, so a shared browser cannot leak one person's dismissal to another. */
function dismissalKey(clientId: number | null | undefined): string {
  return `trial_banner_dismissed:${clientId ?? 'unknown'}`;
}

function readDismissed(clientId: number | null | undefined): boolean {
  try {
    return localStorage.getItem(dismissalKey(clientId)) === '1';
  } catch {
    // Private windows and blocked site data throw on access, not just on write.
    return false;
  }
}

/**
 * The trial banner: an interruption, and therefore dismissible.
 *
 * The rail card is the standing fact; this is the nudge. Dismissal is honoured
 * per account and persisted, because a customer who has read it once should not
 * have to read it on every navigation.
 *
 * With one exception. **At three days or fewer it comes back regardless.** A
 * dismissal is "I have understood, stop telling me", and that is a reasonable
 * thing to mean on day four and an unreasonable thing to hold someone to on day
 * thirteen, when the consequence is their chatbot going quiet. Someone who has
 * bought already never sees it at all: the card tells them what they need.
 */
export function TrialBanner() {
  const { t } = useTranslation();
  const trial = useTrialState();
  const clientId = useSessionClientId();
  const [dismissedThisSession, setDismissedThisSession] = useState(false);
  // Read at render, not once at mount. The mount read ran before the session
  // query resolved, so it looked under `:unknown` while `dismiss` later wrote
  // under `:7`; read key and write key never matched and the banner came back
  // on every reload, which is the one thing dismissing has to prevent. A
  // localStorage read is synchronous and idempotent, so deriving it here is
  // safe and re-evaluates for free the moment the id arrives.
  const dismissed = dismissedThisSession || (clientId != null && readDismissed(clientId));

  const dismiss = useCallback(() => {
    setDismissedThisSession(true);
    try {
      localStorage.setItem(dismissalKey(clientId), '1');
    } catch {
      // A dismissal that cannot be persisted still holds for this session.
    }
  }, [clientId]);

  if (!isCountingDown(trial)) return null;
  // A null count is "nothing to say", not "zero days". Read as zero it rendered
  // "0 days left" AND tripped the urgency override, so it could never be
  // dismissed.
  if (trial?.days_remaining == null) return null;

  const days = trial.days_remaining;
  const urgent = days <= 3;
  if (dismissed && !urgent) return null;

  return (
    <div
      role="status"
      data-testid="trial-banner"
      // `px-gutter lg:px-gutter-lg` is the shared page gutter, so this stands on
      // the same left edge as the top bar above it and the breadcrumb below.
      // The first draft used `bg-accent-tint`, `px-page` and `text-text`, none
      // of which exist in tokens.css, so it rendered unstyled and flush.
      className="flex items-center gap-3 border-b border-border bg-accent-50 px-gutter py-2 text-sm text-text-primary lg:px-gutter-lg"
    >
      <p className="min-w-0 flex-1">
        <strong className="font-medium">
          {days === 1
            ? t('shell.oneDayLeft', { count: days }) || '1 day left'
            : t('shell.daysLeft', { count: days }) || `${days} days left`}
        </strong>{' '}
        {t('shell.inYourTrialAddA') || 'in your trial. Add a payment method to keep your chatbot running.'}
      </p>
      <Link to="/billing" className="shrink-0 font-medium underline-offset-2 hover:underline">
        {t('shell.upgrade') || 'Upgrade'}
      </Link>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('shell.dismiss') || 'Dismiss'}
        className="shrink-0 rounded-sm p-1 text-text-tertiary hover:text-text"
      >
        <X aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}
