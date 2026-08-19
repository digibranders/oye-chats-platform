import { Download, Filter } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  LoadingRows,
  LockedState,
  buttonClass,
  cn,
  formatNumber,
  formatPercent,
} from '../../ui';
import { funnelHasData, readFunnel, type FunnelStageView } from '../leads/leadModel';
import { csvFilename, exportRows } from './exportCsv';
import { errorMessage, useQualificationFunnel } from './useAnalyticsData';
import type { ResolvedRange } from './range';

/**
 * The visitor-to-booked-call funnel, for the period the page is set to.
 *
 * It used to carry its own period control — a second time vocabulary inside a
 * page that already had one — and it swallowed every fetch failure into its
 * empty state, so an outage read as "no funnel activity in this period yet" and
 * the reader had no reason to doubt it. It takes the page's range now, and a
 * failure says so and offers the way back.
 */

function FunnelRow({ stage }: { stage: FunnelStageView }) {
  return (
    <li className="flex items-center gap-3 border-t border-border px-5 py-3 first:border-t-0">
      <div className="w-36 shrink-0">
        <p className="text-sm font-medium text-text-primary">{stage.label}</p>
        <p className="text-2xs text-text-tertiary">{stage.sublabel}</p>
      </div>
      <div className="relative h-6 min-w-0 flex-1 overflow-hidden rounded-sm bg-surface-sunken">
        <div
          aria-hidden
          className="h-full rounded-sm bg-accent-50"
          style={{ width: `${stage.widthPct}%` }}
        />
      </div>
      <p className="figure w-20 shrink-0 text-right text-sm font-medium text-text-primary">
        {formatNumber(stage.count)}
      </p>
      <p
        className={cn(
          'figure w-24 shrink-0 text-right text-xs',
          stage.conversionFromPrev === null ? 'text-text-tertiary' : 'text-text-secondary',
        )}
      >
        {stage.conversionFromPrev === null
          ? 'Top of funnel'
          : `${formatPercent(stage.conversionFromPrev / 100)} of previous`}
      </p>
    </li>
  );
}

export interface FunnelPanelProps {
  botId: number | null;
  range: ResolvedRange;
  /** False when the workspace's plan has no lead qualification. */
  unlocked: boolean;
}

export function FunnelPanel({ botId, range, unlocked }: FunnelPanelProps) {
  const { funnel, loading, locked, error, refetch } = useQualificationFunnel(
    botId,
    range.key,
    unlocked,
  );
  const stages = readFunnel(funnel);
  const planLocked = !unlocked || locked;

  function onExport() {
    exportRows(
      csvFilename('funnel', range.label),
      ['Stage', 'What it means', 'Count', 'Conversion from previous (%)'],
      stages.map((stage) => [
        stage.label,
        stage.sublabel,
        stage.count,
        stage.conversionFromPrev === null ? '' : stage.conversionFromPrev.toFixed(1),
      ]),
    );
  }

  return (
    <Card>
      <CardHeader
        eyebrow="Qualification"
        title="How visitors become buyers"
        titleAs="h2"
        description={`Where people drop off between a first visit and a booked call · ${range.label.toLowerCase()}`}
        actions={
          !planLocked && funnelHasData(stages) ? (
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
      {planLocked ? (
        <LockedState
          compact
          title="Lead qualification is on Standard and above"
          description="Standard scores every conversation against budget, authority, need and timing, and this funnel shows you where the ones that matter fall out."
          action={
            <Link to="/billing" className={buttonClass('primary', 'sm')}>
              See plans
            </Link>
          }
        />
      ) : loading ? (
        <CardBody>
          <LoadingRows rows={6} />
        </CardBody>
      ) : error ? (
        <ErrorState
          compact
          title="The funnel could not be loaded"
          description={errorMessage(error, 'The request for your qualification funnel failed.')}
          onRetry={() => void refetch()}
        />
      ) : funnelHasData(stages) ? (
        <ol>
          {stages.map((stage) => (
            <FunnelRow key={stage.key} stage={stage} />
          ))}
        </ol>
      ) : (
        <EmptyState
          compact
          icon={Filter}
          title="No funnel activity in this period"
          description="Nobody reached the chatbot in this window. Try a wider period, or check the widget is still installed."
        />
      )}
    </Card>
  );
}
