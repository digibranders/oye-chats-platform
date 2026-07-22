import { type ReactNode } from 'react';
import { type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';

export type ActivityTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

export interface ActivityItem {
  /** Unique key for the row. Falls back to the index when omitted. */
  id?: string;
  /** Leading glyph, tinted by `tone`. */
  icon: LucideIcon;
  /** What happened, e.g. "New lead captured". */
  title: ReactNode;
  /** Secondary detail line. */
  meta?: ReactNode;
  /** Pre-formatted relative time, e.g. "5m ago". */
  time: string;
  /**
   * Machine-readable timestamp for the `<time datetime>` attribute (an ISO 8601
   * string). Improves accessibility and lets assistive tech read the exact
   * moment behind the relative `time` label. Omit when only a relative string
   * is known.
   */
  dateTime?: string;
  /** Semantic color of the marker. Defaults to `neutral`. */
  tone?: ActivityTone;
}

export interface ActivityTimelineProps {
  items: ActivityItem[];
  className?: string;
}

const toneStyles: Record<ActivityTone, string> = {
  neutral: 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-muted)]',
  accent: 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]',
  success: 'bg-[var(--ds-success-soft)] text-[var(--ds-success)]',
  warning: 'bg-[var(--ds-warning-soft)] text-[var(--ds-warning)]',
  danger: 'bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]',
  info: 'bg-[var(--ds-info-soft)] text-[var(--ds-info)]',
};

/**
 * ActivityTimeline — a vertical feed of recent events (mandate shared
 * component). Each item has a tinted marker, a title, optional detail, and a
 * timestamp, connected by a rail.
 */
export function ActivityTimeline({ items, className }: ActivityTimelineProps) {
  return (
    <ol className={cn('flex flex-col', className)}>
      {items.map((item, index) => {
        const Icon = item.icon;
        const isLast = index === items.length - 1;
        return (
          <li key={item.id ?? index} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                  toneStyles[item.tone ?? 'neutral'],
                )}
              >
                <Icon size={15} aria-hidden="true" />
              </span>
              {!isLast && <span className="mt-1 w-px flex-1 bg-[var(--ds-border)]" />}
            </div>
            <div className={cn('min-w-0 flex-1', isLast ? 'pb-0' : 'pb-5')}>
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[13px] font-medium text-[var(--ds-text)]">{item.title}</p>
                <time
                  dateTime={item.dateTime}
                  className="shrink-0 text-[12px] text-[var(--ds-text-subtle)]"
                >
                  {item.time}
                </time>
              </div>
              {item.meta && (
                <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--ds-text-muted)]">
                  {item.meta}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
