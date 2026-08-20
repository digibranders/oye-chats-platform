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

/**
 * `plan` is a Meter tone only. It was in one shared map typed wider than
 * `ProgressProps['tone']`, which meant a brass progress bar was one prop-type
 * edit away with no design review — and brass is reserved for plan,
 * entitlement and upgrade surfaces.
 */
const PROGRESS_TONE = {
  accent: 'bg-accent-500',
  success: 'bg-success-fill',
  warning: 'bg-warning-fill',
  danger: 'bg-danger-fill',
} as const;

const METER_TONE = { ...PROGRESS_TONE, plan: 'bg-plan' } as const;

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
      {/* A hidden label removes the row rather than reserving it, because
          `hideLabel` defaults to true and this bar is most often 6px of chrome
          inside a table row — reserving 24px there would be worse than the
          problem it solves. The consequence: a *set* of bars must agree on
          `hideLabel`, or the labelled one is 30px and the bare one is 6 and
          they do not share a baseline. `Meter`, which is the one that appears
          in grids of peers, reserves instead. */}
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
            PROGRESS_TONE[tone],
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
  /**
   * What to say when the limit is unlimited.
   *
   * A prop, not a fixed string. It used to read "Unlimited on your plan", which
   * is customer-facing copy baked into a shared primitive — and it is simply
   * false in the platform console, where a super-admin is looking at somebody
   * else's account.
   */
  unlimitedNote?: string;
  /**
   * Force the fill's tone instead of letting it escalate with the fraction.
   *
   * Pass `plan` when the ceiling is a **price rather than a fault** — a full
   * knowledge allowance on a plan that includes that much knowledge is not a
   * problem, and painting it red next to correctly brass-toned copy tells the
   * customer their account is broken when it is working exactly as sold.
   */
  tone?: 'plan';
  /** Hides the label row, keeping its height so a grid of meters stays level. */
  hideLabel?: boolean;
  size?: 'sm' | 'md';
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
export function Meter({
  label,
  used,
  limit,
  unit,
  unlimitedNote = 'No limit',
  tone: forcedTone,
  hideLabel = false,
  size = 'md',
  className,
}: MeterProps) {
  const unlimited = limit < 0;
  const fraction = unlimited || limit === 0 ? 0 : used / limit;
  const tone =
    forcedTone ?? (fraction >= 1 ? 'danger' : fraction >= 0.8 ? 'warning' : 'accent');

  const track = cn(
    'mt-1.5 block w-full overflow-hidden rounded-full bg-surface-active',
    size === 'sm' ? 'h-1' : 'h-1.5',
  );

  if (unlimited) {
    // The unlimited branch used to render no track at all and a note underneath,
    // which made it 8px taller than a bounded meter — so one tile in the billing
    // page's usage grid sat proud of the rest and the card bottoms did not line
    // up. It keeps the track (empty, because nothing is being consumed against a
    // ceiling) and folds the note into the figure line.
    return (
      <div className={className}>
        <div
          aria-hidden={hideLabel || undefined}
          className={cn('flex items-baseline justify-between gap-2', hideLabel && 'invisible')}
        >
          <span className="text-xs text-text-secondary">{label}</span>
          {/* The note keeps its own element, and stays out of the `.figure`
              run: it is a sentence, and mono tabular figures are for numbers. */}
          <span className="flex items-baseline gap-1">
            <span className="figure text-xs font-medium text-text-primary">
              {formatNumber(used)}
            </span>
            <span className="text-xs text-text-tertiary">used ·</span>
            <span className="text-xs text-text-tertiary">{unlimitedNote}</span>
          </span>
        </div>
        <div className={track} />
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
      <div
        aria-hidden={hideLabel || undefined}
        className={cn('flex items-baseline justify-between gap-2', hideLabel && 'invisible')}
      >
        <BaseMeter.Label className="text-xs text-text-secondary">{label}</BaseMeter.Label>
        <span className="figure text-xs font-medium text-text-primary">
          {formatNumber(used)}
          <span className="text-text-tertiary"> / {formatNumber(limit)}</span>
          {unit ? <span className="text-text-tertiary"> {unit}</span> : null}
        </span>
      </div>
      <BaseMeter.Track className={track}>
        <BaseMeter.Indicator
          className={cn(
            'block h-full rounded-full transition-[width] duration-[var(--dur-slow)]',
            METER_TONE[tone],
          )}
        />
      </BaseMeter.Track>
    </BaseMeter.Root>
  );
}
