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
  const { breakdown, loading, error, refetch } = useLanguageBreakdown(botId, range.key);

  if (error) {
    return (
      <ErrorState
        framed
        title="We could not load the language breakdown"
        description={errorMessage(error, 'Something went wrong on the way to the server.')}
        onRetry={() => void refetch()}
      />
    );
  }

  if (loading || !breakdown) return <LoadingRows rows={4} />;

  if (!breakdown.multilingualEnabled) {
    return (
      <EmptyState
        framed
        title="This chatbot answers in one language"
        description="Turn multilingual on under the chatbot's Experience settings, and the languages your visitors write in will appear here."
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
        label="Language mix"
        columns={4}
        items={[
          { label: 'Conversations', value: formatNumber(totals.total) },
          { label: 'Languages used', value: formatNumber(totals.languages) },
          { label: 'Marked resolved', value: formatNumber(totals.resolved) },
          {
            label: 'Translation credits',
            value: formatNumber(breakdown.creditsSpent),
          },
        ]}
      />

      <Card>
        <CardHeader
          title="Conversations by language"
          titleAs="h2"
          description="Bars are proportional to the busiest language, so a long tail stays readable."
        />
        <CardBody>
          {rows.length === 0 ? (
            <EmptyState
              size="panel"
              title="No conversations in this window"
              description="Widen the range, or wait for visitors to arrive."
            />
          ) : (
            <RankedBars items={bars} label="Conversations by language" />
          )}
        </CardBody>
      </Card>

      {breakdown.operatorTranslationEnabled ? (
        <Card>
          <CardHeader
            title="Live-chat translation"
            titleAs="h2"
            // The window is stated here, not inherited, because these counters
            // do not follow the page's range and never can.
            description={`A rolling ${formatNumber(translation.windowHours)}-hour window. These counters expire, so this is recent health, not history.`}
          />
          <CardBody>
            <Grid cols={4}>
              <Figure label="Requests" value={translation.requests} />
              <Figure label="Delivered" value={translation.ok} />
              <Figure label="Failed" value={translation.failed} />
              <Figure label="Timed out" value={translation.timeout} />
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
