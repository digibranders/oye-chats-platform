import { useMemo, type ReactElement } from 'react';
import { Activity } from 'lucide-react';
import { Card, EmptyState, cn } from '../../../design-system';
import { type ActivityPoint } from '../../../types/domain';
import { useTranslation } from '../../../i18n/useTranslation';
import { formatNumber } from '../../../i18n/formatters';

/**
 * Formats a backend day string as a short "Mon 5" label; falls back to raw.
 *
 * The backend groups by calendar day and sends date-only strings ("2026-07-20").
 * `new Date("2026-07-20")` parses as UTC midnight, so formatting in a viewer's
 * local zone west of UTC would shift the label back a day. Parse the Y-M-D parts
 * as a LOCAL date to keep the label on the day the backend actually grouped by.
 */
function formatDayLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  const parsed = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(date);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export interface ActivityTrendProps {
  readonly points: readonly ActivityPoint[];
  readonly className?: string;
}

/**
 * ActivityTrend - a compact, dependency-free bar chart of daily message volume.
 * Bars are scaled to the busiest day. The whole chart is exposed to assistive
 * tech as a labelled figure summarising the total; individual bars carry a
 * native tooltip. Renders an empty state when there's no traffic yet.
 */
export function ActivityTrend({ points, className }: ActivityTrendProps): ReactElement {
  const { t } = useTranslation();
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
          title={t('agents.noActivityYet') || 'No activity yet'}
          description={t('agents.onceVisitorsStartChattingWith') || 'Once visitors start chatting with your AI, daily message volume will appear here.'}
        />
      </Card>
    );
  }

  const messageLabel =
    t(total === 1 ? 'agents.messageOne' : 'agents.messageMany', { count: formatNumber(total) }) ||
    `${formatNumber(total)} message${total === 1 ? '' : 's'}`;
  const dayLabel =
    t(points.length === 1 ? 'agents.dayOne' : 'agents.dayMany', {
      count: formatNumber(points.length),
    }) || `${formatNumber(points.length)} day${points.length === 1 ? '' : 's'}`;

  return (
    <Card className={cn('p-6', className)}>
      <figure
        aria-label={
          t('agents.activityChartSummary', { messages: messageLabel, days: dayLabel }) ||
          `Message activity: ${messageLabel} over the last ${dayLabel}.`
        }
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
        {/* Accessible equivalent of the visual bars: the per-day values the
            native bar tooltips carry, surfaced to keyboard and screen-reader
            users who can't hover. */}
        <table className="sr-only">
          <caption>{t('agents.dailyMessageVolume') || 'Daily message volume'}</caption>
          <thead>
            <tr>
              <th scope="col">{t('agents.day') || 'Day'}</th>
              <th scope="col">{t('agents.messages') || 'Messages'}</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.date}>
                <td>{formatDayLabel(point.date)}</td>
                <td>{(point.messages ?? 0).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figure>
    </Card>
  );
}
