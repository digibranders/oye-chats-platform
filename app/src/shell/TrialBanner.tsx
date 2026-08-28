import { useCallback, useState } from 'react';
import { X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from '../i18n/useTranslation';
import { useSessionClientId, useTrialState } from './useTrialState';

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
  const [dismissed, setDismissed] = useState(() => readDismissed(clientId));

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(dismissalKey(clientId), '1');
    } catch {
      // A dismissal that cannot be persisted still holds for this session.
    }
  }, [clientId]);

  if (!trial || trial.status !== 'trialing' || trial.paid_plan_starts_at) return null;

  const days = trial.days_remaining ?? 0;
  const urgent = days <= 3;
  if (dismissed && !urgent) return null;

  return (
    <div
      role="status"
      data-testid="trial-banner"
      className="flex items-center gap-3 border-b border-border bg-accent-tint px-page py-2 text-sm text-text"
    >
      <p className="min-w-0 flex-1">
        <strong className="font-medium">
          {days} {days === 1 ? 'day' : 'days'} left
        </strong>{' '}
        in your trial. Add a payment method to keep your chatbot running.
      </p>
      <Link to="/billing" className="shrink-0 font-medium underline-offset-2 hover:underline">
        {t('trial.upgrade') || 'Upgrade'}
      </Link>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('trial.dismiss') || 'Dismiss'}
        className="shrink-0 rounded-sm p-1 text-text-tertiary hover:text-text"
      >
        <X aria-hidden className="h-4 w-4" />
      </button>
    </div>
  );
}
