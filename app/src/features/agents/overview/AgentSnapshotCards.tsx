import { type ReactElement } from 'react';
import { formatNumber } from '../../../i18n/formatters';
import {
  ArrowUpRight,
  BookOpen,
  Globe,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, SectionHeader, StatusBadge } from '../../../design-system';
import { type ActivityPoint, type Bot } from '../../../types/domain';
import { ActivityTrend } from './ActivityTrend';
import { type AgentStats } from './overview-data';
import { useTranslation } from '../../../i18n/useTranslation';

export interface AgentSnapshotCardsProps {
  readonly agent: Bot;
  readonly details?: Bot | null;
  readonly stats: AgentStats | null;
  readonly activity: readonly ActivityPoint[];
  readonly agentBasePath: string;
}

export function AgentSnapshotCards({
  agent,
  details,
  stats,
  activity,
  agentBasePath,
}: AgentSnapshotCardsProps): ReactElement {
  const { t } = useTranslation();
  const chunkCount = agent.indexed_chunk_count ?? 0;
  const isInstalled = Boolean(agent.widget_installed_at);
  const siteHost = (agent.website ?? '').replace(/^https?:\/\//, '');
  const crawlStatus = agent.last_crawl_status;

  let knowledgeStatusText = t('agents.notTrained') || 'Not trained';
  let knowledgeTone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' = 'neutral';

  // Chunks before crawl status (same rule as agent-health.ts): the last
  // ATTEMPT failing must not report an agent that holds knowledge as broken,
  // it demotes to a warning about that attempt instead.
  if (crawlStatus === 'running') {
    knowledgeStatusText = t('agents.trainingNow') || 'Training now';
    knowledgeTone = 'info';
  } else if (chunkCount > 0) {
    const lastAttemptFailed = crawlStatus === 'failed' || crawlStatus === 'no_content';
    knowledgeStatusText = lastAttemptFailed ? t('agents.readyLastTrainingFailed') || 'Ready. Last training failed' : 'Ready';
    knowledgeTone = lastAttemptFailed ? 'warning' : 'success';
  } else if (crawlStatus === 'failed' || crawlStatus === 'no_content') {
    knowledgeStatusText = t('agents.needsAttention') || 'Needs attention';
    knowledgeTone = 'danger';
  }

  const brandTone = details?.brand_tone || agent.brand_tone || null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* 1. Knowledge Base Card */}
      <Card className="flex flex-col justify-between p-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <SectionHeader
              title={
                <span className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ds-text)]">
                  <BookOpen size={15} className="text-[var(--ds-accent)]" aria-hidden="true" />
                  {t('agents.knowledgeBase') || 'Knowledge base'}
                </span>
              }
              description={t('agents.trainedSourcesAndPassages') || 'Trained sources and passages.'}
            />
            <StatusBadge tone={knowledgeTone} dot>
              {knowledgeStatusText}
            </StatusBadge>
          </div>

          <div className="rounded-lg bg-[var(--ds-surface-elevated)] p-3 ring-1 ring-[var(--ds-border)]">
            <div className="text-lg font-bold text-[var(--ds-text)]">
              {chunkCount > 0 ? `${formatNumber(chunkCount)} passages` : t('agents.notTrainedYet') || 'Not trained yet'}
            </div>
            <p className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">
              {chunkCount > 0
                ? t('agents.indexedAndReadyForVisitor') || 'Indexed and ready for visitor questions.'
                : t('agents.addWebsiteLinksOrDocuments') || 'Add website links or documents to start training.'}
            </p>
          </div>
        </div>

        <div className="mt-4 border-t border-[var(--ds-border)] pt-3">
          <Link
            to={`${agentBasePath}/knowledge`}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ds-accent)] transition-colors hover:text-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ds-ring)]"
          >
            <span>{t('agents.manageKnowledge') || 'Manage knowledge'}</span>
            <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </Card>

      {/* 2. Channels Card */}
      <Card className="flex flex-col justify-between p-4">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <SectionHeader
              title={
                <span className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ds-text)]">
                  <Globe size={15} className="text-[var(--ds-accent)]" aria-hidden="true" />
                  {t('agents.deploymentChannels') || 'Deployment channels'}
                </span>
              }
              description={t('agents.activeChannelsAndWebsiteWidget') || 'Active channels and website widget.'}
            />
            <StatusBadge tone={isInstalled ? 'success' : 'neutral'} dot>
              {isInstalled ? 'Live' : t('agents.notInstalled') || 'Not installed'}
            </StatusBadge>
          </div>

          <div className="rounded-lg bg-[var(--ds-surface-elevated)] p-3 ring-1 ring-[var(--ds-border)]">
            <div className="text-[13px] font-semibold text-[var(--ds-text)]">{t('agents.websiteChatWidget') || 'Website Chat Widget'}</div>
            <p className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">
              {isInstalled
                ? agent.website
                  ? t('agents.activeOn', { site: siteHost }) || `Active on ${siteHost}`
                  : t('agents.installedAndAnsweringLiveVisitors') || 'Installed and answering live visitors.'
                : t('agents.embedCodeReadyToCopy') || 'Embed code ready to copy into your site.'}
            </p>
          </div>
        </div>

        <div className="mt-4 border-t border-[var(--ds-border)] pt-3">
          <Link
            to={`${agentBasePath}/channels`}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ds-accent)] transition-colors hover:text-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ds-ring)]"
          >
            <span>{t('agents.manageChannels') || 'Manage channels'}</span>
            <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </Card>

      {/* 3. Experience Card */}
      <Card className="flex flex-col justify-between p-4">
        <div className="space-y-3">
          <SectionHeader
            title={
              <span className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ds-text)]">
                <Sparkles size={15} className="text-[var(--ds-accent)]" aria-hidden="true" />
                {t('agents.aiPersonalityExperience') || 'AI personality & experience'}
              </span>
            }
            description={t('agents.brandToneStylingAndBehavior') || 'Brand tone, styling, and behavior.'}
          />

          <div className="rounded-lg bg-[var(--ds-surface-elevated)] p-3 ring-1 ring-[var(--ds-border)]">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--ds-text-subtle)]">
              {t('agents.brandTone') || 'Brand Tone'}
            </div>
            <div className="mt-0.5 text-[13px] font-semibold text-[var(--ds-text)]">
              {brandTone || t('agents.configuredInExperience') || 'Configured in Experience'}
            </div>
            <p className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">
              {t('agents.definesResponseStyleAndConversation') || 'Defines response style and conversation guardrails.'}
            </p>
          </div>
        </div>

        <div className="mt-4 border-t border-[var(--ds-border)] pt-3">
          <Link
            to={`${agentBasePath}/experience`}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ds-accent)] transition-colors hover:text-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ds-ring)]"
          >
            <span>{t('agents.configureExperience') || 'Configure experience'}</span>
            <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </Card>

      {/* 4. Performance Card */}
      <Card className="flex flex-col justify-between p-4">
        <div className="space-y-3">
          <SectionHeader
            title={
              <span className="flex items-center gap-2 text-[13px] font-semibold text-[var(--ds-text)]">
                <TrendingUp size={15} className="text-[var(--ds-accent)]" aria-hidden="true" />
                {t('agents.7DayPerformance') || '7-day performance'}
              </span>
            }
            description={t('agents.resolutionRateAndSatisfactionRatings') || 'Resolution rate and satisfaction ratings.'}
          />

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-[var(--ds-surface-elevated)] p-3 ring-1 ring-[var(--ds-border)]">
              <div className="text-[11px] font-medium text-[var(--ds-text-subtle)]">{t('agents.resolutionRate') || 'Resolution rate'}</div>
              <div className="mt-0.5 text-lg font-bold text-[var(--ds-text)]">
                {stats?.resolutionRate === null || stats?.resolutionRate === undefined
                  ? '-'
                  : `${stats.resolutionRate}%`}
              </div>
              <p className="mt-0.5 text-[11px] text-[var(--ds-text-muted)]">
                {stats?.resolutionRate === null || stats?.resolutionRate === undefined
                  ? t('agents.noResolvedConversationsYet') || 'No resolved conversations yet'
                  : t('agents.automatedResolution') || 'Automated resolution'}
              </p>
            </div>

            <div className="rounded-lg bg-[var(--ds-surface-elevated)] p-3 ring-1 ring-[var(--ds-border)]">
              <div className="text-[11px] font-medium text-[var(--ds-text-subtle)]">{t('agents.averageRating') || 'Average rating'}</div>
              <div className="mt-0.5 text-lg font-bold text-[var(--ds-text)]">
                {stats?.averageRating === null || stats?.averageRating === undefined
                  ? '-'
                  : `${stats.averageRating} / 5`}
              </div>
              <p className="mt-0.5 text-[11px] text-[var(--ds-text-muted)]">
                {stats?.averageRating === null || stats?.averageRating === undefined
                  ? t('agents.noRatingsYet') || 'No ratings yet'
                  : t('agents.visitorSatisfaction') || 'Visitor satisfaction'}
              </p>
            </div>
          </div>

          {activity.length > 0 && (
            <div className="pt-1">
              <ActivityTrend points={activity} />
            </div>
          )}
        </div>

        <div className="mt-4 border-t border-[var(--ds-border)] pt-3">
          <Link
            to={`${agentBasePath}/analytics`}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ds-accent)] transition-colors hover:text-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ds-ring)]"
          >
            <span>{t('agents.viewAnalytics') || 'View analytics'}</span>
            <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </Card>
    </div>
  );
}
