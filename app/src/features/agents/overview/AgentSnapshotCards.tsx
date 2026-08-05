import { type ReactElement } from 'react';
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
  const chunkCount = agent.indexed_chunk_count ?? 0;
  const isInstalled = Boolean(agent.widget_installed_at);
  const crawlStatus = agent.last_crawl_status;

  let knowledgeStatusText = 'Not trained';
  let knowledgeTone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' = 'neutral';

  if (crawlStatus === 'running') {
    knowledgeStatusText = 'Training now';
    knowledgeTone = 'info';
  } else if (crawlStatus === 'failed' || crawlStatus === 'no_content') {
    knowledgeStatusText = 'Needs attention';
    knowledgeTone = 'danger';
  } else if (chunkCount > 0) {
    knowledgeStatusText = 'Ready';
    knowledgeTone = 'success';
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
                  Knowledge base
                </span>
              }
              description="Trained sources and passages."
            />
            <StatusBadge tone={knowledgeTone} dot>
              {knowledgeStatusText}
            </StatusBadge>
          </div>

          <div className="rounded-lg bg-[var(--ds-surface-elevated)] p-3 ring-1 ring-[var(--ds-border)]">
            <div className="text-lg font-bold text-[var(--ds-text)]">
              {chunkCount > 0 ? `${chunkCount.toLocaleString()} passages` : 'Not trained yet'}
            </div>
            <p className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">
              {chunkCount > 0
                ? 'Indexed and ready for visitor questions.'
                : 'Add website links or documents to start training.'}
            </p>
          </div>
        </div>

        <div className="mt-4 border-t border-[var(--ds-border)] pt-3">
          <Link
            to={`${agentBasePath}/knowledge`}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ds-accent)] transition-colors hover:text-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ds-ring)]"
          >
            <span>Manage knowledge</span>
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
                  Deployment channels
                </span>
              }
              description="Active channels and website widget."
            />
            <StatusBadge tone={isInstalled ? 'success' : 'neutral'} dot>
              {isInstalled ? 'Live' : 'Not installed'}
            </StatusBadge>
          </div>

          <div className="rounded-lg bg-[var(--ds-surface-elevated)] p-3 ring-1 ring-[var(--ds-border)]">
            <div className="text-[13px] font-semibold text-[var(--ds-text)]">Website Chat Widget</div>
            <p className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">
              {isInstalled
                ? agent.website
                  ? `Active on ${agent.website.replace(/^https?:\/\//, '')}`
                  : 'Installed and answering live visitors.'
                : 'Embed code ready to copy into your site.'}
            </p>
          </div>
        </div>

        <div className="mt-4 border-t border-[var(--ds-border)] pt-3">
          <Link
            to={`${agentBasePath}/channels`}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ds-accent)] transition-colors hover:text-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ds-ring)]"
          >
            <span>Manage channels</span>
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
                AI personality & experience
              </span>
            }
            description="Brand tone, styling, and behavior."
          />

          <div className="rounded-lg bg-[var(--ds-surface-elevated)] p-3 ring-1 ring-[var(--ds-border)]">
            <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--ds-text-subtle)]">
              Brand Tone
            </div>
            <div className="mt-0.5 text-[13px] font-semibold text-[var(--ds-text)]">
              {brandTone || 'Configured in Experience'}
            </div>
            <p className="mt-0.5 text-[12px] text-[var(--ds-text-muted)]">
              Defines response style and conversation guardrails.
            </p>
          </div>
        </div>

        <div className="mt-4 border-t border-[var(--ds-border)] pt-3">
          <Link
            to={`${agentBasePath}/experience`}
            className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--ds-accent)] transition-colors hover:text-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ds-ring)]"
          >
            <span>Configure experience</span>
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
                7-day performance
              </span>
            }
            description="Resolution rate and satisfaction ratings."
          />

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg bg-[var(--ds-surface-elevated)] p-3 ring-1 ring-[var(--ds-border)]">
              <div className="text-[11px] font-medium text-[var(--ds-text-subtle)]">Resolution rate</div>
              <div className="mt-0.5 text-lg font-bold text-[var(--ds-text)]">
                {stats?.resolutionRate === null || stats?.resolutionRate === undefined
                  ? '-'
                  : `${stats.resolutionRate}%`}
              </div>
              <p className="mt-0.5 text-[11px] text-[var(--ds-text-muted)]">
                {stats?.resolutionRate === null || stats?.resolutionRate === undefined
                  ? 'No resolved conversations yet'
                  : 'Automated resolution'}
              </p>
            </div>

            <div className="rounded-lg bg-[var(--ds-surface-elevated)] p-3 ring-1 ring-[var(--ds-border)]">
              <div className="text-[11px] font-medium text-[var(--ds-text-subtle)]">Average rating</div>
              <div className="mt-0.5 text-lg font-bold text-[var(--ds-text)]">
                {stats?.averageRating === null || stats?.averageRating === undefined
                  ? '-'
                  : `${stats.averageRating} / 5`}
              </div>
              <p className="mt-0.5 text-[11px] text-[var(--ds-text-muted)]">
                {stats?.averageRating === null || stats?.averageRating === undefined
                  ? 'No ratings yet'
                  : 'Visitor satisfaction'}
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
            <span>View analytics</span>
            <ArrowUpRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </Card>
    </div>
  );
}
