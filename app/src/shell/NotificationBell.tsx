import { useState } from 'react';
import { Bell, Check, Inbox } from 'lucide-react';
import {
  Button,
  EmptyState,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  SegmentedControl,
  Tooltip,
  cn,
  formatRelative,
} from '../ui';
import { useNotifications } from '../context/NotificationContext';

/**
 * The notification bell.
 *
 * A `Popover`, not a `Menu`. The panel holds a scrollable feed with a "mark all
 * read" control and rows that are links — `role="menu"` would oblige every child
 * to be a `menuitem`, which the previous bell claimed and was not.
 *
 * The unread badge shows a count, not a dot: "you have things waiting" and "you
 * have eleven things waiting" are different facts, and an operator deciding
 * whether to stop what they are doing needs the second one.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { items, unreadCount, connected, markAllRead, markRead } = useNotifications();
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const visible = showUnreadOnly ? items.filter((item) => !item.is_read) : items;

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <Tooltip content="Notifications" disabled={open}>
        <PopoverTrigger
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
          className={cn(
            'relative flex h-control-sm w-control-sm items-center justify-center rounded-md',
            'text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary',
          )}
        >
          <Bell aria-hidden className="h-4 w-4" />
          {unreadCount > 0 ? (
            <span
              aria-hidden
              className="figure absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-500 px-1 text-2xs font-medium text-text-inverse"
            >
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          ) : null}
        </PopoverTrigger>
      </Tooltip>

      <PopoverContent align="end" className="w-80">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <p className="text-base font-semibold text-text-primary">Notifications</p>
          {unreadCount > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void markAllRead()}
              iconLeft={<Check aria-hidden className="h-3.5 w-3.5" />}
            >
              Mark all read
            </Button>
          ) : null}
        </div>

        {/* Filters what is loaded, not what exists — the popover holds the
            latest thirty. Saying so is the difference between a filter and a
            claim about the account. */}
        <div className="border-b border-border px-3 py-2">
          <SegmentedControl
            size="sm"
            label="Which notifications to show"
            value={showUnreadOnly ? 'unread' : 'all'}
            onChange={(next) => setShowUnreadOnly(next === 'unread')}
            items={[
              { value: 'all', label: 'All', count: items.length },
              { value: 'unread', label: 'Unread', count: items.filter((item) => !item.is_read).length },
            ]}
          />
        </div>

        {visible.length === 0 ? (
          <EmptyState
            compact
            icon={Inbox}
            title={showUnreadOnly ? 'Nothing unread' : 'Nothing new'}
            description={
              showUnreadOnly
                ? 'Everything in the latest thirty has been read.'
                : connected
                  ? 'Handoffs, offline messages and billing events land here.'
                  : 'Reconnecting — anything that arrives will appear here.'
            }
          />
        ) : (
          <ul className="max-h-96 overflow-y-auto py-1">
            {visible.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!item.is_read) void markRead(item.id);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors',
                    'hover:bg-surface-hover',
                    !item.is_read && 'bg-accent-50',
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                      item.is_read ? 'bg-transparent' : 'bg-accent-500',
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-text-primary">{item.title}</span>
                    {item.body ? (
                      <span className="mt-0.5 block text-xs leading-relaxed text-text-secondary">
                        {item.body}
                      </span>
                    ) : null}
                    <span className="mt-1 block text-2xs text-text-tertiary">
                      {formatRelative(item.created_at)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </PopoverRoot>
  );
}
