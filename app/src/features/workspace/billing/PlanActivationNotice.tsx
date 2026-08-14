/**
 * PlanActivationNotice - the persistent state a customer sees between paying
 * and their plan going live.
 *
 * It is deliberately not a toast and not a transient flash: for the whole
 * activation window the screen has to say, in one place that does not move,
 * "your money arrived, we are working on it, do not pay again". The absence of
 * exactly this was how a customer came to hold two mandates 44 seconds apart.
 *
 * Neither state offers a retry. `pending` has no action at all; `timeout`
 * offers support. A button that reads like "try again" here is the second
 * charge.
 */
import { type ReactElement } from 'react';
import { Clock, Loader2 } from 'lucide-react';
import { SALES_EMAIL } from '../billingModel';
import type { PlanActivationStatus } from './usePlanActivation';

export interface PlanActivationNoticeProps {
  status: PlanActivationStatus;
  /** Plan being activated, for the copy. */
  planName: string | null;
  className?: string;
}

export function PlanActivationNotice({
  status,
  planName,
  className,
}: PlanActivationNoticeProps): ReactElement | null {
  if (status !== 'pending' && status !== 'timeout') return null;

  const plan = planName ?? 'new';

  if (status === 'pending') {
    return (
      <div
        role="status"
        aria-live="polite"
        className={`flex items-start gap-3 rounded-xl border border-[var(--ds-info)] bg-[var(--ds-info-soft)] px-4 py-3 text-[13px] text-[var(--ds-text)] ${className ?? ''}`}
      >
        <Loader2
          size={16}
          aria-hidden="true"
          className="mt-0.5 shrink-0 animate-spin text-[var(--ds-info)]"
        />
        <div className="min-w-0">
          <p className="font-semibold">Activating your {plan} plan…</p>
          <p className="mt-0.5 text-[var(--ds-text-muted)]">
            Your payment went through. Activation usually takes under a minute and this page
            updates on its own - please don’t pay again.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex items-start gap-3 rounded-xl border border-[var(--ds-warning)] bg-[var(--ds-warning-soft)] px-4 py-3 text-[13px] text-[var(--ds-text)] ${className ?? ''}`}
    >
      <Clock size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-warning)]" />
      <div className="min-w-0">
        <p className="font-semibold">
          We’ve received your {plan} payment - activation is taking longer than usual.
        </p>
        <p className="mt-0.5 text-[var(--ds-text-muted)]">
          Nothing is wrong with your payment and you have not been charged twice. There’s nothing
          to retry here - email{' '}
          <a
            href={`mailto:${SALES_EMAIL}?subject=${encodeURIComponent('Plan activation is pending')}`}
            className="font-medium text-[var(--ds-text)] underline underline-offset-2"
          >
            {SALES_EMAIL}
          </a>{' '}
          and we’ll finish activating your plan.
        </p>
      </div>
    </div>
  );
}
