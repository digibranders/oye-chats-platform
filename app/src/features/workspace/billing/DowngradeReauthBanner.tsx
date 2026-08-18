import { type ReactElement, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Clock } from 'lucide-react';
import { Button } from '../../../design-system';
import { getCurrentSubscription } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';

/**
 * App-wide notice that a scheduled downgrade reached its cutover but still needs
 * the customer to authorize the new (lower) plan's payment mandate.
 *
 * During this window the backend holds the customer on a short-lived `past_due`
 * grace subscription on the TARGET plan, so `getCurrentSubscription` reports
 * `status: 'past_due'`. That status alone would render as a failed-payment
 * alarm (see PastDueBanner), which is the wrong story: nothing was charged and
 * nothing failed, the customer chose to downgrade and simply owes one final
 * authorization. The `reauth` block on the payload disambiguates the two, and
 * this banner tells the calmer, accurate story.
 *
 * Mounted in the shell next to PastDueBanner. The two are mutually exclusive:
 * `/payment-recovery` deliberately reports the grace row as not-past-due, so a
 * grace window never shows the red failed-payment banner as well.
 */

interface ReauthState {
  required: boolean;
  target_plan_name: string | null;
  grace_until: string | null;
  days_left: number | null;
}

// Long: the state only changes on the re-auth webhook or the daily expiry cron,
// so a banner that hammers the API buys nothing.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** "today" / "in 1 day" / "in N days", never "in 0 days". */
function deadlinePhrase(daysLeft: number | null): string {
  if (daysLeft === null) return 'soon';
  if (daysLeft <= 0) return 'today';
  return daysLeft === 1 ? 'in 1 day' : `in ${daysLeft} days`;
}

function readReauth(payload: unknown): ReauthState | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = (payload as { reauth?: unknown }).reauth;
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (record.required !== true) return null;
  return {
    required: true,
    target_plan_name: typeof record.target_plan_name === 'string' ? record.target_plan_name : null,
    grace_until: typeof record.grace_until === 'string' ? record.grace_until : null,
    days_left: typeof record.days_left === 'number' ? record.days_left : null,
  };
}

export function DowngradeReauthBanner(): ReactElement | null {
  const navigate = useNavigate();
  const { selectedBot } = useBotContext();
  const botId = selectedBot?.id ?? null;
  const [state, setState] = useState<ReauthState | null>(null);

  // Mirrors PastDueBanner: the fetch resolves first and the `cancelled` flag
  // stops a late response from updating an unmounted banner.
  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        const data = await getCurrentSubscription(botId ?? undefined);
        if (!cancelled) setState(readReauth(data));
      } catch {
        // A failed probe must never surface as a warning, the customer would
        // see a downgrade notice caused purely by our own request failing.
        if (!cancelled) setState(null);
      }
    };

    void load();
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [botId]);

  if (!state?.required) return null;

  const plan = state.target_plan_name ?? 'your new plan';

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--ds-border)] bg-[var(--ds-warning-soft)] px-4 py-2.5 md:px-6"
    >
      <Clock size={16} aria-hidden="true" className="shrink-0 text-[var(--ds-warning)]" />
      <p className="min-w-0 flex-1 text-[13px] text-[var(--ds-text)]">
        <span className="font-medium">Finish downgrading to {plan}.</span> Confirm the new payment
        authorization to keep {plan}. We’ve emailed you the link. Your workspace stays on {plan}{' '}
        until you drop to Free {deadlinePhrase(state.days_left)}.
      </p>
      <Button size="sm" variant="secondary" onClick={() => navigate('/workspace/billing')}>
        Review billing
      </Button>
    </div>
  );
}
