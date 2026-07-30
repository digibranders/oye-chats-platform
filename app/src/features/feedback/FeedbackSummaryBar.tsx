import { type ReactElement } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { Card } from '../../design-system';
import { type FeedbackStats } from './feedback-helpers';

interface FeedbackSummaryBarProps {
  stats: FeedbackStats;
}

/**
 * FeedbackSummaryBar - total ratings, positive rate, negative count, and a
 * proportional progress bar. Restyled port of the legacy summary bar
 * (`pages/Feedback.jsx:197-218`), same figures.
 */
export function FeedbackSummaryBar({ stats }: FeedbackSummaryBarProps): ReactElement {
  return (
    <Card className="flex flex-col items-start gap-4 p-5 sm:flex-row sm:items-center">
      <div className="flex flex-1 flex-wrap items-center gap-6">
        <div>
          <p className="text-2xl font-bold tabular-nums text-[var(--ds-text)]">{stats.total}</p>
          <p className="text-[12px] text-[var(--ds-text-subtle)]">Total ratings</p>
        </div>
        <div className="h-8 w-px bg-[var(--ds-border)]" />
        <div className="flex items-center gap-2">
          <ThumbsUp size={16} className="text-[var(--ds-success)]" aria-hidden="true" />
          <span className="text-sm font-bold tabular-nums text-[var(--ds-success)]">
            {stats.rate}%
          </span>
          <span className="text-[12px] text-[var(--ds-text-subtle)]">positive</span>
        </div>
        <div className="flex items-center gap-2">
          <ThumbsDown size={16} className="text-[var(--ds-danger)]" aria-hidden="true" />
          <span className="text-sm font-bold tabular-nums text-[var(--ds-danger)]">
            {stats.negative}
          </span>
          <span className="text-[12px] text-[var(--ds-text-subtle)]">negative</span>
        </div>
      </div>
      <div
        role="progressbar"
        aria-label="Positive feedback rate"
        aria-valuenow={stats.rate}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 w-full overflow-hidden rounded-full bg-[var(--ds-bg-sunken)] sm:w-48"
      >
        <div
          className="h-full rounded-full bg-[var(--ds-success)] transition-[width] duration-700"
          style={{ width: `${stats.rate}%` }}
        />
      </div>
    </Card>
  );
}
