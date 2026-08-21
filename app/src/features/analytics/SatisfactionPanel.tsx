import { Download, Star } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  RankedBars,
  formatNumber,
  formatPercent,
} from '../../ui';
import { csvFilename, exportRows } from './exportCsv';
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
  const empty = !ratings || ratings.total === 0;

  function onExport() {
    if (!ratings) return;
    exportRows(
      csvFilename('ratings', 'all time'),
      ['Rating', 'Ratings', 'Share (%)'],
      STARS.map((star) => [
        star,
        ratings.distribution[star],
        ratings.total > 0 ? ((ratings.distribution[star] / ratings.total) * 100).toFixed(1) : '',
      ]),
    );
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Satisfaction"
        title="What visitors thought"
        titleAs="h2"
        description="Ratings visitors left after a conversation · all time"
        actions={
          !loading && !error && !empty ? (
            <Button size="sm" variant="ghost" onClick={onExport} iconLeft={<Download aria-hidden />}>
              Export
            </Button>
          ) : undefined
        }
      />
      {error ? (
        <ErrorState
          size="panel"
          polite
          title="Ratings could not be loaded"
          description={errorMessage(error, 'The request for your visitor ratings failed.')}
          onRetry={() => void refetch()}
        />
      ) : !loading && empty ? (
        <EmptyState
          size="panel"
          icon={Star}
          title="No ratings yet"
          description="Visitors can rate a conversation when it ends. Nobody has yet, so there is nothing to summarise."
        />
      ) : (
        <>
          {ratings ? (
            <CardBody>
              <div className="flex items-baseline gap-2">
                <span className="figure text-2xl font-semibold text-text-primary">
                  {ratings.average.toFixed(1)}
                </span>
                <span className="text-xs text-text-tertiary">out of 5</span>
                <span className="text-xs text-text-secondary">
                  from <span className="figure">{formatNumber(ratings.total)}</span>{' '}
                  {ratings.total === 1 ? 'rating' : 'ratings'}
                </span>
              </div>
            </CardBody>
          ) : null}
          <CardBody flush>
            <RankedBars
              label="Ratings by number of stars"
              loading={loading}
              loadingRows={STARS.length}
              max={ratings?.total}
              // One figure in the figure column, the share on the meta line
              // under the label — the same shape the funnel next door uses.
              // `650 · 51%` does not fit `RankedBars`' 4rem figure column and
              // wrapped onto two lines on three of the five rows, which made
              // every row a different height in a chart whose whole point is
              // comparing their lengths.
              items={STARS.map((star) => {
                const count = ratings?.distribution[star] ?? 0;
                const share = ratings && ratings.total > 0 ? count / ratings.total : 0;
                return {
                  id: String(star),
                  label: `${star} ${star === 1 ? 'star' : 'stars'}`,
                  value: count,
                  display: formatNumber(count),
                  meta: ratings && ratings.total > 0 ? `${formatPercent(share)} of all ratings` : undefined,
                };
              })}
            />
          </CardBody>
        </>
      )}
    </Card>
  );
}
