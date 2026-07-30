import { ArrowRight, type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/cn';

interface ActionCardBaseProps {
  /** The action, e.g. "Train your AI". */
  title: string;
  /** One line on what happens / why it matters. */
  description: string;
  /** Leading glyph (required - an action always has a visual anchor). */
  icon: LucideIcon;
  /** Optional explicit call-to-action label. Defaults to `title`. */
  cta?: string;
  className?: string;
}

/**
 * ActionCard requires exactly one navigation target: an in-app route (`to`)
 * OR a click handler (`onClick`) - never both, never neither.
 */
export type ActionCardProps = ActionCardBaseProps &
  ({ to: string; onClick?: never } | { onClick: () => void; to?: never });

/**
 * ActionCard - a clickable "next action" tile (mandate shared component). The
 * whole surface is the target. Renders as a router `<Link>` when `to` is given,
 * otherwise a `<button>`.
 */
export function ActionCard({
  title,
  description,
  icon: Icon,
  cta,
  className,
  ...target
}: ActionCardProps) {
  const label = cta ?? title;

  const inner = (
    <>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)] transition-colors group-hover:bg-[var(--ds-accent)] group-hover:text-[var(--ds-accent-fg)]">
        <Icon size={20} aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold text-[var(--ds-text)]">{title}</span>
        <span className="mt-0.5 block text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
          {description}
        </span>
        <span className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-[var(--ds-accent-text)]">
          {label}
          <ArrowRight
            size={14}
            aria-hidden="true"
            className="transition-transform group-hover:translate-x-0.5"
          />
        </span>
      </span>
    </>
  );

  const classes = cn(
    'group flex w-full items-start gap-4 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 text-left shadow-[var(--ds-shadow-sm)] transition-colors hover:border-[var(--ds-border-strong)] hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
    className,
  );

  if ('to' in target && target.to !== undefined) {
    return (
      <Link to={target.to} className={classes}>
        {inner}
      </Link>
    );
  }

  return (
    <button type="button" onClick={target.onClick} className={classes}>
      {inner}
    </button>
  );
}
