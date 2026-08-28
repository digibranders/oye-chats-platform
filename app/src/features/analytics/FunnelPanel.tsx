import { Download, Filter } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorState,
  LockedState,
  RankedBars,
  buttonClass,
  formatNumber,
  formatPercent,
} from '../../ui';
import { funnelHasData, readFunnel } from '../leads/leadModel';
import { csvFilename, exportRows } from './exportCsv';
import { errorMessage, useQualificationFunnel } from './useAnalyticsData';
import type { ResolvedRange } from './range';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * The visitor-to-booked-call funnel, for the period the page is set to.
 *
 * It used to carry its own period control — a second time vocabulary inside a
 * page that already had one — and it swallowed every fetch failure into its
 * empty state, so an outage read as "no funnel activity in this period yet" and
 * the reader had no reason to doubt it. It takes the page's range now, and a
 * failure says so and offers the way back.
 *
 * The stages are `RankedBars`, not a hand-drawn bar list. The version this
 * replaces painted `bg-accent-50` on `bg-surface-sunken` — about 1.05:1, which
 * means the bar the panel exists for could not be seen at all — at a bar height
 * and row padding neither of its two neighbouring panels shared.
 */

export interface FunnelPanelProps {
  botId: number | null;
  range: ResolvedRange;
  /** False when the workspace's plan has no lead qualification. */
  unlocked: boolean;
}

export function FunnelPanel({ botId, range, unlocked }: FunnelPanelProps) {
  const { t } = useTranslation();
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
      [t('analytics.stage') || 'Stage', t('analytics.whatItMeans') || 'What it means', t('analytics.count') || 'Count', t('analytics.conversionFromPrevious') || 'Conversion from previous (%)'],
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
        title={t('analytics.howVisitorsBecomeBuyers') || 'How visitors become buyers'}
        titleAs="h2"
        description={`Where people drop off between a first visit and a booked call · ${range.label.toLowerCase()}`}
        actions={
          !planLocked && funnelHasData(stages) ? (
            <Button size="sm" variant="ghost" onClick={onExport} iconLeft={<Download aria-hidden />}>
              {t('analytics.export') || 'Export'}
            </Button>
          ) : undefined
        }
      />
      {planLocked ? (
        <LockedState
          size="panel"
          title={t('analytics.leadQualificationIsOnStandard') || 'Lead qualification is on Standard and above'}
          description={t('analytics.standardScoresEveryConversationAgainst') || 'Standard scores every conversation against budget, authority, need and timing, and this funnel shows you where the ones that matter fall out.'}
          action={
            <Link to="/billing" className={buttonClass('primary', 'sm')}>
              {t('analytics.seePlans') || 'See plans'}
            </Link>
          }
        />
      ) : error ? (
        <ErrorState
          size="panel"
          polite
          title={t('analytics.theFunnelCouldNotBe') || 'The funnel could not be loaded'}
          description={errorMessage(error, t('analytics.theRequestForYourQualification') || 'The request for your qualification funnel failed.')}
          onRetry={() => void refetch()}
        />
      ) : !loading && !funnelHasData(stages) ? (
        <EmptyState
          size="panel"
          icon={Filter}
          title={t('analytics.noFunnelActivityInThis') || 'No funnel activity in this period'}
          description={t('analytics.nobodyReachedTheChatbotIn') || 'Nobody reached the chatbot in this window. Try a wider period, or check the widget is still installed.'}
        />
      ) : (
        <CardBody flush>
          <RankedBars
            label={t('analytics.qualificationFunnelStages') || 'Qualification funnel stages'}
            loading={loading}
            loadingRows={stages.length || 5}
            max={stages[0]?.count}
            items={stages.map((stage) => ({
              id: stage.key,
              label: stage.label,
              value: stage.count,
              display: formatNumber(stage.count),
              meta:
                stage.conversionFromPrev === null
                  ? stage.sublabel
                  : `${stage.sublabel} · ${formatPercent(stage.conversionFromPrev / 100)} of previous`,
            }))}
          />
        </CardBody>
      )}
    </Card>
  );
}
