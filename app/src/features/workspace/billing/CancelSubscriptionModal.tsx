import { useEffect, useState, type ReactElement } from 'react';
import { AlertCircle, CalendarClock, Check, Loader2 } from 'lucide-react';
import { Button, Modal, Textarea } from '../../../design-system';
import { cancelSubscription } from '../../../services/api';
import { formatDate } from '../billingModel';

export interface CancelSubscriptionModalProps {
  open: boolean;
  onClose: () => void;
  /** The plan being cancelled - named in the copy so the customer knows exactly what ends. */
  planName: string;
  /** End of the current billing period (ISO) - access is retained until this date. */
  periodEnd: string | null;
  /** Selected agent id: cancels that agent's subscription (null = account subscription). */
  botId?: number | null;
  /** Fired with a status message after a successful cancellation. */
  onSuccess: (message: string) => void;
}

/**
 * CancelSubscriptionModal - the explicit, reversible cancel flow. Cancellation
 * is cancel-at-period-end: the backend records the intent and leaves the payment
 * mandate alone until a couple of days before the period closes, so the plan
 * stays fully active until then AND reactivating is a free, instant flag flip
 * rather than a fresh checkout. This dialog states that plainly, spells out what
 * happens after, keeps the tone calm rather than alarming, and captures an
 * optional reason. On success the Billing page surfaces a Reactivate banner
 * until the period ends.
 */
export function CancelSubscriptionModal({
  open,
  onClose,
  planName,
  periodEnd,
  botId = null,
  onSuccess,
}: CancelSubscriptionModalProps): ReactElement | null {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Reset transient state each time the dialog opens so a prior reason/error
  // can't flash on reopen.
  useEffect(() => {
    if (open) {
      setReason('');
      setError('');
      setSubmitting(false);
    }
  }, [open]);

  const endLabel = periodEnd ? formatDate(periodEnd) : 'the end of your billing period';

  async function handleCancel(): Promise<void> {
    setSubmitting(true);
    setError('');
    try {
      const res = (await cancelSubscription(reason.trim() || null, botId)) as Record<string, unknown>;
      onSuccess(
        (res?.message as string) ||
          `Your ${planName} plan stays active until ${endLabel}, then cancels. You can reactivate anytime before then.`,
      );
      onClose();
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : 'We couldn’t cancel your subscription. Please try again, or contact support.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      dismissible={!submitting}
      size="sm"
      title="Cancel subscription"
      description="You’ll keep everything until your billing period ends."
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Keep my plan
          </Button>
          <Button variant="danger" onClick={() => void handleCancel()} disabled={submitting}>
            {submitting && <Loader2 size={16} className="animate-spin" aria-hidden="true" />}
            Cancel subscription
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* The reassurance that leads: access is retained to period end. */}
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-subtle)] px-4 py-3">
          <CalendarClock size={17} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-accent-text)]" />
          <p className="text-[13px] leading-relaxed text-[var(--ds-text)]">
            Your <span className="font-semibold">{planName}</span> plan stays active until{' '}
            <span className="font-semibold">{endLabel}</span>. You won’t be billed again.
          </p>
        </div>

        {/* What happens next - honest, specific, no surprises. */}
        <ul className="space-y-2 text-[13px] text-[var(--ds-text-muted)]">
          {[
            `Full access to ${planName} continues until ${endLabel}.`,
            'After that, your agents stop replying and go offline.',
            'Any top-up credits you’ve bought stay valid - they never expire.',
            `Changed your mind? Reactivate anytime before ${endLabel} - it's instant, and there's nothing to pay.`,
          ].map((item) => (
            <li key={item} className="flex items-start gap-2.5">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
                <Check size={12} aria-hidden="true" />
              </span>
              {item}
            </li>
          ))}
        </ul>

        {/* Optional reason - helps the business, never blocks the cancel. */}
        <div>
          <label
            htmlFor="cancel-reason"
            className="mb-1.5 block text-[12px] font-medium text-[var(--ds-text-muted)]"
          >
            Anything we could’ve done better? <span className="text-[var(--ds-text-subtle)]">(optional)</span>
          </label>
          <Textarea
            id="cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Your feedback helps us improve."
            disabled={submitting}
          />
        </div>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] px-3 py-2.5 text-[13px] text-[var(--ds-text)]"
          >
            <AlertCircle size={16} aria-hidden="true" className="mt-0.5 shrink-0 text-[var(--ds-danger)]" />
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}
