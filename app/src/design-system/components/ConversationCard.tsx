import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { StatusBadge, type StatusBadgeProps } from '../primitives/Badge';
import { cn } from '../lib/cn';

export interface ConversationStatus {
  label: string;
  tone?: StatusBadgeProps['tone'];
}

export interface ConversationCardProps {
  /** Visitor / contact name or identifier. */
  name: string;
  /** Preview of the latest message. Truncated to one line. */
  snippet: ReactNode;
  /** Pre-formatted relative time, e.g. "2m ago". */
  time: string;
  /** Emphasize the row for an unread conversation. */
  unread?: boolean;
  /** Optional lifecycle status (e.g. "Live", "Waiting"). */
  status?: ConversationStatus;
  /** In-app route to open the conversation. Renders the row as a link. */
  to?: string;
  /** Click handler (used when `to` is not supplied). */
  onClick?: () => void;
  /**
   * Marks the row as the active conversation for assistive tech - forwarded to
   * `aria-current` on the underlying link/button. Use `"page"` (or `true`) when
   * this row's conversation is the one currently open in the detail pane.
   */
  ariaCurrent?: boolean | 'page';
  className?: string;
}

/**
 * ConversationCard - one conversation as a row in an inbox list (mandate shared
 * component). Renders as a router `<Link>` when `to` is given, a `<button>`
 * when `onClick` is given, otherwise a static row.
 */
export function ConversationCard({
  name,
  snippet,
  time,
  unread = false,
  status,
  to,
  onClick,
  ariaCurrent,
  className,
}: ConversationCardProps) {
  const inner = (
    <>
      <span
        aria-hidden="true"
        className={cn(
          'mt-1.5 h-2 w-2 shrink-0 rounded-full',
          unread ? 'bg-[var(--ds-accent)]' : 'bg-transparent',
        )}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span
            className={cn(
              'truncate text-[14px]',
              unread ? 'font-semibold text-[var(--ds-text)]' : 'font-medium text-[var(--ds-text)]',
            )}
          >
            {name}
          </span>
          <span className="shrink-0 text-[12px] text-[var(--ds-text-subtle)]">{time}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-[13px]',
              unread ? 'text-[var(--ds-text-muted)]' : 'text-[var(--ds-text-subtle)]',
            )}
          >
            {snippet}
          </span>
          {status && (
            <StatusBadge tone={status.tone} className="shrink-0">
              {status.label}
            </StatusBadge>
          )}
        </span>
      </span>
    </>
  );

  const classes = cn(
    'flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors',
    (to || onClick) &&
      'hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
    unread && 'bg-[var(--ds-accent-soft)]',
    className,
  );

  if (to) {
    return (
      <Link to={to} className={classes} aria-label={name} aria-current={ariaCurrent}>
        {inner}
      </Link>
    );
  }

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={classes}
        aria-label={name}
        aria-current={ariaCurrent}
      >
        {inner}
      </button>
    );
  }

  return <div className={classes}>{inner}</div>;
}
