import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Card,
  CardBody,
  ErrorState,
  Stack,
  StatTile,
  buttonClass,
  formatNumber,
  formatPercent,
} from '../../ui';
import { useEntitlements } from '../../hooks/useEntitlements';
import { agentPath } from '../../shell/nav';
import { delta, type ResolvedRange } from './range';
import { deriveInsights } from './insight';
import { splitWindows, summarize } from './series';
import {
  errorMessage,
  useHeadlineTotals,
  useLeadStats,
  useMessageSeries,
  useUnansweredQuestions,
} from './useAnalyticsData';
import { FunnelPanel } from './FunnelPanel';
import { SatisfactionPanel } from './SatisfactionPanel';

/**
 * Overview — the period, and the period before it.
 *
 * Every tile states the window it covers, and the two that the API can actually
 * window carry a comparison against the equivalent window before them. The two
 * that it cannot — qualified leads and the positive-answer rate, neither of
 * which takes a date filter — say "all time" rather than borrowing the range's
 * label, because a figure wearing the wrong period is worse than one wearing
 * none.
 */
export function OverviewTab({ botId, range }: { botId: number | null; range: ResolvedRange }) {
  const { hasFeature } = useEntitlements();
  const headline = useHeadlineTotals(botId, range);
  const messages = useMessageSeries(botId);
  const leads = useLeadStats(botId);
  const gaps = useUnansweredQuestions(botId, range.days);

  const windows = useMemo(
    () => splitWindows(messages.series, range.days),
    [messages.series, range.days],
  );
  const current = useMemo(() => summarize(windows.selected), [windows]);
  const previous = useMemo(() => summarize(windows.preceding), [windows]);

  const conversationDelta = delta(
    headline.totals?.totalConversations ?? 0,
    headline.previousConversations,
  );
  const messageDelta = windows.preceding.length > 0 ? delta(current.total, previous.total) : null;

  const insights = useMemo(
    () =>
      deriveInsights({
        rangeLabel: range.label,
        comparisonLabel: range.comparisonLabel,
        conversations: headline.totals?.totalConversations ?? 0,
        previousConversations: headline.previousConversations,
        unansweredCount: gaps.questions.length,
        topUnanswered: gaps.questions[0]
          ? { question: gaps.questions[0].question, count: gaps.questions[0].count }
          : null,
        knowledgeTo: botId != null ? agentPath(botId, 'knowledge') : undefined,
      }),
    [range, headline.totals, headline.previousConversations, gaps.questions, botId],
  );

  if (headline.error) {
    return (
      <Card>
        <ErrorState
          title="Your figures could not be loaded"
          description={errorMessage(headline.error, 'The request for your workspace totals failed.')}
          onRetry={() => void headline.refetch()}
        />
      </Card>
    );
  }

  return (
    <Stack>
      <Card>
        <CardBody className="grid grid-cols-2 gap-6 lg:grid-cols-4">
          <StatTile
            label="Conversations"
            value={formatNumber(headline.totals?.totalConversations ?? null)}
            period={range.label}
            delta={
              conversationDelta
                ? { value: conversationDelta.value, direction: conversationDelta.direction }
                : undefined
            }
            hint={
              range.comparisonLabel && !conversationDelta
                ? `Nothing in ${range.comparisonLabel} to compare with`
                : undefined
            }
            loading={headline.loading}
          />
          <StatTile
            label="Messages"
            value={formatNumber(current.total)}
            period={range.label}
            delta={
              messageDelta
                ? { value: messageDelta.value, direction: messageDelta.direction }
                : undefined
            }
            loading={messages.loading}
          />
          <StatTile
            label="Qualified leads"
            value={leads.locked ? undefined : formatNumber(leads.leads?.sql ?? null)}
            period="All time"
            hint={
              leads.locked
                ? 'Lead scoring is on Standard and above'
                : 'Lead totals are not reported by period'
            }
            loading={leads.loading}
          />
          <StatTile
            label="Answers rated helpful"
            value={
              headline.totals
                ? formatPercent(headline.totals.positiveFeedbackRate / 100)
                : undefined
            }
            period="All time"
            hint="Of every answer a visitor rated"
            loading={headline.loading}
          />
        </CardBody>
      </Card>

      {/* What changed, and only when something did. The section this replaces
          had one branch, which congratulated any workspace holding a
          ready-to-buy lead and rendered an empty div for everyone else. */}
      {insights.length > 0 ? (
        <div className="space-y-2">
          {insights.map((insight) => (
            <Alert
              key={insight.id}
              tone={insight.tone}
              title={insight.title}
              action={
                insight.action ? (
                  <Link to={insight.action.to} className={buttonClass('secondary', 'sm')}>
                    {insight.action.label}
                  </Link>
                ) : undefined
              }
            >
              {insight.body}
            </Alert>
          ))}
        </div>
      ) : null}

      <FunnelPanel botId={botId} range={range} unlocked={hasFeature('bant')} />
      <SatisfactionPanel botId={botId} />
    </Stack>
  );
}
