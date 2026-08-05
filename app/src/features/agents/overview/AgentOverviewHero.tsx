import { type ReactElement } from 'react';
import { ExternalLink, SlidersHorizontal, Wand2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, StatusBadge, type StatusBadgeProps } from '../../../design-system';
import { useWorkspace } from '../../../context/WorkspaceContext';
import { type Bot } from '../../../types/domain';
import { hasLaunchProgress, resumeLaunchPath } from '../../launch-studio/resume';
import { type AgentHealth } from './agent-health';

export interface AgentOverviewHeroProps {
  readonly agent: Bot;
  readonly health: AgentHealth;
  readonly agentBasePath: string;
}

const BADGE_TONE_BY_HEALTH_LEVEL: Record<AgentHealth['level'], StatusBadgeProps['tone']> = {
  healthy: 'success',
  training: 'info',
  attention: 'warning',
  setup: 'warning',
  critical: 'danger',
};

const BADGE_LABEL_BY_HEALTH_LEVEL: Record<AgentHealth['level'], string> = {
  healthy: 'Live & Active',
  training: 'Training',
  attention: 'Needs Attention',
  setup: 'Setup Needed',
  critical: 'Needs Attention',
};

function formatCreatedDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function AgentOverviewHero({
  agent,
  health,
  agentBasePath,
}: AgentOverviewHeroProps): ReactElement {
  const { currentWorkspaceId } = useWorkspace();
  const createdDate = formatCreatedDate(agent.created_at);
  const initial = agent.name ? agent.name.charAt(0).toUpperCase() : 'A';
  // The "Setup Needed" badge is exactly where a half-finished agent surfaces,
  // so it's where the way back into guided setup belongs. Offered only while
  // setup is genuinely outstanding - a healthy agent shouldn't be nudged back
  // into onboarding it already completed - AND only when the saved progress
  // belongs to THIS agent in THIS workspace. Launch Studio writes through the
  // shell switcher's `selectedBot`, which is not synced to the URL, so an
  // unscoped button here resumed onboarding against a different agent and
  // renamed / re-crawled it.
  const needsSetup = health.level === 'setup' && hasLaunchProgress(currentWorkspaceId, agent.id);

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          {agent.bot_logo ? (
            <img
              src={agent.bot_logo}
              alt=""
              className="h-14 w-14 rounded-2xl object-cover ring-1 ring-[var(--ds-border)]"
            />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[var(--ds-accent-soft)] text-xl font-bold text-[var(--ds-accent)] ring-1 ring-[var(--ds-border)]">
              {initial}
            </div>
          )}

          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl font-bold tracking-tight text-[var(--ds-text)]">
                {agent.name}
              </h1>
              <StatusBadge tone={BADGE_TONE_BY_HEALTH_LEVEL[health.level]} dot>
                {BADGE_LABEL_BY_HEALTH_LEVEL[health.level]}
              </StatusBadge>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-[13px] text-[var(--ds-text-muted)]">
              {createdDate && <span>Created {createdDate}</span>}
              {createdDate && agent.website && <span aria-hidden="true">•</span>}
              {agent.website && (
                <a
                  href={agent.website}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-[var(--ds-text-subtle)] transition-colors hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ds-ring)]"
                >
                  <span>{agent.website.replace(/^https?:\/\//, '')}</span>
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              )}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {needsSetup && (
            <Link
              to={resumeLaunchPath()}
              className="inline-flex items-center gap-2 rounded-lg bg-[var(--ds-accent)] px-4 py-2 text-[13px] font-semibold text-[var(--ds-accent-fg)] shadow-[var(--ds-shadow-sm)] transition-colors hover:bg-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]"
            >
              <Wand2 size={15} aria-hidden="true" />
              <span>Resume setup</span>
            </Link>
          )}
          <Link
            to={`${agentBasePath}/experience`}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface-elevated)] px-4 py-2 text-[13px] font-semibold text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]"
          >
            <SlidersHorizontal size={15} aria-hidden="true" />
            <span>Edit experience</span>
          </Link>
        </div>
      </div>
    </Card>
  );
}
