import { type ReactElement } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';
import { type Feedback, type FeedbackTone } from '../hooks/useFeedback';

export interface FeedbackBannerProps {
  /** The message to show. `null` renders an empty (collapsed) live region. */
  feedback: Feedback | null;
  /** Omit to render the banner without a close button. */
  onDismiss?: () => void;
  className?: string;
}

const toneStyles: Record<FeedbackTone, { icon: LucideIcon; shell: string }> = {
  success: {
    icon: CheckCircle2,
    shell: 'border-[var(--ds-success)] bg-[var(--ds-success-soft)] text-[var(--ds-success)]',
  },
  error: {
    icon: AlertTriangle,
    shell: 'border-[var(--ds-danger)] bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]',
  },
  info: {
    icon: Info,
    shell: 'border-[var(--ds-info)] bg-[var(--ds-info-soft)] text-[var(--ds-info)]',
  },
};

/**
 * FeedbackBanner - the single inline confirmation strip for the app (mandate
 * shared component). Pairs with `useFeedback`, which owns the message and its
 * lifetime; this component only renders.
 *
 * The `aria-live` region stays mounted even while empty so screen readers
 * announce a message as it appears rather than only on the next focus move.
 * `empty:hidden` keeps the collapsed region from eating a gap in the parent's
 * vertical rhythm.
 */
export function FeedbackBanner({
  feedback,
  onDismiss,
  className,
}: FeedbackBannerProps): ReactElement {
  const style = feedback ? toneStyles[feedback.tone] : null;
  const Icon = style?.icon;

  return (
    <div aria-live="polite" className={cn('empty:hidden', className)}>
      {feedback && style && Icon && (
        <div
          className={cn(
            'flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-[13px]',
            style.shell,
          )}
        >
          <span className="flex min-w-0 items-start gap-2">
            <Icon size={16} aria-hidden="true" className="mt-px shrink-0" />
            <span className="min-w-0">{feedback.message}</span>
          </span>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss message"
              className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
            >
              <X size={15} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
