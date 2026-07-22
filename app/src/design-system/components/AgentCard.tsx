import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge, type StatusBadgeProps } from '../primitives/Badge';
import { cn } from '../lib/cn';

export interface AgentCardStatus {
  label: string;
  tone?: StatusBadgeProps['tone'];
}

export interface AgentCardMetric {
  label: string;
  value: ReactNode;
}

interface AgentCardBaseProps {
  /** Agent name. */
  name: string;
  /** Health / lifecycle status shown as a badge. */
  status: AgentCardStatus;
  /** Up to a few headline figures rendered in a row (e.g. chats, leads). */
  metrics?: AgentCardMetric[];
  /** Avatar / logo image URL. Falls back to the name's initial. */
  avatar?: string;
  className?: string;
}

/** AgentCard needs exactly one target: a route (`to`) or a click handler. */
export type AgentCardProps = AgentCardBaseProps &
  ({ to: string; onClick?: never } | { onClick: () => void; to?: never });

function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || '?';
}

/**
 * AgentCard — one AI agent as a tile in a grid (mandate shared component).
 * Shows identity, status, and a compact metrics row; the whole card navigates
 * to the agent. Renders as a router `<Link>` when `to` is given, else a
 * `<button>`.
 */
export function AgentCard({
  name,
  status,
  metrics,
  avatar,
  className,
  ...target
}: AgentCardProps) {
  const inner = (
    <>
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--ds-bg-sunken)] text-[15px] font-semibold text-[var(--ds-text-muted)]">
          {avatar ? (
            <img src={avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            <span aria-hidden="true">{initial(name)}</span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold text-[var(--ds-text)]">
            {name}
          </span>
          <span className="mt-1 inline-flex">
            <StatusBadge tone={status.tone} dot>
              {status.label}
            </StatusBadge>
          </span>
        </div>
      </div>
      {metrics && metrics.length > 0 && (
        <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-[var(--ds-border)] pt-4">
          {metrics.map((metric) => (
            <div key={metric.label} className="min-w-0">
              <dt className="text-[11px] font-medium text-[var(--ds-text-subtle)]">
                {metric.label}
              </dt>
              <dd className="mt-0.5 text-[15px] font-semibold text-[var(--ds-text)]">
                {metric.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );

  const classes = cn(
    'block w-full rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 text-left shadow-[var(--ds-shadow-sm)] transition-colors hover:border-[var(--ds-border-strong)] hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
    className,
  );

  if ('to' in target && target.to !== undefined) {
    return (
      <Link to={target.to} className={classes} aria-label={name}>
        {inner}
      </Link>
    );
  }

  return (
    <button type="button" onClick={target.onClick} className={classes} aria-label={name}>
      {inner}
    </button>
  );
}
