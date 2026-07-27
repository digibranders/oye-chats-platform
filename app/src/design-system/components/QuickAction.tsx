import { type LucideIcon } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '../lib/cn';

interface QuickActionBaseProps {
  /** Leading glyph. */
  icon: LucideIcon;
  /** Short label, e.g. "New agent". */
  label: string;
  className?: string;
}

/** QuickAction needs exactly one target: a route (`to`) or a click handler. */
export type QuickActionProps = QuickActionBaseProps &
  ({ to: string; onClick?: never } | { onClick: () => void; to?: never });

/**
 * QuickAction — a compact action chip (mandate shared component). Sits in
 * toolbars and quick-action rows. Renders as a router `<Link>` when `to` is
 * given, otherwise a `<button>`.
 */
export function QuickAction({ icon: Icon, label, className, ...target }: QuickActionProps) {
  const inner = (
    <>
      <Icon size={16} aria-hidden="true" className="text-[var(--ds-text-subtle)]" />
      {label}
    </>
  );

  const classes = cn(
    'inline-flex items-center gap-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-2 text-[13px] font-medium text-[var(--ds-text)] transition-colors hover:border-[var(--ds-border-strong)] hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
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
