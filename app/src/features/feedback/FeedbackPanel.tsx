import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, MessageSquareHeart } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingRows,
  LockedState,
  Stack,
  StatTile,
  buttonClass,
  formatNumber,
} from '../../ui';
import { errorMessage } from '../analytics/useAnalyticsData';
import type { ResolvedRange } from '../analytics/range';
import { FeedbackFilterTabs } from './FeedbackFilterTabs';
import { FeedbackList } from './FeedbackList';
import { FeedbackTrendChart } from './FeedbackTrendChart';
import { TopDownvotedQuestions } from './TopDownvotedQuestions';
import {
  buildTopDownvoted,
  buildTrend,
  computeStats,
  exportFeedbackCsv,
  filterItems,
  filterToWindow,
  normalizeQuestionKey,
} from './feedback-helpers';
import { type FeedbackFilter } from './types';
import { useFeedback } from './useFeedback';

export interface FeedbackPanelProps {
  /** The chatbot whose ratings these are. `null` while the agent list resolves. */
  botId: number | null;
  /**
   * The reporting window, resolved once for the whole Analytics page.
   *
   * A prop, not state. This panel used to own a private 7d/30d/All segmented
   * control — the last competing time vocabulary on `/analytics` — so the page
   * header could read "Last 90 days" while the card under it counted a
   * fortnight, and nothing on screen admitted the two disagreed.
   */
  range: ResolvedRange;
}

/**
 * Were the answers any good?
 *
 * Every visitor thumb, in one place: the helpful share over the window, how it
 * moved day by day, the questions that keep getting a thumbs-down, and the
 * exchanges themselves. The order is the argument — the share is the headline,
 * the repeat offenders are what you act on, and the log is the evidence.
 */
export function FeedbackPanel({ botId, range }: FeedbackPanelProps) {
  const { items, loading, locked, error, refetch } = useFeedback(botId);
  const [filter, setFilter] = useState<FeedbackFilter>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);

  const inWindow = useMemo(() => filterToWindow(items, range.since), [items, range.since]);
  const stats = useMemo(() => computeStats(inWindow), [inWindow]);
  const trend = useMemo(() => buildTrend(inWindow, range.days ?? 0), [inWindow, range.days]);
  const topDownvoted = useMemo(() => buildTopDownvoted(inWindow), [inWindow]);
  const visible = useMemo(() => filterItems(inWindow, filter), [inWindow, filter]);

  /**
   * Jump from a ranked question to the exchange behind it.
   *
   * Switches the filter to the unhelpful ones first, because the match is
   * always a negative rating and leaving the filter on "Helpful" would scroll
   * to a row that is not rendered.
   */
  function jumpToQuestion(question: string) {
    const key = normalizeQuestionKey(question);
    const match = inWindow.find(
      (item) => item.feedback !== 1 && normalizeQuestionKey(item.question) === key,
    );
    if (!match) return;
    setSelectedQuestion(question);
    setFilter('negative');
    setExpandedId(match.message_id);
    // After paint, because the row is only in the DOM once the filter change
    // above has rendered. Smooth unless the reader has asked for less motion —
    // a smooth scroll is an animation, and this one moves the whole viewport.
    requestAnimationFrame(() => {
      const row = document.querySelector(`[data-feedback-id="${match.message_id}"]`);
      if (!(row instanceof HTMLElement)) return;
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      row.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
    });
  }

  if (locked) {
    return (
      <LockedState
        title="Answer ratings are not included in your plan"
        description="Visitors can already rate answers in the widget. Seeing which ones they marked unhelpful — and which questions they keep marking — comes with Standard and above."
        action={
          <Link to="/billing" className={buttonClass('primary', 'sm')}>
            See plans
          </Link>
        }
      />
    );
  }

  if (error) {
    return (
      <Card>
        <ErrorState
          title="Ratings could not be loaded"
          description={errorMessage(error, 'The request for answer ratings failed.')}
          onRetry={refetch}
        />
      </Card>
    );
  }

  const helpfulShare = stats.total > 0 ? `${stats.rate}%` : undefined;
  const nothingEver = !loading && items.length === 0;

  return (
    <Stack>
      <Card>
        <CardHeader
          eyebrow="Satisfaction"
          title="Were the answers helpful?"
          titleAs="h2"
          description={`Thumbs visitors left on individual answers · ${range.label.toLowerCase()}`}
        />
        <CardBody>
          <div className="mb-5 grid grid-cols-1 gap-6 sm:grid-cols-3">
            <StatTile
              label="Helpful share"
              value={helpfulShare}
              period={range.label}
              hint="Of the answers visitors rated, the share they marked helpful."
              loading={loading}
              tone={stats.total === 0 ? 'neutral' : stats.rate >= 70 ? 'success' : 'warning'}
            />
            <StatTile
              label="Rated answers"
              value={stats.total > 0 ? formatNumber(stats.total) : undefined}
              period={range.label}
              loading={loading}
            />
            <StatTile
              label="Marked unhelpful"
              value={stats.total > 0 ? formatNumber(stats.negative) : undefined}
              period={range.label}
              loading={loading}
              tone={stats.negative > 0 ? 'danger' : 'neutral'}
            />
          </div>

          <FeedbackTrendChart
            points={trend}
            rangeLabel={range.label}
            overallRate={stats.rate}
            loading={loading}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Priorities"
          title="Fix these first"
          titleAs="h2"
          description="The questions visitors most often marked unhelpful. Pick one to see the exchanges behind it."
        />
        {loading ? (
          <CardBody>
            <LoadingRows rows={5} />
          </CardBody>
        ) : topDownvoted.length === 0 ? (
          <EmptyState
            compact
            title={nothingEver ? 'Nothing rated unhelpful yet' : 'Nothing rated unhelpful in this period'}
            description={
              nothingEver
                ? 'When a visitor thumbs-down an answer, the question that produced it collects here so you can fix it in your knowledge base.'
                : 'No answer was marked unhelpful in this window. Widen the period to see older ones.'
            }
          />
        ) : (
          <TopDownvotedQuestions
            items={topDownvoted}
            selected={selectedQuestion}
            onSelect={jumpToQuestion}
          />
        )}
      </Card>

      <Card>
        <CardHeader
          eyebrow="Log"
          title="Every rated answer"
          titleAs="h2"
          description={`${formatNumber(visible.length)} ${visible.length === 1 ? 'exchange' : 'exchanges'} · ${range.label.toLowerCase()}`}
          actions={
            <>
              <FeedbackFilterTabs stats={stats} value={filter} onChange={setFilter} />
              <Button
                size="sm"
                variant="ghost"
                disabled={visible.length === 0}
                onClick={() => exportFeedbackCsv(visible, range.label)}
                iconLeft={<Download aria-hidden className="h-3.5 w-3.5" />}
              >
                Export
              </Button>
            </>
          }
        />
        {loading ? (
          <CardBody>
            <LoadingRows rows={6} />
          </CardBody>
        ) : visible.length === 0 ? (
          <EmptyState
            compact
            icon={MessageSquareHeart}
            title={
              nothingEver
                ? 'No answers rated yet'
                : inWindow.length === 0
                  ? 'Nothing rated in this period'
                  : 'Nothing matches this filter'
            }
            description={
              nothingEver
                ? 'Visitors can rate any answer with a thumbs up or down in the chat widget. Once they start, every rating lands here with the question that produced it.'
                : inWindow.length === 0
                  ? 'Visitors have rated answers, but none in this window. Try a wider reporting period.'
                  : 'No rated answer matches the filter you picked. Switch back to All to see the rest.'
            }
          />
        ) : (
          <FeedbackList
            items={visible}
            expandedId={expandedId}
            onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
          />
        )}
      </Card>
    </Stack>
  );
}
