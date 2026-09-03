import { useState } from 'react';
import { Link } from 'react-router-dom';
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
  formatBadgeCount,
  formatRelative,
} from '../ui';
import { useNotifications } from '../context/NotificationContext';
import { useTranslation } from '../i18n/useTranslation';

/**
 * The notification bell.
 *
 * A `Popover`, not a `Menu`. The panel holds a scrollable feed with a "mark all
 * read" control and rows that are links — `role="menu"` would oblige every child
 * to be a `menuitem`, which the previous bell claimed and was not.
 *
 * The unread badge shows a count, not a dot: "you have things waiting" and "you
 * have eleven things waiting" are different facts, and an operator deciding
 * whether to stop what they are doing needs the second one. It caps at 99, the
 * same as the rail's — the bell used to cap at 9 while the rail printed the raw
 * number, so fourteen waiting conversations read as "9+" in one place and "14"
 * in the other.
 *
 * **Only the list scrolls.** `PopoverContent` is already a bounded column, and
 * putting `max-h-96 overflow-y-auto` on the `<ul>` inside it made two nested
 * scrollers: on a short viewport the outer one engaged and the header and the
 * filter — the two controls that must stay put — scrolled out of the panel.
 *
 * **Unread is weight, not a tint.** The rows were painted `bg-accent-50`, which
 * `tokens.css` reserves for selection, so one fact carried two blue signals and
 * one of them was borrowed from another meaning. The dot stays; the panel now
 * has exactly one blue thing in it and it means unread.
 */
export function NotificationBell() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { items, unreadCount, connected, markAllRead, markRead } = useNotifications();
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const visible = showUnreadOnly ? items.filter((item) => !item.is_read) : items;

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <Tooltip content="Notifications" disabled={open}>
        <PopoverTrigger
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : t('shell.notificationsTitle') || 'Notifications'}
          className={cn(
            'relative flex h-control-sm w-control-sm items-center justify-center rounded-md',
            'text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary',
          )}
        >
          <Bell aria-hidden className="h-icon-md w-icon-md" />
          {unreadCount > 0 ? (
            <span
              aria-hidden
              className="figure absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-500 px-1 text-2xs font-medium text-text-inverse"
            >
              {formatBadgeCount(unreadCount)}
            </span>
          ) : null}
        </PopoverTrigger>
      </Tooltip>

      <PopoverContent align="end" className="w-80">
        {/* One row, not two bands. A title, a filter and an action used to cost
            88px above the first notification in a 320px panel — and the title
            said what the bell's own accessible name already says. */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <SegmentedControl
            size="sm"
            fill
            className="min-w-0 flex-1"
            label={t('shell.whichNotificationsToShow') || 'Which notifications to show'}
            value={showUnreadOnly ? 'unread' : 'all'}
            onChange={(next) => setShowUnreadOnly(next === 'unread')}
            items={[
              { value: 'all', label: t('shell.all') || 'All', count: items.length },
              { value: 'unread', label: t('shell.unread') || 'Unread', count: items.filter((item) => !item.is_read).length },
            ]}
          />
          {unreadCount > 0 ? (
            <Tooltip content="Mark all read">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t('shell.markAllRead') || 'Mark all read'}
                onClick={() => void markAllRead()}
              >
                <Check aria-hidden />
              </Button>
            </Tooltip>
          ) : null}
        </div>

        {visible.length === 0 ? (
          <EmptyState
            size="panel"
            icon={Inbox}
            title={showUnreadOnly ? t('shell.nothingUnread') || 'Nothing unread' : t('shell.nothingNew') || 'Nothing new'}
            description={
              showUnreadOnly
                ? t('shell.everythingInTheLatestThirty') || 'Everything in the latest thirty has been read.'
                : connected
                  ? t('shell.handoffsOfflineMessagesAndBilling') || 'Handoffs, offline messages and billing events land here.'
                  : t('shell.reconnectingAnythingThatArrivesWill') || 'Reconnecting. Anything that arrives will appear here.'
            }
          />
        ) : (
          <ul className="min-h-0 flex-1 overflow-y-auto py-1">
            {visible.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    if (!item.is_read) void markRead(item.id);
                    setOpen(false);
                  }}
                  className="flex w-full items-start gap-2.5 px-3 py-2 text-start transition-colors hover:bg-surface-hover"
                >
                  {/* A 20px box matching the title's line box, so the dot is
                      optically centred on the first line whatever rung it is. */}
                  <span aria-hidden className="flex h-5 w-1.5 shrink-0 items-center">
                    <span
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        item.is_read ? 'bg-transparent' : 'bg-accent-500',
                      )}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block text-sm',
                        item.is_read
                          ? 'font-normal text-text-secondary'
                          : 'font-semibold text-text-primary',
                      )}
                    >
                      {item.title}
                    </span>
                    {item.body ? (
                      <span className="mt-0.5 block text-xs text-text-secondary">{item.body}</span>
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

        {/* The panel holds the latest thirty and used to say so only inside the
            empty state, so a reader with a full panel had no idea there was a
            boundary and nowhere to go past it. */}
        <Link
          to="/inbox"
          onClick={() => setOpen(false)}
          className="block shrink-0 border-t border-border px-3 py-2 text-center text-xs text-accent-600 transition-colors hover:bg-surface-hover"
        >
          {t('shell.openTheInbox') || 'Open the inbox'}
        </Link>
      </PopoverContent>
    </PopoverRoot>
  );
}
