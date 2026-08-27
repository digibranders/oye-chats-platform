import { type ReactElement } from 'react';
import { formatNumber } from '../../i18n/formatters';
import { Star } from 'lucide-react';
import { EmptyState } from '../../design-system';
import { type RatingsSummary } from './analytics-types';
import { useTranslation } from '../../i18n/useTranslation';

interface SatisfactionBreakdownProps {
  ratings: RatingsSummary;
}

const STARS: ReadonlyArray<1 | 2 | 3 | 4 | 5> = [5, 4, 3, 2, 1];

function barColor(star: number): string {
  if (star >= 4) return 'var(--ds-success)';
  if (star === 3) return 'var(--ds-warning)';
  return 'var(--ds-danger)';
}

/**
 * SatisfactionBreakdown - post-chat visitor ratings across every agent: a
 * headline average plus a 5→1 star distribution. Each row is labelled for
 * assistive tech (e.g. "5 stars, 62%").
 */
export function SatisfactionBreakdown({ ratings }: SatisfactionBreakdownProps): ReactElement {
  const { t } = useTranslation();
  if (ratings.total === 0) {
    return (
      <EmptyState
        icon={Star}
        title={t('analytics.noRatingsYet') || 'No ratings yet'}
        description={t('analytics.afterALiveChatVisitors') || 'After a live chat, visitors can rate their experience. Those ratings will appear here.'}
      />
    );
  }

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-bold tabular-nums text-[var(--ds-text)]">
          {ratings.average.toFixed(1)}
        </span>
        <span className="text-sm text-[var(--ds-text-subtle)]">/ 5</span>
        <span className="ml-1 text-[13px] text-[var(--ds-text-muted)]">
          {formatNumber(ratings.total)} {ratings.total === 1 ? 'rating' : 'ratings'}
        </span>
      </div>

      <ul className="mt-5 flex flex-col gap-2.5">
        {STARS.map((star) => {
          const count = ratings.distribution[star];
          const share = ratings.total > 0 ? Math.round((count / ratings.total) * 100) : 0;
          return (
            <li
              key={star}
              className="flex items-center gap-3"
              aria-label={`${star} ${star === 1 ? 'star' : 'stars'}, ${share} percent`}
            >
              <span
                className="flex w-9 shrink-0 items-center gap-0.5 text-[12px] font-medium text-[var(--ds-text-muted)]"
                aria-hidden="true"
              >
                {star}
                <Star size={11} className="fill-[var(--ds-warning)] text-[var(--ds-warning)]" />
              </span>
              <div className="h-3.5 flex-1 overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${share}%`, backgroundColor: barColor(star) }}
                />
              </div>
              <span className="w-9 shrink-0 text-right text-[12px] font-medium tabular-nums text-[var(--ds-text-muted)]">
                {share}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
