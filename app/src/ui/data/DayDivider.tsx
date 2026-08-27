import { cn } from '../lib/cn';

export interface DayDividerProps {
  /** "Today", "Yesterday", "14 Aug" — already formatted and localized. */
  label: string;
  className?: string;
}

/**
 * The calendar day changed, between one message and the next.
 *
 * A widget session survives in the visitor's `localStorage`, so one
 * conversation routinely spans several days — and every bubble carries only a
 * clock time. Without this, a message sent last Tuesday at 14:32 is
 * indistinguishable from one sent an hour ago, which is the difference between
 * a lead worth calling and one who has already bought elsewhere.
 *
 * A `role="separator"` with an accessible name rather than a decorative rule:
 * the label is the whole content, so hiding it from assistive tech would leave
 * a screen-reader user reading a multi-day transcript with no day boundaries
 * at all.
 */
export function DayDivider({ label, className }: DayDividerProps) {
  if (!label) return null;
  return (
    <div role="separator" aria-label={label} className={cn('flex items-center gap-3 py-1', className)}>
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="text-2xs font-medium uppercase tracking-wide text-text-tertiary">{label}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
