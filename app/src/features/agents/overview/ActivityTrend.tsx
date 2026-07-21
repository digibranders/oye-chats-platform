import { useMemo, type ReactElement } from 'react';
import { Activity } from 'lucide-react';
import { Card, EmptyState, cn } from '../../../design-system';
import { type ActivityPoint } from '../../../types/domain';

/** Formats an ISO/date string as a short "Mon 5" label; falls back to raw. */
function formatDayLabel(date: string): string {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export interface ActivityTrendProps {
  readonly points: readonly ActivityPoint[];
  readonly className?: string;
}

/**
 * ActivityTrend — a compact, dependency-free bar chart of daily message volume.
 * Bars are scaled to the busiest day. The whole chart is exposed to assistive
 * tech as a labelled figure summarising the total; individual bars carry a
 * native tooltip. Renders an empty state when there's no traffic yet.
 */
export function ActivityTrend({ points, className }: ActivityTrendProps): ReactElement {
  const { maxMessages, total } = useMemo(() => {
    let max = 0;
    let sum = 0;
    for (const point of points) {
      const value = point.messages ?? 0;
      if (value > max) max = value;
      sum += value;
    }
    return { maxMessages: max, total: sum };
  }, [points]);

  if (points.length === 0 || total === 0) {
    return (
      <Card className={cn('p-6', className)}>
        <EmptyState
          icon={Activity}
          title="No activity yet"
          description="Once visitors start chatting with your AI, daily message volume will appear here."
        />
      </Card>
    );
  }

  return (
    <Card className={cn('p-6', className)}>
      <figure
        aria-label={`Message activity: ${total.toLocaleString()} ${
          total === 1 ? 'message' : 'messages'
        } over the last ${points.length} ${points.length === 1 ? 'day' : 'days'}.`}
      >
        <div className="flex h-40 items-end gap-1.5" role="presentation">
          {points.map((point) => {
            const value = point.messages ?? 0;
            // Give any non-zero day a visible floor so it never disappears.
            const heightPct = maxMessages > 0 ? Math.max((value / maxMessages) * 100, value > 0 ? 6 : 0) : 0;
            const dayLabel = formatDayLabel(point.date);
            return (
              <div key={point.date} className="flex min-w-0 flex-1 flex-col items-center justify-end">
                <div
                  className="w-full rounded-t-sm bg-[var(--ds-accent)] transition-[height]"
                  style={{ height: `${heightPct}%` }}
                  title={`${dayLabel}: ${value.toLocaleString()} ${value === 1 ? 'message' : 'messages'}`}
                />
              </div>
            );
          })}
        </div>
        <figcaption className="mt-3 flex items-center justify-between text-[12px] text-[var(--ds-text-subtle)]">
          <span>{formatDayLabel(points[0].date)}</span>
          <span>{formatDayLabel(points[points.length - 1].date)}</span>
        </figcaption>
      </figure>
    </Card>
  );
}
