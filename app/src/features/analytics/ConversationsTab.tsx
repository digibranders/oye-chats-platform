import { useMemo } from 'react';
import { Download } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, Stack, StatTile, formatNumber } from '../../ui';
import { csvFilename, exportRows } from './exportCsv';
import { delta, type ResolvedRange } from './range';
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
}: {
  botId: number | null;
  range: ResolvedRange;
}) {
  const messages = useMessageSeries(botId);

  const windows = useMemo(
    () => splitWindows(messages.series, range.days),
    [messages.series, range.days],
  );
  const points = useMemo(() => comparisonPoints(windows), [windows]);
  const current = useMemo(() => summarize(windows.selected), [windows]);
  const previous = useMemo(() => summarize(windows.preceding), [windows]);

  const hasPrevious = windows.preceding.length > 0;
  const messageDelta = hasPrevious ? delta(current.total, previous.total) : null;

  function onExport() {
    exportRows(
      csvFilename('message-volume', range.label),
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
            range.comparisonLabel
              ? `Against ${range.comparisonLabel}, day for day`
              : 'Every day since the first conversation'
          }
          actions={
            points.length > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={onExport}
                iconLeft={<Download aria-hidden className="h-3.5 w-3.5" />}
              >
                Export
              </Button>
            ) : undefined
          }
        />
        <CardBody>
          <div className="mb-5 grid grid-cols-3 gap-6">
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
              label="Daily average"
              value={formatNumber(current.dailyAverage)}
              period={range.label}
              loading={messages.loading}
            />
            <StatTile
              label="Busiest day"
              value={current.peakLabel ? formatNumber(current.peak) : undefined}
              period={current.peakLabel ?? range.label}
              loading={messages.loading}
            />
          </div>
          <MessageVolumeChart
            points={points}
            rangeLabel={range.label}
            comparisonLabel={range.comparisonLabel}
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

      <TopQuestionsPanel botId={botId} />
      <KnowledgeGapsPanel botId={botId} range={range} />
    </Stack>
  );
}
