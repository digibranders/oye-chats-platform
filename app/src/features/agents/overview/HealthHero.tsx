import { type ReactElement } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Loader2,
  Minus,
  ShieldCheck,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, StatusBadge, type StatusBadgeProps, cn } from '../../../design-system';
import {
  type AgentHealth,
  type CheckStatus,
  type HealthCheck,
  type HealthLevel,
} from './agent-health';

/** Visual treatment per overall health level. */
const LEVEL_STYLE: Record<
  HealthLevel,
  { icon: LucideIcon; iconBg: string; iconText: string; badge: StatusBadgeProps['tone']; badgeLabel: string }
> = {
  healthy: {
    icon: ShieldCheck,
    iconBg: 'bg-[var(--ds-success-soft)]',
    iconText: 'text-[var(--ds-success)]',
    badge: 'success',
    badgeLabel: 'Healthy',
  },
  training: {
    icon: Loader2,
    iconBg: 'bg-[var(--ds-info-soft)]',
    iconText: 'text-[var(--ds-info)]',
    badge: 'info',
    badgeLabel: 'Learning',
  },
  attention: {
    icon: AlertTriangle,
    iconBg: 'bg-[var(--ds-warning-soft)]',
    iconText: 'text-[var(--ds-warning)]',
    badge: 'warning',
    badgeLabel: 'Almost ready',
  },
  setup: {
    icon: AlertTriangle,
    iconBg: 'bg-[var(--ds-warning-soft)]',
    iconText: 'text-[var(--ds-warning)]',
    badge: 'warning',
    badgeLabel: 'Setup needed',
  },
  critical: {
    icon: AlertTriangle,
    iconBg: 'bg-[var(--ds-danger-soft)]',
    iconText: 'text-[var(--ds-danger)]',
    badge: 'danger',
    badgeLabel: 'Needs attention',
  },
};

/** Per-check marker treatment. */
const CHECK_STYLE: Record<
  CheckStatus,
  { icon: LucideIcon; iconBg: string; iconText: string; spin?: boolean; srLabel: string }
> = {
  pass: {
    icon: Check,
    iconBg: 'bg-[var(--ds-success-soft)]',
    iconText: 'text-[var(--ds-success)]',
    srLabel: 'Passing',
  },
  warn: {
    icon: Minus,
    iconBg: 'bg-[var(--ds-warning-soft)]',
    iconText: 'text-[var(--ds-warning)]',
    srLabel: 'Needs action',
  },
  fail: {
    icon: X,
    iconBg: 'bg-[var(--ds-danger-soft)]',
    iconText: 'text-[var(--ds-danger)]',
    srLabel: 'Failing',
  },
  pending: {
    icon: Loader2,
    iconBg: 'bg-[var(--ds-info-soft)]',
    iconText: 'text-[var(--ds-info)]',
    spin: true,
    srLabel: 'In progress',
  },
};

interface HealthCheckRowProps {
  readonly check: HealthCheck;
}

function HealthCheckRow({ check }: HealthCheckRowProps): ReactElement {
  const style = CHECK_STYLE[check.status];
  const Icon = style.icon;
  return (
    <li className="flex items-start gap-3">
      <span
        className={cn(
          'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
          style.iconBg,
          style.iconText,
        )}
      >
        <Icon size={14} aria-hidden="true" className={style.spin ? 'animate-spin' : undefined} />
        <span className="sr-only">{style.srLabel}:</span>
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-[var(--ds-text)]">{check.label}</span>
        <span className="block text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
          {check.detail}
        </span>
      </span>
    </li>
  );
}

export interface HealthHeroProps {
  readonly health: AgentHealth;
  /** Base path of the current agent, e.g. `/agents/12`. Used to build next-step links. */
  readonly agentBasePath: string;
}

/**
 * HealthHero - the page's answer to "Is my AI healthy?". A prominent status
 * card: a tinted glyph, a headline verdict, a per-area checklist, and (when
 * something needs doing) a single next-step action.
 */
export function HealthHero({ health, agentBasePath }: HealthHeroProps): ReactElement {
  const style = LEVEL_STYLE[health.level];
  const Icon = style.icon;

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <span
          className={cn(
            'flex h-12 w-12 shrink-0 items-center justify-center rounded-xl',
            style.iconBg,
            style.iconText,
          )}
        >
          <Icon
            size={24}
            aria-hidden="true"
            className={health.level === 'training' ? 'animate-spin' : undefined}
          />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-lg font-bold tracking-tight text-[var(--ds-text)]">
              {health.title}
            </h2>
            <StatusBadge tone={style.badge} dot>
              {style.badgeLabel}
            </StatusBadge>
          </div>
          <p className="mt-1.5 text-[14px] leading-relaxed text-[var(--ds-text-muted)]">
            {health.description}
          </p>

          <ul className="mt-5 flex flex-col gap-3.5">
            {health.checks.map((check) => (
              <HealthCheckRow key={check.id} check={check} />
            ))}
          </ul>

          {health.nextStep && (
            <Link
              to={`${agentBasePath}/${health.nextStep.to}`}
              className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[var(--ds-accent)] px-4 py-2 text-[13px] font-semibold text-[var(--ds-accent-fg)] transition-colors hover:bg-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
            >
              {health.nextStep.label}
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}
