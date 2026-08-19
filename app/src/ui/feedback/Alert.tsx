import { type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { cn } from '../lib/cn';
import type { Tone } from '../primitives/Badge';

const TONE_STYLE: Record<Tone, string> = {
  neutral: 'border-border bg-surface-sunken text-text-primary',
  success: 'border-success/25 bg-success-tint text-success',
  warning: 'border-warning/25 bg-warning-tint text-warning',
  danger: 'border-danger/25 bg-danger-tint text-danger',
  accent: 'border-accent-200 bg-accent-50 text-accent-700',
  plan: 'border-plan/25 bg-plan-tint text-plan',
};

const TONE_ICON: Record<Tone, typeof Info> = {
  neutral: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  danger: AlertCircle,
  accent: Info,
  plan: Info,
};

export interface AlertProps {
  tone?: Tone;
  title?: string;
  children: ReactNode;
  /** A single control, e.g. Retry or Upgrade. Sits at the end of the row. */
  action?: ReactNode;
  /**
   * Whether to announce the message when it appears.
   *
   * `true` (the default) for the result of something the user just did — without
   * it, a screen-reader user has no way to know whether the action worked.
   * `false` for a message that was already on the page when it loaded, so the
   * page does not announce itself on arrival.
   */
  live?: boolean;
  icon?: ReactNode;
  className?: string;
}

/**
 * An inline message, anchored to the thing it is about.
 *
 * This is where anything the user must read to proceed belongs. A toast is for
 * confirming; an alert is for explaining — so a failed save, a plan limit, or a
 * degraded crawl stays on the page, beside the control that produced it, until
 * it is resolved.
 */
export function Alert({
  tone = 'neutral',
  title,
  children,
  action,
  live = true,
  icon,
  className,
}: AlertProps) {
  const Icon = TONE_ICON[tone];
  return (
    <div
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
      className={cn(
        'flex items-start gap-2.5 rounded-md border px-3 py-2.5',
        TONE_STYLE[tone],
        className,
      )}
    >
      <span className="mt-px shrink-0">
        {icon ?? <Icon aria-hidden className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1 text-xs leading-relaxed">
        {title ? <p className="text-base font-medium">{title}</p> : null}
        <div className={cn(title && 'mt-0.5')}>{children}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
