import { type KeyboardEvent, type ReactElement, useMemo, useRef, useState } from 'react';
import { Download, MessageSquare, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button, cn, EmptyState, Skeleton } from '../../design-system';
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
import { FeedbackSummaryBar } from './FeedbackSummaryBar';
import { FeedbackTrendChart } from './FeedbackTrendChart';
import { TopDownvotedQuestions } from './TopDownvotedQuestions';
import { type DateRange, type FeedbackFilter } from './types';
import { useFeedback } from './useFeedback';

/** Days represented by each date-range option, for `buildTrend`'s `days` argument. */
const RANGE_DAYS: Record<DateRange, number> = { '7d': 7, '30d': 30, all: 0 };

const RANGES: readonly { id: DateRange; label: string }[] = [
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
  { id: 'all', label: 'All' },
];

/**
 * Segmented date-range control (7d / 30d / All). Modelled as a WAI-ARIA radio
 * group - a one-of-N choice - with roving `tabIndex` and arrow/Home/End
 * navigation, matching the pattern used by `AnalyticsPage`'s `RangeControl`.
 */
function DateRangeControl({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
}): ReactElement {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectAt(index: number): void {
    const range = RANGES[index];
    if (!range) return;
    buttonRefs.current[index]?.focus();
    onChange(range.id);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const count = RANGES.length;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        selectAt((index + 1) % count);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        selectAt((index - 1 + count) % count);
        break;
      case 'Home':
        event.preventDefault();
        selectAt(0);
        break;
      case 'End':
        event.preventDefault();
        selectAt(count - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label="Feedback date range"
      className="inline-flex items-center gap-1 rounded-lg bg-[var(--ds-bg-sunken)] p-1"
    >
      {RANGES.map((range, index) => {
        const selected = range.id === value;
        return (
          <button
            key={range.id}
            ref={(node) => {
              buttonRefs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(range.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
              selected
                ? 'bg-[var(--ds-bg-surface)] text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)]'
                : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
            )}
          >
            {range.label}
          </button>
        );
      })}
    </div>
  );
}

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
        <DateRangeControl value={dateRange} onChange={setDateRange} />
        <Button variant="outline" size="sm" onClick={() => exportFeedbackCsv(filtered)}>
          <Download size={13} aria-hidden="true" />
          Export CSV
        </Button>
      </div>

      <FeedbackSummaryBar stats={stats} />

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
