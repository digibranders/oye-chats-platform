import { cn } from '../lib/cn';

export interface DayDividerProps {
  /** Day label to show, e.g. "Today" / "Yesterday" / "Aug 14". */
  label: string;
  className?: string;
}

/**
 * DayDivider - a centered date marker inserted between conversation messages
 * when the calendar day changes (mandate shared component). Mirrors the pattern
 * used by Slack / Intercom / Linear so a multi-day transcript reads clearly.
 */
export function DayDivider({ label, className }: DayDividerProps) {
  if (!label) return null;
  return (
    <div className={cn('flex items-center gap-3 py-1', className)} role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-[var(--ds-border)]" />
      <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--ds-text-subtle)]">
        {label}
      </span>
      <span className="h-px flex-1 bg-[var(--ds-border)]" />
    </div>
  );
}
