import { CreditCard, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../ui';
import { creditsAreBinding, useTrialCreditBalance, useTrialState } from './useTrialState';

/**
 * The trial's permanent home in the rail, directly above Billing.
 *
 * It has **no close button**, and that is deliberate. The banner is the
 * interruption and can be dismissed; this is the standing fact about the
 * account, and an account on a clock should be able to see the clock without
 * hunting for it. Putting it above Billing means the answer and the place to
 * act on it are adjacent.
 *
 * Three states, in the order they matter to the customer:
 *
 * 1. **Counting days.** The default. Days left, and one way to act.
 * 2. **Counting credits.** When credits are running out faster than the clock,
 *    the number that will actually stop them is the credit balance, so that is
 *    the number shown. Telling someone they have nine days left when they have
 *    twenty credits is technically true and useless.
 * 3. **Bought already.** Green, no CTA. Someone who has paid must not be shown
 *    an Upgrade button; what they need is confirmation that the thing they
 *    bought is coming and when.
 */
export function TrialCard({ collapsed }: { collapsed: boolean }) {
  const trial = useTrialState();
  const trialing = trial != null && trial.status === 'trialing' && trial.paid_plan_starts_at == null;
  const balance = useTrialCreditBalance(trialing);

  if (!trial) return null;
  const bought = trial.paid_plan_starts_at != null;
  if (!bought && trial.status !== 'trialing') return null;

  const days = trial.days_remaining ?? 0;
  const dayWord = days === 1 ? 'day' : 'days';
  const planName = trial.paid_plan_name ?? 'Your plan';
  const showCredits =
    !bought && creditsAreBinding(balance, trial.credits_granted, trial.days_remaining);

  if (collapsed) {
    // Collapsed rail: the number alone, with the full sentence on hover.
    return (
      <Link
        data-testid="trial-card"
        to="/billing"
        // Same guard and same plural as the expanded branch. This one said
        // "null starts in 6 days" and "1 days left".
        title={bought ? `${planName} starts in ${days} ${dayWord}` : `${days} ${dayWord} left in your trial`}
        className={cn(
          'mx-auto flex h-8 w-8 items-center justify-center rounded-md text-xs font-medium',
          bought ? 'text-rail-success' : 'text-rail-accent',
        )}
      >
        {showCredits ? balance : days}
      </Link>
    );
  }

  return (
    <div
      data-testid="trial-card"
      className={cn(
        'mb-1 rounded-md px-2 py-2 text-xs',
        bought ? 'text-rail-success' : 'text-rail-accent',
      )}
    >
      <div className="flex items-center gap-1.5 font-medium">
        {bought ? (
          <Sparkles aria-hidden className="h-3.5 w-3.5" />
        ) : (
          <CreditCard aria-hidden className="h-3.5 w-3.5" />
        )}
        <span>
          {bought
            ? `${planName} starts in ${days} ${dayWord}`
            : showCredits
              ? `${balance} credits left in your trial`
              : `${days} ${dayWord} left in your trial`}
        </span>
      </div>
      {bought ? null : (
        <Link to="/billing" className="mt-1 inline-block font-medium underline-offset-2 hover:underline">
          Upgrade →
        </Link>
      )}
    </div>
  );
}
