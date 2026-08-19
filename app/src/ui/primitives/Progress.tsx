import { Meter as BaseMeter } from '@base-ui/react/meter';
import { Progress as BaseProgress } from '@base-ui/react/progress';
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

/**
 * A task in flight: a crawl, a training run, an upload.
 *
 * The indeterminate form is a travelling sliver rather than a filled bar, so it
 * never implies a completion percentage it does not know.
 */
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
    // The label goes on the Root, which is where Base UI puts
    // `role="progressbar"`. An earlier version put it on the Track — a plain
    // `div` with no role — so an indeterminate bar announced as an unnamed
    // progressbar and the one thing it was communicating went unsaid.
    <BaseProgress.Root
      value={clamped}
      aria-label={hideLabel ? label : undefined}
      className={cn('w-full', className)}
    >
      {!hideLabel ? (
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <BaseProgress.Label className="text-xs text-text-secondary">{label}</BaseProgress.Label>
          {clamped != null ? (
            <BaseProgress.Value className="figure text-xs font-medium text-text-primary" />
          ) : null}
        </div>
      ) : null}
      <BaseProgress.Track
        className={cn(
          'relative block w-full overflow-hidden rounded-full bg-surface-active',
          size === 'sm' ? 'h-1' : 'h-1.5',
        )}
      >
        <BaseProgress.Indicator
          className={cn(
            'block h-full rounded-full transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-console)]',
            TONE[tone],
            clamped == null && 'w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite]',
          )}
        />
      </BaseProgress.Track>
    </BaseProgress.Root>
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
 * The tone escalates at 80% and again at 100%, so a quota says it is becoming a
 * problem before it is one.
 */
export function Meter({ label, used, limit, unit, className }: MeterProps) {
  const unlimited = limit < 0;
  const fraction = unlimited || limit === 0 ? 0 : used / limit;
  const tone = fraction >= 1 ? 'danger' : fraction >= 0.8 ? 'warning' : 'accent';

  if (unlimited) {
    return (
      <div className={className}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-text-secondary">{label}</span>
          <span className="figure text-xs font-medium text-text-primary">
            {formatNumber(used)} <span className="text-text-tertiary">used</span>
          </span>
        </div>
        <p className="mt-1 text-2xs text-text-tertiary">Unlimited on your plan</p>
      </div>
    );
  }

  return (
    <BaseMeter.Root
      value={used}
      min={0}
      max={limit}
      // Spelled out, because "412 / 500" read aloud as two numbers is not the
      // fact the user needs; "82% used" is.
      getAriaValueText={(_formatted, value) =>
        `${formatNumber(value)} of ${formatNumber(limit)} used, ${formatPercent(fraction)}`
      }
      className={className}
    >
      <div className="flex items-baseline justify-between gap-2">
        <BaseMeter.Label className="text-xs text-text-secondary">{label}</BaseMeter.Label>
        <span className="figure text-xs font-medium text-text-primary">
          {formatNumber(used)}
          <span className="text-text-tertiary"> / {formatNumber(limit)}</span>
          {unit ? <span className="text-text-tertiary"> {unit}</span> : null}
        </span>
      </div>
      <BaseMeter.Track className="mt-1.5 block h-1.5 w-full overflow-hidden rounded-full bg-surface-active">
        <BaseMeter.Indicator
          className={cn(
            'block h-full rounded-full transition-[width] duration-[var(--dur-slow)]',
            TONE[tone],
          )}
        />
      </BaseMeter.Track>
    </BaseMeter.Root>
  );
}
