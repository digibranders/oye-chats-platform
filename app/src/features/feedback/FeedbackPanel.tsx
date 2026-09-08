import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, MessageSquareHeart, X } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Grid,
  LoadingBars,
  LoadingRows,
  Stack,
  StatRow,
  Toolbar,
  buttonClass,
  formatNumber,
} from '../../ui';
import { agentPath } from '../../shell/nav';
import { errorMessage, useLiveSupportRatings, useOperatorRatings } from '../analytics/useAnalyticsData';
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

/**
 * Ratings below which an operator's average is shown muted rather than stated.
 *
 * Not a hidden row: excluding a new operator entirely would be worse, because
 * they would simply be absent from a list their manager is reading. The figure
 * still appears, it just stops looking like a verdict. Five is the point where
 * a single bad chat stops dominating the mean.
 */
const MIN_CONFIDENT_RATINGS = 5;

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
 *
 * The last two sit **side by side**, because they are one thing read against
 * the other: pick a question on the left, read its exchanges on the right.
 * Stacked full-width in a 1,376px column they were a screen apart, which is why
 * choosing a question used to smooth-scroll the whole viewport down to a card
 * the reader could not see — a jump that is unnecessary once they are adjacent.
 *
 * **Not plan-gated, so there is no locked state.** `/analytics/feedback` carries
 * no entitlement check — it can answer, 404 on an unowned chatbot, or 500, and
 * that is the whole set. A lock rendered on a 403 would therefore be a wall in
 * front of data the customer already has, and would name a tier that does not
 * gate anything; the same argument `SatisfactionPanel` makes for the ratings
 * summary next door. A refusal is an error here, and is rendered as one.
 */
export function FeedbackPanel({ botId, range }: FeedbackPanelProps) {
  const { items, loading, error, refetch } = useFeedback(botId);
  // The star rating visitors leave after a LIVE support chat. A separate
  // population from the thumbs below: thumbs score one AI answer, this scores
  // the conversation a person handled.
  const { ratings: liveRatings, loading: liveLoading } = useLiveSupportRatings(botId, range);
  // Per-operator breakdown. `forbidden` is a plain operator being told this is
  // not their view; the section simply does not render for them.
  const { operators, forbidden: operatorsForbidden } = useOperatorRatings(botId, range);
  const [filter, setFilter] = useState<FeedbackFilter>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [selectedQuestion, setSelectedQuestion] = useState<string | null>(null);

  const inWindow = useMemo(() => filterToWindow(items, range.since), [items, range.since]);
  const stats = useMemo(() => computeStats(inWindow), [inWindow]);
  const trend = useMemo(() => buildTrend(inWindow, range.days ?? 0), [inWindow, range.days]);
  const topDownvoted = useMemo(() => buildTopDownvoted(inWindow), [inWindow]);
  const visible = useMemo(() => filterItems(inWindow, filter), [inWindow, filter]);

  /**
   * Select a ranked question, and show the exchanges behind it.
   *
   * Switches the filter to the unhelpful ones first, because the match is
   * always a negative rating and leaving the filter on "Helpful" would select a
   * row that is not rendered. It does **not** move the viewport: the log is the
   * card beside this one now, and scrolling the page to it lost the reader
   * their place for no gain.
   */
  function selectQuestion(question: string) {
    const key = normalizeQuestionKey(question);
    const match = inWindow.find(
      (item) => item.feedback !== 1 && normalizeQuestionKey(item.question) === key,
    );
    if (!match) return;
    setSelectedQuestion(question);
    setFilter('negative');
    setExpandedId(match.message_id);
  }

  function clearQuestion() {
    setSelectedQuestion(null);
    setExpandedId(null);
  }

  // Only when there is nothing to show. With ratings already in hand a failed
  // refetch must not blow the panel away — it says so in place, below.
  if (error && items.length === 0) {
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
  const shown = selectedQuestion
    ? visible.filter(
        (item) => normalizeQuestionKey(item.question) === normalizeQuestionKey(selectedQuestion),
      )
    : visible;

  return (
    <Stack>
      {/* Ratings in hand and the refetch failed: every figure below is stale
          and nothing else on screen would admit it. */}
      {error ? (
        <Alert
          tone="warning"
          action={
            <Button size="sm" onClick={refetch}>
              Try again
            </Button>
          }
        >
          These ratings may be out of date — the last refresh did not come back.
        </Alert>
      ) : null}

      <Card>
        <CardHeader
          eyebrow="Satisfaction"
          title="Were the answers helpful?"
          titleAs="h2"
          // No window in the description. `StatRow` states it once, in its own
          // caption under the four figures it anchors, so appending it here
          // printed the same string twice within 90px of itself.
          description="Thumbs visitors left on individual answers"
        />
        <CardBody flush>
          <StatRow
            label="Answer ratings"
            period={range.label}
            columns={3}
            loading={loading}
            items={[
              {
                label: 'Helpful share',
                value: helpfulShare,
                hint: 'Of the answers visitors rated',
                tone: stats.total === 0 ? 'neutral' : stats.rate >= 70 ? 'success' : 'warning',
              },
              {
                label: 'Rated answers',
                value: stats.total > 0 ? formatNumber(stats.total) : undefined,
              },
              {
                label: 'Marked unhelpful',
                value: stats.total > 0 ? formatNumber(stats.negative) : undefined,
                tone: stats.negative > 0 ? 'danger' : 'neutral',
              },
            ]}
          />
        </CardBody>
        <CardBody>
          <FeedbackTrendChart
            points={trend}
            rangeLabel={range.label}
            overallRate={stats.rate}
            loading={loading}
          />
        </CardBody>
      </Card>

      {/* Live support satisfaction. Deliberately its OWN card rather than more
          figures in the one above: a thumb rates a single AI answer, a star
          rates a whole conversation a person handled, and averaging the two
          into one "satisfaction" number would describe neither. Kept adjacent
          so the tab answers "what did visitors think?" in full — the star
          figure otherwise lives only on Overview and Conversations, which is
          not where anyone looks for feedback. */}
      <Card>
        <CardHeader
          eyebrow="Live support"
          title="How did the team do?"
          titleAs="h2"
          description="Stars visitors left after talking to an operator"
        />
        <CardBody flush>
          <StatRow
            label="Live chat ratings"
            period={range.label}
            columns={3}
            loading={liveLoading}
            items={[
              {
                label: 'Average rating',
                value:
                  liveRatings && liveRatings.total > 0 && liveRatings.average !== null
                    ? `${liveRatings.average.toFixed(1)} / 5`
                    : undefined,
                hint: 'Out of 5 stars',
                tone:
                  !liveRatings || liveRatings.total === 0
                    ? 'neutral'
                    : (liveRatings.average ?? 0) >= 4
                      ? 'success'
                      : (liveRatings.average ?? 0) >= 3
                        ? 'warning'
                        : 'danger',
              },
              {
                label: 'Chats rated',
                value:
                  liveRatings && liveRatings.total > 0 ? formatNumber(liveRatings.total) : undefined,
              },
              {
                label: 'Unhappy (1-2 stars)',
                value:
                  liveRatings && liveRatings.total > 0
                    ? formatNumber(liveRatings.distribution[1] + liveRatings.distribution[2])
                    : undefined,
                tone:
                  liveRatings && liveRatings.distribution[1] + liveRatings.distribution[2] > 0
                    ? 'danger'
                    : 'neutral',
              },
            ]}
          />
        </CardBody>
        {liveRatings && liveRatings.total > 0 ? (
          <CardBody>
            <Stack>
              {([5, 4, 3, 2, 1] as const).map((star) => {
                const count = liveRatings.distribution[star];
                const pct = liveRatings.total > 0 ? (count / liveRatings.total) * 100 : 0;
                return (
                  <div key={star} className="flex items-center gap-3">
                    <span className="w-10 shrink-0 text-caption text-text-secondary">
                      {star} star
                    </span>
                    <span
                      className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken"
                      role="img"
                      aria-label={`${star} stars: ${count} of ${liveRatings.total}`}
                    >
                      <span
                        className="block h-full rounded-full bg-warning"
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    <span className="w-8 shrink-0 text-end text-caption text-text-secondary">
                      {count}
                    </span>
                  </div>
                );
              })}
            </Stack>
          </CardBody>
        ) : !liveLoading ? (
          <CardBody>
            <EmptyState
              title="No live chat ratings yet"
              description="Visitors are asked to rate the chat once an operator closes it. Ratings appear here as they come in."
            />
          </CardBody>
        ) : null}

        {/* Per-operator breakdown, owners and admins only.
            A list rather than a filter: the question this answers is "how do my
            operators compare?", and a dropdown turns a comparison into one
            lookup per click plus a memory test. Ordered best-first by the
            server, so it reads as a ranking without any interaction.
            The rating COUNT sits beside every average on purpose. This is
            performance data about named people, and an average without its
            sample size invites a judgement the sample cannot support: below
            `MIN_CONFIDENT_RATINGS` the average is muted and labelled rather
            than printed as if it settled anything. */}
        {!operatorsForbidden && operators.length > 0 ? (
          <CardBody>
            <Stack>
              <p className="text-caption text-text-secondary">By operator</p>
              {operators.map((op) => {
                const thin = op.total < MIN_CONFIDENT_RATINGS;
                return (
                  <div key={op.operatorId} className="flex items-center gap-3">
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="truncate text-body">{op.name}</span>
                      {op.disambiguator ? (
                        <span className="truncate text-caption text-text-tertiary">
                          {op.disambiguator}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className={
                        thin
                          ? 'w-16 text-end text-body text-text-tertiary'
                          : 'w-16 text-end text-body font-medium'
                      }
                      title={thin ? 'Too few ratings to draw a conclusion from' : undefined}
                    >
                      {op.average !== null ? `${op.average.toFixed(1)} / 5` : '-'}
                    </span>
                    <span className="w-24 text-end text-caption text-text-secondary">
                      {formatNumber(op.total)} rated
                    </span>
                    <span className="w-20 text-end text-caption">
                      {op.unhappy > 0 ? (
                        <Badge tone="danger">{formatNumber(op.unhappy)} unhappy</Badge>
                      ) : null}
                    </span>
                  </div>
                );
              })}
              {operators.some((op) => op.total < MIN_CONFIDENT_RATINGS) ? (
                <p className="text-caption text-text-tertiary">
                  Greyed averages come from fewer than {MIN_CONFIDENT_RATINGS} ratings, which is too
                  small a sample to judge anyone by.
                </p>
              ) : null}
            </Stack>
          </CardBody>
        ) : null}
      </Card>

      {/* Stretched, not `align="start"`. `Grid` says `start` is wrong for a row
          of panels, and here it was the difference between a shared bottom edge
          and a 920px hole down the left column — the log's own list is bounded
          now (see `FeedbackList`), so the two are within a card-header of each
          other rather than a screen apart. */}
      <Grid cols={2} gap="section">
        <Card>
          <CardHeader
            eyebrow="Priorities"
            title="Fix these first"
            titleAs="h2"
            // Short enough that "Add knowledge" stays in the header's action
            // slot. At the full sentence the description and the button came to
            // 585px in a 512px header, so `CardHeader` wrapped the button onto
            // its own row at the *left* while Export on the card beside it sat
            // top-right — two panels in one `Grid`, two action placements.
            description="Most often marked unhelpful. Pick one to filter the log."
            actions={
              // Every row's next action is "add a document" or "fix the
              // answer", and both live in the knowledge base. Without this the
              // journey was: read a question here, switch scope to the chatbot,
              // open Knowledge, search for the gap.
              botId != null ? (
                <Link
                  to={agentPath(botId, 'knowledge')}
                  className={buttonClass('secondary', 'sm')}
                >
                  Add knowledge
                </Link>
              ) : undefined
            }
          />
          {loading ? (
            <CardBody flush>
              <LoadingBars rows={5} />
            </CardBody>
          ) : topDownvoted.length === 0 ? (
            <EmptyState
              size="panel"
              title={nothingEver ? 'Nothing rated unhelpful yet' : 'Nothing rated unhelpful in this period'}
              description={
                nothingEver
                  ? 'When a visitor thumbs-down an answer, the question that produced it collects here so you can fix it in your knowledge base.'
                  : 'No answer was marked unhelpful in this window. Widen the period to see older ones.'
              }
            />
          ) : (
            <CardBody flush>
              <TopDownvotedQuestions
                items={topDownvoted}
                selected={selectedQuestion}
                onSelect={selectQuestion}
              />
            </CardBody>
          )}
        </Card>

        <Card>
          <CardHeader
            eyebrow="Log"
            title="Every rated answer"
            titleAs="h2"
            description={`${range.label.toLowerCase()}`}
            actions={
              <Button
                size="sm"
                variant="ghost"
                disabled={shown.length === 0}
                onClick={() => exportFeedbackCsv(shown, range.label)}
                iconLeft={<Download aria-hidden />}
              >
                Export
              </Button>
            }
          />
          {/* The filter is a control *over the body*, not a header action, so it
              sits between the header and the list rather than reading as a peer
              of Export. */}
          <Toolbar className="border-b border-border px-cell py-2">
            <FeedbackFilterTabs stats={stats} value={filter} onChange={setFilter} />
            {selectedQuestion ? (
              <span className="ms-auto flex min-w-0 items-center gap-1">
                <Badge tone="ink" className="min-w-0">
                  {selectedQuestion}
                </Badge>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Clear the question filter"
                  onClick={clearQuestion}
                >
                  <X aria-hidden />
                </Button>
              </span>
            ) : null}
          </Toolbar>
          {loading ? (
            <CardBody>
              <LoadingRows rows={6} />
            </CardBody>
          ) : shown.length === 0 ? (
            <EmptyState
              size="panel"
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
              key={`${filter}:${selectedQuestion ?? ''}`}
              items={shown}
              expandedId={expandedId}
              onToggle={(id) => setExpandedId((current) => (current === id ? null : id))}
            />
          )}
        </Card>
      </Grid>
    </Stack>
  );
}
