import { type ReactElement } from 'react';
import { ExternalLink, SlidersHorizontal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { BotAvatar, Card, StatusBadge, type StatusBadgeProps } from '../../../design-system';
import { type Bot } from '../../../types/domain';
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
  const createdDate = formatCreatedDate(agent.created_at);

  return (
    <Card className="p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <BotAvatar
            bot={agent}
            size={40}
            radius="xl"
            className="ring-1 ring-[var(--ds-border)]"
          />

          <div className="min-w-0 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[15px] font-semibold tracking-tight text-[var(--ds-text)]">
                {agent.name}
              </h1>
              <StatusBadge tone={BADGE_TONE_BY_HEALTH_LEVEL[health.level]} dot>
                {BADGE_LABEL_BY_HEALTH_LEVEL[health.level]}
              </StatusBadge>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-[12px] text-[var(--ds-text-muted)]">
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

        <div className="shrink-0">
          <Link
            to={`${agentBasePath}/experience`}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface-elevated)] px-3 py-1.5 text-[13px] font-semibold text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]"
          >
            <SlidersHorizontal size={14} aria-hidden="true" />
            <span>Edit experience</span>
          </Link>
        </div>
      </div>
    </Card>
  );
}
