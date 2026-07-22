import { type ReactNode } from 'react';
import { type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';

export type InsightTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface InsightCardProps {
  /** One-line takeaway, e.g. "Your AI answered 94% of questions". */
  title: ReactNode;
  /** Supporting explanation or recommendation. */
  body: ReactNode;
  /** Optional leading glyph, tinted by `tone`. */
  icon?: LucideIcon;
  /** Semantic color of the insight. Defaults to `accent`. */
  tone?: InsightTone;
  /** Optional trailing action (usually a Button or link). */
  action?: ReactNode;
  className?: string;
}

const toneStyles: Record<InsightTone, { iconBg: string; iconText: string }> = {
  neutral: { iconBg: 'bg-[var(--ds-bg-sunken)]', iconText: 'text-[var(--ds-text-muted)]' },
  accent: { iconBg: 'bg-[var(--ds-accent-soft)]', iconText: 'text-[var(--ds-accent-text)]' },
  success: { iconBg: 'bg-[var(--ds-success-soft)]', iconText: 'text-[var(--ds-success)]' },
  warning: { iconBg: 'bg-[var(--ds-warning-soft)]', iconText: 'text-[var(--ds-warning)]' },
  danger: { iconBg: 'bg-[var(--ds-danger-soft)]', iconText: 'text-[var(--ds-danger)]' },
  info: { iconBg: 'bg-[var(--ds-info-soft)]', iconText: 'text-[var(--ds-info)]' },
};

/**
 * InsightCard — a recommendation or observation surfaced to the user (mandate
 * shared component). Leads with a tinted glyph, a bold takeaway, an
 * explanation, and an optional next-step action.
 */
export function InsightCard({
  title,
  body,
  icon: Icon,
  tone = 'accent',
  action,
  className,
}: InsightCardProps) {
  const style = toneStyles[tone];

  return (
    <div
      className={cn(
        'flex gap-4 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]',
        className,
      )}
    >
      {Icon && (
        <span
          className={cn(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
            style.iconBg,
            style.iconText,
          )}
        >
          <Icon size={18} aria-hidden="true" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h3 className="text-[14px] font-semibold text-[var(--ds-text)]">{title}</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">{body}</p>
        {action && <div className="mt-3 flex items-center gap-2">{action}</div>}
      </div>
    </div>
  );
}
