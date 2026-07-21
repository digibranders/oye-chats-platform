import { type ReactElement } from 'react';
import { CheckCircle2, Star } from 'lucide-react';
import { Cell, Pie, PieChart, ResponsiveContainer } from 'recharts';
import { Card, EmptyState, SectionHeader, Skeleton } from '../../../design-system';
import { CHART } from './chartTheme';
import { type RatingStar, type RatingsSummary, type ResolutionSummary } from './analytics.types';

interface SatisfactionBreakdownProps {
  ratings: RatingsSummary;
  resolution: ResolutionSummary;
  loading: boolean;
}

const STAR_ORDER: readonly RatingStar[] = [5, 4, 3, 2, 1];

function starColor(star: RatingStar): string {
  if (star >= 4) return CHART.success;
  if (star === 3) return CHART.warning;
  return CHART.danger;
}

/**
 * SatisfactionBreakdown — post-chat sentiment for this agent: the star-rating
 * distribution and the resolved / unresolved split. Both come from the optional
 * end-of-chat survey, so each half degrades to its own empty state.
 */
export function SatisfactionBreakdown({
  ratings,
  resolution,
  loading,
}: SatisfactionBreakdownProps): ReactElement {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card className="p-5">
        <SectionHeader
          title="Rating distribution"
          description="How visitors rated their chats."
          actions={
            !loading && ratings.avg !== null ? (
              <span className="flex items-baseline gap-1">
                <span className="text-xl font-bold tabular-nums text-[var(--ds-text)]">
                  {ratings.avg}
                </span>
                <span className="text-[12px] text-[var(--ds-text-subtle)]">/ 5</span>
              </span>
            ) : undefined
          }
        />
        <div className="mt-5">
          {loading ? (
            <div className="space-y-2.5">
              {STAR_ORDER.map((s) => (
                <Skeleton key={s} className="h-4 w-full rounded-full" />
              ))}
            </div>
          ) : ratings.total === 0 ? (
            <EmptyState
              icon={Star}
              title="No ratings yet"
              description="Ratings appear once visitors leave feedback at the end of a chat."
            />
          ) : (
            <ul className="space-y-2.5">
              {STAR_ORDER.map((star) => {
                const count = ratings.distribution[star];
                const pct = ratings.total > 0 ? Math.round((count / ratings.total) * 100) : 0;
                return (
                  <li key={star} className="flex items-center gap-3">
                    <span className="flex w-9 shrink-0 items-center gap-0.5 text-[12px] font-medium text-[var(--ds-text-muted)]">
                      {star}
                      <Star
                        size={11}
                        className="text-[var(--ds-warning)]"
                        fill="currentColor"
                        aria-hidden="true"
                      />
                    </span>
                    <div
                      className="h-3 flex-1 overflow-hidden rounded-full bg-[var(--ds-bg-sunken)]"
                      role="img"
                      aria-label={`${star} stars: ${count} ratings (${pct}%)`}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{ width: `${pct}%`, backgroundColor: starColor(star) }}
                      />
                    </div>
                    <span className="w-10 shrink-0 text-right text-[12px] font-medium tabular-nums text-[var(--ds-text-muted)]">
                      {pct}%
                    </span>
                  </li>
                );
              })}
              <li className="border-t border-[var(--ds-border)] pt-2.5 text-[12px] text-[var(--ds-text-subtle)]">
                {ratings.total.toLocaleString()} rating{ratings.total === 1 ? '' : 's'} total
              </li>
            </ul>
          )}
        </div>
      </Card>

      <Card className="p-5">
        <SectionHeader
          title="Resolution rate"
          description="Were visitor issues resolved?"
          actions={
            !loading && resolution.rate !== null ? (
              <span className="text-xl font-bold tabular-nums text-[var(--ds-text)]">
                {resolution.rate}%
              </span>
            ) : undefined
          }
        />
        <div className="mt-5">
          {loading ? (
            <Skeleton className="mx-auto h-40 w-40 rounded-full" />
          ) : resolution.total === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="No resolution data yet"
              description="This fills in when visitors confirm whether their question was answered."
            />
          ) : (
            <div className="flex flex-col items-center gap-4">
              <div className="h-40 w-40" aria-hidden="true">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={[
                        { name: 'Resolved', value: resolution.resolved },
                        { name: 'Unresolved', value: resolution.unresolved },
                      ]}
                      cx="50%"
                      cy="50%"
                      innerRadius={52}
                      outerRadius={72}
                      dataKey="value"
                      paddingAngle={3}
                      stroke="none"
                    >
                      <Cell fill={CHART.success} />
                      <Cell fill={CHART.danger} />
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <dl className="flex items-center gap-6">
                <div className="text-center">
                  <dt className="flex items-center justify-center gap-1.5 text-[12px] text-[var(--ds-text-muted)]">
                    <span
                      className="h-2 w-2 rounded-full bg-[var(--ds-success)]"
                      aria-hidden="true"
                    />
                    Resolved
                  </dt>
                  <dd className="mt-0.5 text-[15px] font-bold tabular-nums text-[var(--ds-text)]">
                    {resolution.resolved.toLocaleString()}
                  </dd>
                </div>
                <div className="text-center">
                  <dt className="flex items-center justify-center gap-1.5 text-[12px] text-[var(--ds-text-muted)]">
                    <span
                      className="h-2 w-2 rounded-full bg-[var(--ds-danger)]"
                      aria-hidden="true"
                    />
                    Unresolved
                  </dt>
                  <dd className="mt-0.5 text-[15px] font-bold tabular-nums text-[var(--ds-text)]">
                    {resolution.unresolved.toLocaleString()}
                  </dd>
                </div>
              </dl>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
