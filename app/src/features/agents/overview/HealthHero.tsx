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
import { Card, IconTile, StatusBadge, type IconTileTone, type StatusBadgeProps } from '../../../design-system';
import {
  type AgentHealth,
  type CheckStatus,
  type HealthCheck,
  type HealthLevel,
} from './agent-health';
import { useTranslation } from '../../../i18n/useTranslation';

// Visual treatment per overall health level. Built at import, before a locale
// exists, so the English label here is the fallback and the render site below
// resolves the real one from the level key.
/** Visual treatment per overall health level. */
// @i18n-exempt: resolved at the render site from the level key
// (`agents.health.level.<level>`); the English here is that lookup's fallback.
const LEVEL_STYLE: Record<
  HealthLevel,
  { icon: LucideIcon; tone: IconTileTone; spin?: boolean; badge: StatusBadgeProps['tone']; badgeLabel: string }
> = {
  healthy: { icon: ShieldCheck, tone: 'success', badge: 'success', badgeLabel: 'Healthy' },
  training: { icon: Loader2, tone: 'info', spin: true, badge: 'info', badgeLabel: 'Learning' },
  attention: { icon: AlertTriangle, tone: 'warning', badge: 'warning', badgeLabel: 'Almost ready' },
  setup: { icon: AlertTriangle, tone: 'warning', badge: 'warning', badgeLabel: 'Setup needed' },
  critical: { icon: AlertTriangle, tone: 'danger', badge: 'danger', badgeLabel: 'Needs attention' },
};

// Same as LEVEL_STYLE: the icon and tone are design, the label is copy, and
// the label is resolved where it is rendered.
/** Per-check marker treatment. */
// @i18n-exempt: resolved at the render site from the check status
// (`agents.health.check.<status>`); the English here is that lookup's fallback.
const CHECK_STYLE: Record<
  CheckStatus,
  { icon: LucideIcon; tone: IconTileTone; spin?: boolean; srLabel: string }
> = {
  pass: { icon: Check, tone: 'success', srLabel: 'Passing' },
  warn: { icon: Minus, tone: 'warning', srLabel: 'Needs action' },
  fail: { icon: X, tone: 'danger', srLabel: 'Failing' },
  pending: { icon: Loader2, tone: 'info', spin: true, srLabel: 'In progress' },
};

interface HealthCheckRowProps {
  readonly check: HealthCheck;
}

function HealthCheckRow({ check }: HealthCheckRowProps): ReactElement {
  const { t } = useTranslation();
  const style = CHECK_STYLE[check.status];
  return (
    <li className="flex items-start gap-3">
      <IconTile
        icon={style.icon}
        tone={style.tone}
        size="xs"
        shape="circle"
        spin={style.spin}
        srLabel={`${t(`agents.health.check.${check.status}`) || style.srLabel}:`}
        className="mt-0.5"
      />
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
  const { t } = useTranslation();
  const style = LEVEL_STYLE[health.level];

  return (
    <Card className="p-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
        <IconTile icon={style.icon} tone={style.tone} size="lg" spin={style.spin} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-lg font-bold tracking-tight text-[var(--ds-text)]">
              {health.title}
            </h2>
            <StatusBadge tone={style.badge} dot>
              {t(`agents.health.level.${health.level}`) || style.badgeLabel}
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
