import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, Grid, Stack, StatRow, formatNumber } from '../../ui';
import { getQueueSummary } from '../../services/api';
import { csvFilename, exportRows } from './exportCsv';
import { delta, resolveRange, type ResolvedRange } from './range';
import { comparisonPoints, splitWindows, summarize } from './series';
import { errorMessage, useMessageSeries } from './useAnalyticsData';
import { MessageVolumeChart } from './MessageVolumeChart';
import { TopQuestionsPanel } from './TopQuestionsPanel';
import { KnowledgeGapsPanel } from './KnowledgeGapsPanel';

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
  const effectiveRange = useMemo(
    () => range ?? resolveRange('30d'),
    [range],
  );
  const effectiveDays = effectiveRange.days ?? days ?? 30;

  const messages = useMessageSeries(botId);

  const queueQuery = useQuery({
    queryKey: ['queue-summary', botId, effectiveDays],
    queryFn: () => getQueueSummary(botId ?? undefined, effectiveDays ?? undefined),
  });
  const queueData = queueQuery.data;

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
      ['Day', 'Messages', 'Previous period day', 'Previous period messages'],
      points.map((point) => [point.date, point.messages, point.previousLabel ?? '', point.previous]),
    );
  }

  return (
    <Stack>
      <Card>
        <CardHeader
          eyebrow="Volume"
          title="Messages per day"
          titleAs="h2"
          description={
            effectiveRange.comparisonLabel
              ? `Against ${effectiveRange.comparisonLabel}, day for day`
              : 'Every day since the first conversation'
          }
          actions={
            points.length > 0 ? (
              <Button size="sm" variant="ghost" onClick={onExport} iconLeft={<Download aria-hidden />}>
                Export
              </Button>
            ) : undefined
          }
        />
        <CardBody flush>
          <StatRow
            label="Message volume"
            period={effectiveRange.label}
            columns={3}
            loading={messages.loading}
            items={[
              {
                label: 'Messages',
                value: formatNumber(current.total),
                delta: messageDelta
                  ? {
                      value: messageDelta.value,
                      direction: messageDelta.direction,
                      label: effectiveRange.comparisonLabel ? `vs ${effectiveRange.comparisonLabel}` : undefined,
                    }
                  : undefined,
              },
              { label: 'Daily average', value: formatNumber(current.dailyAverage) },
              {
                label: 'Busiest day',
                value: current.peakLabel ? formatNumber(current.peak) : undefined,
                period: current.peakLabel ?? effectiveRange.label,
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
                ? errorMessage(messages.error, 'The request for message activity failed.')
                : null
            }
            onRetry={() => void messages.refetch()}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          eyebrow="Live chat"
          title="Live chat queue"
          titleAs="h2"
          description="Current queue depth and wait times"
        />
        <CardBody flush>
          <StatRow
            label="Live chat queue"
            period={effectiveRange.label}
            columns={4}
            loading={queueQuery.isLoading}
            items={[
              {
                label: 'Waiting now',
                value: queueData ? formatNumber(queueData.current_depth) : '0',
              },
              {
                label: 'Average wait',
                value:
                  queueData && queueData.avg_wait_seconds !== null
                    ? `${queueData.avg_wait_seconds}s`
                    : '—',
              },
              {
                label: 'Resolved',
                value: queueData ? formatNumber(queueData.resolved_count) : '0',
              },
              {
                label: 'Left queue',
                value: queueData ? formatNumber(queueData.abandoned_count) : '0',
              },
            ]}
          />
        </CardBody>
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
