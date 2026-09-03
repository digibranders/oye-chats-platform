import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  ErrorState,
  Grid,
  Stack,
  StatRow,
  formatNumber,
} from '../../ui';
import { getQueueSummary } from '../../services/api';
import { csvFilename, exportRows } from './exportCsv';
import { delta, resolveRange, type ResolvedRange } from './range';
import { comparisonPoints, splitWindows, summarize } from './series';
import { errorMessage, useMessageSeries } from './useAnalyticsData';
import { MessageVolumeChart } from './MessageVolumeChart';
import { TopQuestionsPanel } from './TopQuestionsPanel';
import { KnowledgeGapsPanel } from './KnowledgeGapsPanel';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * Conversations — the volume, and what was in it.
 *
 * The tile row and the chart are cut from one series with one rule, so the
 * delta and the picture can never disagree. On the page this replaces they
 * could and did: the range control moved the chart while the delta beside it
 * stayed a fixed seven-day-versus-prior-seven-day figure, so "All time" showed
 * an all-time total with a one-week change stamped on it.
 */
export function ConversationsTab({
  botId,
  range,
  days,
}: {
  botId: number | null;
  range?: ResolvedRange;
  days?: number;
}) {
  const { t } = useTranslation();
  const effectiveRange = useMemo(
    () => range ?? resolveRange('30d'),
    [range],
  );
  const effectiveDays = effectiveRange.days ?? days ?? 30;

  // Twice the range: `splitWindows` cuts the previous window out of this same
  // series, so the days before the selected one have to have been fetched.
  const messages = useMessageSeries(botId, effectiveRange.extendedDays);

  const queueQuery = useQuery({
    queryKey: ['queue-summary', botId, effectiveDays],
    queryFn: () => getQueueSummary(botId ?? undefined, effectiveDays ?? undefined),
  });
  const queueData = queueQuery.data;

  /**
   * The window the queue card actually covers, which is not always the page's.
   *
   * `getQueueSummary` has no unbounded form: its `days` argument defaults to 30
   * and `/analytics/queue-summary` clamps the parameter to 1 to 90, so "All
   * time" can never be requested. The card used to print the range control's
   * label anyway, so selecting "All time" stamped an all-time heading on a
   * thirty-day answer. It states the window that was asked for instead.
   */
  const queuePeriod =
    effectiveRange.days === effectiveDays
      ? effectiveRange.label
      : t('analytics.lastNDays', { days: effectiveDays }) || `Last ${effectiveDays} days`;

  /**
   * The activity read failed, so every figure cut from the series is unknown.
   *
   * `useMessageSeries` hands back an empty array when the request fails, and
   * `summarize([])` is a full set of zeros: a 500 rendered "Messages 0 · Daily
   * average 0" as confidently as a quiet week. The chart below carries the
   * explanation and the retry; the tiles simply say they do not know.
   */
  const seriesFailed = messages.error != null;

  const windows = useMemo(
    () => splitWindows(messages.series, effectiveRange.days),
    [messages.series, effectiveRange.days],
  );
  const points = useMemo(() => comparisonPoints(windows), [windows]);
  const current = useMemo(() => summarize(windows.selected), [windows]);
  const previous = useMemo(() => summarize(windows.preceding), [windows]);

  const hasPrevious = windows.preceding.length > 0;
  const messageDelta = hasPrevious ? delta(current.total, previous.total) : null;

  function onExport() {
    exportRows(
      csvFilename('message-volume', effectiveRange.label),
      [t('analytics.day') || 'Day', t('analytics.messages') || 'Messages', t('analytics.previousPeriodDay') || 'Previous period day', t('analytics.previousPeriodMessages') || 'Previous period messages'],
      points.map((point) => [point.date, point.messages, point.previousLabel ?? '', point.previous]),
    );
  }

  return (
    <Stack>
      <Card>
        <CardHeader
          eyebrow="Volume"
          title={t('analytics.messagesPerDay') || 'Messages per day'}
          titleAs="h2"
          description={
            effectiveRange.comparisonLabel
              ? t('analytics.againstDayForDay', { period: effectiveRange.comparisonLabel }) ||
                `Against ${effectiveRange.comparisonLabel}, day for day`
              : t('analytics.everyDaySinceTheFirst') || 'Every day since the first conversation'
          }
          actions={
            points.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={onExport} iconLeft={<Download aria-hidden />}>
                {t('analytics.export') || 'Export'}
              </Button>
            ) : undefined
          }
        />
        <CardBody flush>
          <StatRow
            label={t('analytics.messageVolume') || 'Message volume'}
            period={effectiveRange.label}
            columns={3}
            loading={messages.loading}
            items={[
              {
                label: t('analytics.messages') || 'Messages',
                value: formatNumber(seriesFailed ? null : current.total),
                delta: messageDelta
                  ? {
                      value: messageDelta.value,
                      direction: messageDelta.direction,
                      label: effectiveRange.comparisonLabel ? `vs ${effectiveRange.comparisonLabel}` : undefined,
                    }
                  : undefined,
              },
              {
                label: t('analytics.dailyAverage') || 'Daily average',
                value: formatNumber(seriesFailed ? null : current.dailyAverage),
              },
              {
                label: t('analytics.busiestDay') || 'Busiest day',
                value: !seriesFailed && current.peakLabel ? formatNumber(current.peak) : undefined,
                // A failed read inherits the strip's window rather than naming
                // a peak day it never saw.
                period: seriesFailed ? undefined : (current.peakLabel ?? effectiveRange.label),
              },
            ]}
          />
        </CardBody>
        <CardBody>
          <MessageVolumeChart
            points={points}
            rangeLabel={effectiveRange.label}
            comparisonLabel={effectiveRange.comparisonLabel}
            total={current.total}
            previousTotal={hasPrevious ? previous.total : null}
            dailyAverage={current.dailyAverage}
            peak={current.peak}
            peakLabel={current.peakLabel}
            loading={messages.loading}
            error={
              messages.error
                ? errorMessage(messages.error, t('analytics.theRequestForMessageActivity') || 'The request for message activity failed.')
                : null
            }
            onRetry={() => void messages.refetch()}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Live chat"
          title={t('analytics.liveChatQueue') || 'Live chat queue'}
          titleAs="h2"
          description={t('analytics.currentQueueDepthAndWait') || 'Current queue depth and wait times'}
        />
        {/* A failed read is an error, not four zeros. `queueQuery.data` is
            undefined on a 500 and the tiles fell back to the string "0", so an
            outage rendered "Waiting now 0 · Resolved 0 · Left queue 0" under a
            header promising the live queue depth. */}
        {queueQuery.isError ? (
          <CardBody>
            <ErrorState
              size="panel"
              // One of several panels that can fail together on this page, so it
              // announces politely rather than interrupting the reader per card.
              polite
              description={errorMessage(
                queueQuery.error,
                t('analytics.analyticsLoadFailedRetry')
                  || 'We couldn’t load your analytics. Please try again.',
              )}
              onRetry={() => void queueQuery.refetch()}
            />
          </CardBody>
        ) : (
          <CardBody flush>
            <StatRow
              label={t('analytics.liveChatQueue') || 'Live chat queue'}
              period={queuePeriod}
              columns={4}
              loading={queueQuery.isLoading}
              items={[
                {
                  label: t('analytics.waitingNow') || 'Waiting now',
                  value: formatNumber(queueData?.current_depth ?? null),
                  // Live, whatever `days` was asked for: `current_depth` counts
                  // sessions still waiting within the last hour. Wearing the
                  // card's window made the one figure on the strip that is not
                  // historical the one figure claiming to be. "Right now" is the
                  // same words Home's live tiles use, so it is the same entry.
                  period: t('home.rightNow') || 'Right now',
                },
                {
                  label: t('analytics.averageWait') || 'Average wait',
                  value:
                    queueData && queueData.avg_wait_seconds !== null
                      ? `${queueData.avg_wait_seconds}s`
                      : undefined,
                },
                {
                  label: t('analytics.resolved') || 'Resolved',
                  value: formatNumber(queueData?.resolved_count ?? null),
                },
                {
                  label: t('analytics.leftQueue') || 'Left queue',
                  value: formatNumber(queueData?.abandoned_count ?? null),
                },
              ]}
            />
          </CardBody>
        )}
      </Card>

      {/* Peers: "what they asked" and "what we could not answer" are the same
          question from two sides, and the reader reads one against the other —
          so they share a bottom edge. See the note in `OverviewTab`. */}
      <Grid cols={2} gap="section">
        <TopQuestionsPanel botId={botId} />
        <KnowledgeGapsPanel botId={botId} range={effectiveRange} />
      </Grid>
    </Stack>
  );
}
