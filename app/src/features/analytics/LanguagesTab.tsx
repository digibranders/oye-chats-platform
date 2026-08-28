import {
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  Grid,
  LoadingRows,
  RankedBars,
  Stack,
  StatRow,
  formatNumber,
  formatPercent,
} from '../../ui';
import { errorMessage, useLanguageBreakdown } from './useAnalyticsData';
import type { ResolvedRange } from './range';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * Which languages this chatbot's visitors actually chat in, and what
 * translating for them costs.
 *
 * **Two kinds of number live on this view and they are kept apart on purpose.**
 * The conversation mix and the credit spend are durable Postgres reads over the
 * page's range. The translation counters are a ROLLING window from Redis keys
 * that expire after about a day — they can answer "is translation healthy right
 * now", never "how much have we translated this month". Presenting them under
 * the range control's label would be a lie the reader has no way to detect, so
 * the card states its own window.
 *
 * A chatbot with multilingual off has no mix to show: one row reading
 * "English, 100%" is noise, not insight. The tab is hidden for it upstream, and
 * this renders the same empty state if someone deep-links in anyway.
 */
export function LanguagesTab({
  botId,
  range,
}: {
  botId: number | null;
  range: ResolvedRange;
}) {
  const { t } = useTranslation();
  const { breakdown, loading, error, refetch } = useLanguageBreakdown(botId, range.key);

  if (error) {
    return (
      <ErrorState
        framed
        title={t('analytics.weCouldNotLoadThe') || 'We could not load the language breakdown'}
        description={errorMessage(error, t('analytics.somethingWentWrongOnThe') || 'Something went wrong on the way to the server.')}
        onRetry={() => void refetch()}
      />
    );
  }

  if (loading || !breakdown) return <LoadingRows rows={4} />;

  if (!breakdown.multilingualEnabled) {
    return (
      <EmptyState
        framed
        title={t('analytics.thisChatbotAnswersInOne') || 'This chatbot answers in one language'}
        description={t('analytics.turnMultilingualOnUnderThe') || 'Turn multilingual on under the chatbot\'s Experience settings, and the languages your visitors write in will appear here.'}
      />
    );
  }

  const { rows, totals, translation } = breakdown;
  const bars = rows.map((row) => ({
    id: row.languageCode ?? 'undetected',
    label: row.label,
    value: row.total,
    display: formatNumber(row.total),
    meta:
      totals.total > 0
        ? `${formatPercent(row.total / totals.total)} of conversations · ${formatNumber(row.liveChat)} reached a person`
        : undefined,
  }));

  return (
    <Stack>
      <StatRow
        period={range.label}
        label={t('analytics.languageMix') || 'Language mix'}
        columns={4}
        items={[
          { label: t('analytics.conversations') || 'Conversations', value: formatNumber(totals.total) },
          { label: t('analytics.languagesUsed') || 'Languages used', value: formatNumber(totals.languages) },
          { label: t('analytics.markedResolved') || 'Marked resolved', value: formatNumber(totals.resolved) },
          {
            label: t('analytics.translationCredits') || 'Translation credits',
            value: formatNumber(breakdown.creditsSpent),
          },
        ]}
      />

      <Card>
        <CardHeader
          title={t('analytics.conversationsByLanguage') || 'Conversations by language'}
          titleAs="h2"
          description={t('analytics.barsAreProportionalToThe') || 'Bars are proportional to the busiest language, so a long tail stays readable.'}
        />
        <CardBody>
          {rows.length === 0 ? (
            <EmptyState
              size="panel"
              title={t('analytics.noConversationsInThisWindow') || 'No conversations in this window'}
              description={t('analytics.widenTheRangeOrWait') || 'Widen the range, or wait for visitors to arrive.'}
            />
          ) : (
            <RankedBars items={bars} label={t('analytics.conversationsByLanguage') || 'Conversations by language'} />
          )}
        </CardBody>
      </Card>

      {breakdown.operatorTranslationEnabled ? (
        <Card>
          <CardHeader
            title={t('analytics.liveChatTranslation') || 'Live-chat translation'}
            titleAs="h2"
            // The window is stated here, not inherited, because these counters
            // do not follow the page's range and never can.
            description={`A rolling ${formatNumber(translation.windowHours)}-hour window. These counters expire, so this is recent health, not history.`}
          />
          <CardBody>
            <Grid cols={4}>
              <Figure label={t('analytics.requests') || 'Requests'} value={translation.requests} />
              <Figure label={t('analytics.delivered') || 'Delivered'} value={translation.ok} />
              <Figure label={t('analytics.failed') || 'Failed'} value={translation.failed} />
              <Figure label={t('analytics.timedOut') || 'Timed out'} value={translation.timeout} />
            </Grid>
          </CardBody>
        </Card>
      ) : null}
    </Stack>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-xs text-text-tertiary">{label}</p>
      <p className="figure mt-0.5 text-xl text-text-primary">{formatNumber(value)}</p>
    </div>
  );
}
