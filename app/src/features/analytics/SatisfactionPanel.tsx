import { Star } from 'lucide-react';
import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingRows,
  formatNumber,
  formatPercent,
} from '../../ui';
import { errorMessage, useRatings } from './useAnalyticsData';

/**
 * Post-chat visitor ratings.
 *
 * Not plan-gated. The tab this replaces gated satisfaction on `live_chat` while
 * calling it post-chat ratings — two different things: the rating is left by
 * the visitor in the widget and stored on the session, `/analytics/ratings-summary`
 * has no plan check on it at all, and a workspace that never turns live chat on
 * still collects them. A lock in front of data a customer already has is just a
 * wall.
 *
 * The endpoint takes no window, so this says "all time" rather than inheriting
 * the page's range and quietly mislabelling itself.
 */
const STARS: ReadonlyArray<1 | 2 | 3 | 4 | 5> = [5, 4, 3, 2, 1];

export function SatisfactionPanel({ botId }: { botId: number | null }) {
  const { ratings, loading, error, refetch } = useRatings(botId);

  return (
    <Card>
      <CardHeader
        eyebrow="Satisfaction"
        title="What visitors thought"
        titleAs="h2"
        description="Ratings visitors left after a conversation · all time"
      />
      {loading ? (
        <CardBody>
          <LoadingRows rows={5} />
        </CardBody>
      ) : error ? (
        <ErrorState
          compact
          title="Ratings could not be loaded"
          description={errorMessage(error, 'The request for your visitor ratings failed.')}
          onRetry={() => void refetch()}
        />
      ) : !ratings || ratings.total === 0 ? (
        <EmptyState
          compact
          icon={Star}
          title="No ratings yet"
          description="Visitors can rate a conversation when it ends. Nobody has yet, so there is nothing to summarise."
        />
      ) : (
        <CardBody>
          <div className="flex items-baseline gap-2">
            <span className="figure text-2xl font-semibold text-text-primary">
              {ratings.average.toFixed(1)}
            </span>
            <span className="text-xs text-text-tertiary">out of 5</span>
            <span className="text-xs text-text-secondary">
              from {formatNumber(ratings.total)} {ratings.total === 1 ? 'rating' : 'ratings'}
            </span>
          </div>
          <ul className="mt-4 space-y-2">
            {STARS.map((star) => {
              const count = ratings.distribution[star];
              const share = ratings.total > 0 ? count / ratings.total : 0;
              return (
                <li key={star} className="flex items-center gap-3">
                  <span className="figure w-14 shrink-0 text-xs text-text-secondary">
                    {star} {star === 1 ? 'star' : 'stars'}
                  </span>
                  <span
                    aria-hidden
                    className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-sunken"
                  >
                    <span
                      className="block h-full rounded-full bg-accent-500"
                      style={{ width: `${Math.round(share * 100)}%` }}
                    />
                  </span>
                  <span className="figure w-24 shrink-0 text-right text-xs text-text-secondary">
                    {formatNumber(count)} · {formatPercent(share)}
                  </span>
                </li>
              );
            })}
          </ul>
        </CardBody>
      )}
    </Card>
  );
}
