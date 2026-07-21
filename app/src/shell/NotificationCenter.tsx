import { useEffect, useRef, useState } from 'react';
import { Bell, BellRing } from 'lucide-react';
import { cn, EmptyState } from '../design-system';

/**
 * Notification Center — PLACEHOLDER (Phase 1).
 * A bell trigger with an unread badge and a dropdown panel. The real
 * notification stream (live-chat handoffs, lead alerts, billing events, feedback
 * replies) is wired in a later phase; for now the panel shows an empty state and
 * `unreadCount` is always 0. Structured so the future NotificationProvider can
 * feed it without changing this component's shape.
 */
export function NotificationCenter({ unreadCount = 0 }: { unreadCount?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const hasUnread = unreadCount > 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={hasUnread ? `Notifications (${unreadCount} unread)` : 'Notifications'}
        aria-expanded={open}
        className={cn(
          'relative flex h-9 w-9 items-center justify-center rounded-lg text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]',
          open && 'bg-[var(--ds-bg-hover)] text-[var(--ds-text)]',
        )}
      >
        {hasUnread ? <BellRing size={18} /> : <Bell size={18} />}
        {hasUnread && (
          <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold leading-none text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-50 w-80 overflow-hidden rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)]">
          <div className="flex items-center justify-between border-b border-[var(--ds-border)] px-4 py-3">
            <span className="text-sm font-semibold text-[var(--ds-text)]">Notifications</span>
          </div>
          <div className="p-3">
            <EmptyState
              icon={Bell}
              title="You're all caught up"
              description="Handoffs, new leads and billing alerts will appear here."
              className="border-0 px-2 py-8"
            />
          </div>
        </div>
      )}
    </div>
  );
}
