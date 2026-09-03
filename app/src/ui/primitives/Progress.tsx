import { type ReactNode } from 'react';
import { Meter as BaseMeter } from '@base-ui/react/meter';
import { Progress as BaseProgress } from '@base-ui/react/progress';
import { cn } from '../lib/cn';
import { formatNumber, formatPercent } from '../lib/formatters';
import { useTranslation } from '../../i18n/useTranslation';
import { t as translateNow } from '../../i18n/i18n';

export interface ProgressProps {
  /** 0–100. Pass `null` for an indeterminate bar. */
  value: number | null;
  /** Required: names what is progressing. */
  label: string;
  /**
   * Drop the label row, leaving 6px of bare bar.
   *
   * Off by default, and it used to be **on**: a required `label` prop that
   * rendered nothing unless you also found and unset a second prop. A call site
   * writing `<Progress value={40} label="Crawling acme.com" />` got a nameless
   * bar and no hint that the string it had been made to supply was invisible.
   * `Meter` — the sibling with the same prop — has always defaulted to showing
   * it, and two primitives that disagree about the same prop name is the drift
   * this directory exists to stop.
   *
   * Pass it for a bar that is chrome inside a row a heading already names.
   * A *set* of bars must agree on it, or the labelled one is 30px and the bare
   * one is 6 and they do not share a baseline.
   */
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
 * never implies a completion percentage it does not know — and under
 * `prefers-reduced-motion` it becomes a dimmed FULL track rather than a stopped
 * sliver, for the same reason. See `.console-indeterminate` in `tokens.css`.
 */
export function Progress({
  value,
  label,
  hideLabel = false,
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
      {/* A hidden label removes the row rather than reserving it: a bar asked
          to be bare is usually 6px of chrome inside a table row, and reserving
          24px there would be worse than the problem it solves. `Meter`, which
          is the one that appears in grids of peers, reserves instead. */}
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
            // `console-indeterminate` is a hook for the reduced-motion rule in
            // `tokens.css`, not a style: with the animation shortened to 0.01ms
            // the sliver simply stopped at a third of the track and read as a
            // determinate 33%.
            clamped == null &&
              'console-indeterminate w-1/3 animate-[indeterminate_1.4s_ease-in-out_infinite]',
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
  /**
   * Hides the meter's *name*, keeping the figure and the row's height.
   *
   * It used to set `invisible` on the whole row, which took the figure with it
   * — so a meter in a `SettingRow` whose label already names it could not show
   * "3 / 5" without printing its own name a second time beside it. The name is
   * the part the neighbouring heading duplicates; the figure never is.
   */
  hideLabel?: boolean;
  /** One clause under the bar — what the ceiling is, or what happens at it. */
  hint?: ReactNode;
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
  unlimitedNote: unlimitedNoteProp,
  tone: forcedTone,
  hideLabel = false,
  hint,
  size = 'md',
  className,
}: MeterProps) {
  const { t } = useTranslation();
  // `??` would also swallow an explicit `null`; a default parameter
  // only applies to `undefined`, and callers pass null to opt OUT.
  const unlimitedNote = unlimitedNoteProp === undefined ? (t('ds.noLimit') || 'No limit') : unlimitedNoteProp;
  const unlimited = limit < 0;
  /**
   * A zero ceiling is a real ceiling, and anything used against it is over it.
   *
   * This used to be `limit === 0 ? 0`, so "1 / 0 seats", a workspace left
   * holding an operator by a downgrade to a plan that allows none, painted a
   * calm empty bar, while "11 / 10" painted the danger state. The meter further
   * over its ceiling read as the safer of the two. Zero used against zero is a
   * different fact: nothing is over anything, so it stays neutral and empty.
   */
  const fraction = unlimited ? 0 : limit > 0 ? used / limit : used > 0 ? 1 : 0;
  const tone =
    forcedTone ?? (fraction >= 1 ? 'danger' : fraction >= 0.8 ? 'warning' : 'accent');

  const track = cn(
    'mt-1.5 block w-full overflow-hidden rounded-full bg-surface-active',
    size === 'sm' ? 'h-1' : 'h-1.5',
  );
  // `sr-only` on the label rather than `invisible` on the row: the name leaves
  // the flow and the figure keeps the row. It stays in the accessibility tree
  // because Base UI's `Meter.Label` is what names the meter at all.
  const nameClass = cn('text-xs text-text-secondary', hideLabel && 'sr-only');
  // With the name out of the flow, `justify-between` has one child left and
  // would push the figure to the leading edge.
  const figureClass = cn('text-xs font-medium text-text-primary', hideLabel && 'ms-auto');
  const note = hint ? <p className="mt-1 text-xs text-text-tertiary">{hint}</p> : null;

  if (unlimited) {
    // The unlimited branch used to render no track at all and a note underneath,
    // which made it 8px taller than a bounded meter — so one tile in the billing
    // page's usage grid sat proud of the rest and the card bottoms did not line
    // up. It keeps the track (empty, because nothing is being consumed against a
    // ceiling) and folds the note into the figure line.
    return (
      <div className={className}>
        <div className="flex items-baseline justify-between gap-2">
          <span className={nameClass}>{label}</span>
          {/* The note keeps its own element, and stays out of the `.figure`
              run: it is a sentence, and mono tabular figures are for numbers. */}
          <span className={cn('flex items-baseline gap-1', hideLabel && 'ms-auto')}>
            <span className="figure text-xs font-medium text-text-primary">
              {formatNumber(used)}
            </span>
            <span className="text-xs text-text-tertiary">{t('ds.used') || 'used ·'}</span>
            <span className="text-xs text-text-tertiary">{unlimitedNote}</span>
          </span>
        </div>
        <div className={track} />
        {note}
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
        translateNow('ds.ofLimitUsedPercent', {
          used: formatNumber(value),
          limit: formatNumber(limit),
          percent: formatPercent(fraction),
        }) || `${formatNumber(value)} of ${formatNumber(limit)} used, ${formatPercent(fraction)}`
      }
      className={className}
    >
      <div className="flex items-baseline justify-between gap-2">
        <BaseMeter.Label className={nameClass}>{label}</BaseMeter.Label>
        <span className={cn('figure', figureClass)}>
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
      {note}
    </BaseMeter.Root>
  );
}
