import { type ReactElement, useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { Button } from '../../../design-system';
import { getPaymentRecovery } from '../../../services/api';
import { useBotContext } from '../../../context/BotContext';

/**
 * App-wide warning that a recurring payment failed and the workspace is inside
 * its dunning grace window.
 *
 * Mounted in the shell rather than on the Billing page on purpose: the customer
 * who most needs this is the one who never visits Billing. Email deliverability
 * is imperfect and the billing email may differ from the login email, so the
 * in-app signal is not a nice-to-have.
 *
 * Renders nothing in the healthy case, so the cost of it being always-mounted
 * is one cheap request per session.
 */

interface RecoveryState {
  past_due: boolean;
  /** Tri-state: true = link usable, false = settled negative, null = gateway unreachable. */
  recoverable: boolean | null;
  recovery_url: string | null;
  days_left: number | null;
  plan_name: string | null;
}

// Long: the underlying state only changes on a webhook or a daily cron, and a
// banner that hammers the API buys nothing.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

/** "today" / "in 1 day" / "in N days" — never "in 0 days". */
function deadlinePhrase(daysLeft: number | null): string {
  if (daysLeft === null) return 'soon';
  if (daysLeft <= 0) return 'today';
  return daysLeft === 1 ? 'in 1 day' : `in ${daysLeft} days`;
}

export function PastDueBanner(): ReactElement | null {
  const { selectedBot } = useBotContext();
  const botId = selectedBot?.id ?? null;
  const [state, setState] = useState<RecoveryState | null>(null);

  // No state is written synchronously in the effect body — the fetch resolves
  // first, and the `cancelled` flag stops a late response from updating an
  // unmounted banner. Matches the pattern in features/workspace/useBillingData.
  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      try {
        // Unvalidated wire shape — go through `unknown` rather than asserting a
        // JSON object is already this interface.
        const data = (await getPaymentRecovery(botId ?? undefined)) as unknown as RecoveryState;
        if (!cancelled) setState(data);
      } catch {
        // A failed probe must never surface as an error banner — the customer
        // would see a payment warning caused purely by our own request failing.
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

  if (!state?.past_due) return null;

  const plan = state.plan_name ? `${state.plan_name} ` : '';
  const canRecover = state.recoverable === true && Boolean(state.recovery_url);

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--ds-border)] bg-[var(--ds-danger-soft)] px-4 py-2.5 md:px-6"
    >
      <AlertTriangle size={16} aria-hidden="true" className="shrink-0 text-[var(--ds-danger)]" />
      <p className="min-w-0 flex-1 text-[13px] text-[var(--ds-text)]">
        <span className="font-medium">We couldn’t collect your {plan}payment.</span>{' '}
        Your AI agents stop responding to visitors {deadlinePhrase(state.days_left)}.
      </p>
      {canRecover ? (
        <Button
          size="sm"
          onClick={() => window.open(state.recovery_url as string, '_blank', 'noopener,noreferrer')}
        >
          Update payment method
          <ExternalLink size={14} aria-hidden="true" />
        </Button>
      ) : (
        // No usable link: either the mandate is past recovering, or we couldn't
        // reach the gateway. Both cases need a human, and rendering a dead
        // button is worse than sending them somewhere real.
        <a
          href="mailto:developer@oyechats.com?subject=Payment%20issue%20on%20my%20OyeChats%20account"
          className="text-[13px] font-medium text-[var(--ds-danger)] underline underline-offset-2"
        >
          Contact support
        </a>
      )}
    </div>
  );
}
