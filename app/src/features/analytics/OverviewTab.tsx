import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Card,
  CardBody,
  ErrorState,
  Grid,
  Stack,
  StatRow,
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
import { useTranslation } from '../../i18n/useTranslation';

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
  const { t } = useTranslation();
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
          title={t('analytics.yourFiguresCouldNotBe') || 'Your figures could not be loaded'}
          description={errorMessage(headline.error, t('analytics.theRequestForYourWorkspace') || 'The request for your workspace totals failed.')}
          onRetry={() => void headline.refetch()}
        />
      </Card>
    );
  }

  return (
    <Stack>
      <Card>
        <CardBody flush>
          <StatRow
            label={t('analytics.headlineFigures') || 'Headline figures'}
            period={range.label}
            items={[
              {
                label: t('analytics.conversations') || 'Conversations',
                value: formatNumber(headline.totals?.totalConversations ?? null),
                delta: conversationDelta
                  ? {
                      value: conversationDelta.value,
                      direction: conversationDelta.direction,
                      label: range.comparisonLabel ? `vs ${range.comparisonLabel}` : undefined,
                    }
                  : undefined,
                // `hint` is documented as "a few words, or put it on the
                // card": "Nothing in the previous 30 days to compare with"
                // wrapped to two lines under a four-up strip and made that one
                // tile 32px taller than its three peers.
                hint:
                  range.comparisonLabel && !conversationDelta ? t('analytics.noEarlierData') || 'No earlier data' : undefined,
                loading: headline.loading,
              },
              {
                label: t('analytics.messages') || 'Messages',
                value: formatNumber(current.total),
                delta: messageDelta
                  ? {
                      value: messageDelta.value,
                      direction: messageDelta.direction,
                      label: range.comparisonLabel ? `vs ${range.comparisonLabel}` : undefined,
                    }
                  : undefined,
                loading: messages.loading,
              },
              {
                label: t('analytics.qualifiedLeads') || 'Qualified leads',
                value: leads.locked ? undefined : formatNumber(leads.leads?.sql ?? null),
                period: t('analytics.allTime') || 'All time',
                hint: leads.locked ? t('analytics.leadScoringIsOnStandard') || 'Lead scoring is on Standard and above' : undefined,
                loading: leads.loading,
              },
              {
                label: t('analytics.answersRatedHelpful') || 'Answers rated helpful',
                value: headline.totals
                  ? formatPercent(headline.totals.positiveFeedbackRate / 100)
                  : undefined,
                period: t('analytics.allTime') || 'All time',
                loading: headline.loading,
              },
            ]}
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

      {/* Peers: both answer "is this working?" at the same altitude, and a
          reader compares them. Stacked full-width they were two screens apart.

          Stretched, not `align="start"`: these are panels, and `Grid` says
          `start` is "right for a row of disclosures, wrong for a row of
          panels". With `start` the funnel measured 452px against the ratings'
          372 and the pair ended on two different lines 80px apart — worse when
          either falls to an empty or locked state, where the gap was 115. */}
      <Grid cols={2} gap="section">
        <FunnelPanel botId={botId} range={range} unlocked={hasFeature('bant')} />
        <SatisfactionPanel botId={botId} />
      </Grid>
    </Stack>
  );
}
