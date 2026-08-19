import * as RadixProgress from '@radix-ui/react-progress';
import { cn } from '../lib/cn';
import { formatNumber, formatPercent } from '../lib/formatters';

export interface ProgressProps {
  /** 0–100. Pass `null` for an indeterminate bar. */
  value: number | null;
  /** Required: names what is progressing. */
  label: string;
  hideLabel?: boolean;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
  size?: 'sm' | 'md';
  className?: string;
}

const TONE: Record<NonNullable<ProgressProps['tone']>, string> = {
  accent: 'bg-accent-500',
  success: 'bg-success-fill',
  warning: 'bg-warning-fill',
  danger: 'bg-danger-fill',
};

/** A determinate or indeterminate bar. Progress is the accent's second job. */
export function Progress({
  value,
  label,
  hideLabel = true,
  tone = 'accent',
  size = 'md',
  className,
}: ProgressProps) {
  const clamped = value == null ? null : Math.min(100, Math.max(0, value));
  return (
    <div className={cn('w-full', className)}>
      {!hideLabel ? (
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-xs text-text-secondary">{label}</span>
          {clamped != null ? (
            <span className="tnum text-xs font-medium text-text-primary">{Math.round(clamped)}%</span>
          ) : null}
        </div>
      ) : null}
      <RadixProgress.Root
        value={clamped}
        aria-label={hideLabel ? label : undefined}
        className={cn(
          'relative w-full overflow-hidden rounded-full bg-surface-active',
          size === 'sm' ? 'h-1' : 'h-1.5',
        )}
      >
        <RadixProgress.Indicator
          className={cn(
            'h-full rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-console)]',
            TONE[tone],
            // Indeterminate: a travelling sliver rather than a full bar, so it
            // never implies a completion percentage it does not know.
            clamped == null && 'w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite]',
          )}
          style={clamped != null ? { width: `${clamped}%` } : undefined}
        />
      </RadixProgress.Root>
    </div>
  );
}

export interface MeterProps {
  label: string;
  used: number;
  /** `-1` means unlimited — rendered as a figure, never as a full bar. */
  limit: number;
  unit?: string;
  className?: string;
}

/**
 * A quota: how much of an allowance is spent.
 *
 * A `meter`, not a `progressbar`. A progress bar reports how far a task has got;
 * a meter reports a level within a known range, which is what a plan limit is —
 * and only a meter carries the "this is nearly full" meaning that makes the
 * warning tone legible to assistive tech.
 *
 * Tone escalates at 80% and 100%, so a quota tells the user it is a problem
 * before it becomes one.
 */
export function Meter({ label, used, limit, unit, className }: MeterProps) {
  const unlimited = limit < 0;
  const fraction = unlimited || limit === 0 ? 0 : used / limit;
  const tone = fraction >= 1 ? 'danger' : fraction >= 0.8 ? 'warning' : 'accent';

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-text-secondary">{label}</span>
        <span className="tnum text-xs font-medium text-text-primary">
          {formatNumber(used)}
          {unlimited ? (
            <span className="text-text-tertiary"> used</span>
          ) : (
            <>
              <span className="text-text-tertiary"> / {formatNumber(limit)}</span>
              {unit ? <span className="text-text-tertiary"> {unit}</span> : null}
            </>
          )}
        </span>
      </div>
      {unlimited ? (
        <p className="mt-1 text-2xs text-text-tertiary">Unlimited on your plan</p>
      ) : (
        <div
          role="meter"
          aria-label={label}
          aria-valuenow={used}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuetext={`${formatNumber(used)} of ${formatNumber(limit)} used, ${formatPercent(fraction)}`}
          className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-active"
        >
          <div
            className={cn('h-full rounded-full transition-[width] duration-[var(--dur-slow)]', TONE[tone])}
            style={{ width: `${Math.min(100, fraction * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}
