import { type ReactElement, useMemo, useState } from 'react';
import { Download, MessageSquare, RefreshCw, TriangleAlert } from 'lucide-react';
import {
  Button,
  EmptyState,
  SegmentedControl,
  type SegmentedOption,
  Skeleton,
} from '../../design-system';
import { FeedbackFilterTabs } from './FeedbackFilterTabs';
import {
  buildTopDownvoted,
  buildTrend,
  computeStats,
  exportFeedbackCsv,
  filterByDateRange,
  filterItems,
  normalizeQuestionKey,
} from './feedback-helpers';
import { FeedbackList } from './FeedbackList';
import { FeedbackTrendChart } from './FeedbackTrendChart';
import { TopDownvotedQuestions } from './TopDownvotedQuestions';
import { type DateRange, type FeedbackFilter } from './types';
import { useFeedback } from './useFeedback';

/** Days represented by each date-range option, for `buildTrend`'s `days` argument. */
const RANGE_DAYS: Record<DateRange, number> = { '7d': 7, '30d': 30, all: 0 };

/** The date windows the panel offers, as `SegmentedControl` options. */
const RANGES: readonly SegmentedOption<DateRange>[] = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

function LoadingState(): ReactElement {
  return (
    <div className="space-y-6" aria-busy="true">
      <Skeleton className="h-20" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
      <Skeleton className="h-10 w-64" />
      <Skeleton className="h-24" />
      <Skeleton className="h-24" />
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }): ReactElement {
  return (
    <EmptyState
      icon={TriangleAlert}
      title="We couldn’t load feedback"
      description={message}
      action={
        <Button variant="primary" onClick={onRetry}>
          <RefreshCw size={16} aria-hidden="true" />
          Try again
        </Button>
      }
    />
  );
}

export interface FeedbackPanelProps {
  /** Scope to one agent's feedback. Omitted ⇒ workspace-wide (every agent). */
  agentId?: string;
}

/**
 * FeedbackPanel - the itemized thumbs-up/down feedback log: date filter, CSV
 * export, summary bar, satisfaction trend, top-downvoted questions, and an
 * expandable All/Positive/Negative list. Restyled 1:1 port of the legacy
 * `pages/Feedback.jsx`, shared between the workspace Analytics page and the
 * per-agent Analytics tab.
 */
export function FeedbackPanel({ agentId }: FeedbackPanelProps): ReactElement {
  const { items, loading, error, refresh } = useFeedback(agentId);
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [filter, setFilter] = useState<FeedbackFilter>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const dateFiltered = useMemo(() => filterByDateRange(items, dateRange), [items, dateRange]);
  const stats = useMemo(() => computeStats(dateFiltered), [dateFiltered]);
  const trend = useMemo(
    () => buildTrend(items, RANGE_DAYS[dateRange]),
    [items, dateRange],
  );
  const topDownvoted = useMemo(() => buildTopDownvoted(dateFiltered), [dateFiltered]);
  const filtered = useMemo(() => filterItems(dateFiltered, filter), [dateFiltered, filter]);

  function jumpToQuestion(question: string): void {
    const key = normalizeQuestionKey(question);
    const match = dateFiltered.find(
      (item) => item.feedback !== 1 && normalizeQuestionKey(item.question) === key,
    );
    if (!match) return;
    setFilter('negative');
    setExpandedId(match.message_id);
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-feedback-id="${match.message_id}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  if (error) {
    return <ErrorState message={error} onRetry={refresh} />;
  }

  if (loading) {
    return <LoadingState />;
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No feedback yet"
        description="Your users haven't rated any chatbot responses yet. Ratings will appear here once they use the thumbs up/down buttons."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <SegmentedControl
          options={RANGES}
          value={dateRange}
          onChange={setDateRange}
          ariaLabel="Feedback date range"
        />
        <Button variant="outline" size="sm" onClick={() => exportFeedbackCsv(filtered)}>
          <Download size={13} aria-hidden="true" />
          Export CSV
        </Button>
      </div>

      {(trend.length > 1 || topDownvoted.length > 0) && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {trend.length > 1 && <FeedbackTrendChart points={trend} />}
          {topDownvoted.length > 0 && (
            <TopDownvotedQuestions items={topDownvoted} onSelect={jumpToQuestion} />
          )}
        </div>
      )}

      <FeedbackFilterTabs stats={stats} value={filter} onChange={setFilter} />

      <FeedbackList
        items={filtered}
        expandedId={expandedId}
        onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
      />
    </div>
  );
}
