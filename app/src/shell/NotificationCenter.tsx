import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bell,
  BellRing,
  Bot as BotIcon,
  CheckCheck,
  CreditCard,
  Globe,
  Headphones,
  MailOpen,
  MessageSquare,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { cn, EmptyState, Popover, Skeleton } from '../design-system';
import { useNotifications } from '../context/NotificationContext';
import type { NotificationItem } from '../types/domain';
import { useTranslation } from '../i18n/useTranslation';

const MAX_BADGE = 99;

interface TypeMeta {
  icon: LucideIcon;
  wrapClassName: string;
}

// Schema-on-read on the backend (notification `type` isn't a DB enum), so an
// unrecognized type falls through to DEFAULT_META rather than erroring.
const TYPE_META: Record<string, TypeMeta> = {
  plan_purchased: { icon: CreditCard, wrapClassName: 'bg-[var(--ds-success-soft)] text-[var(--ds-success)]' },
  bot_created: { icon: BotIcon, wrapClassName: 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]' },
  offline_message_received: { icon: MailOpen, wrapClassName: 'bg-[var(--ds-warning-soft)] text-[var(--ds-warning)]' },
  handoff_request: { icon: Headphones, wrapClassName: 'bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]' },
  feedback_resolved: { icon: MessageSquare, wrapClassName: 'bg-[var(--ds-success-soft)] text-[var(--ds-success)]' },
  crawl_completed: { icon: Globe, wrapClassName: 'bg-[var(--ds-accent-soft)] text-[var(--ds-accent-text)]' },
  // Danger tone, not the generic bell: a failed payment ends in the customer's
  // agents going offline, so it must read as more urgent than an FYI.
  payment_failed: { icon: CreditCard, wrapClassName: 'bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]' },
};

const DEFAULT_META: TypeMeta = {
  icon: Bell,
  wrapClassName: 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]',
};

/** ISO timestamp → "3m ago" / "2h ago" / "Jul 16" for anything older than a week. */
function formatRelativeTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffSeconds = (Date.now() - date.getTime()) / 1000;
  if (diffSeconds < 5) return 'just now';
  if (diffSeconds < 60) return `${Math.floor(diffSeconds)}s ago`;
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`;
  if (diffSeconds < 86_400) return `${Math.floor(diffSeconds / 3600)}h ago`;
  if (diffSeconds < 7 * 86_400) return `${Math.floor(diffSeconds / 86_400)}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function isToday(iso: string | null): boolean {
  if (!iso) return false;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  return date.toDateString() === new Date().toDateString();
}

interface NotificationRowProps {
  item: NotificationItem;
  onSelect: () => void;
  onDismiss: () => void;
}

function NotificationRow({ item, onSelect, onDismiss }: NotificationRowProps) {
  const { t } = useTranslation();
  const meta = TYPE_META[item.type] ?? DEFAULT_META;
  const Icon = meta.icon;
  return (
    <div
      className={cn(
        'group relative flex gap-3 rounded-[var(--ds-radius-md)] px-2.5 py-2.5 transition-colors',
        item.is_read ? 'hover:bg-[var(--ds-bg-hover)]' : 'bg-[var(--ds-accent-soft)]',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-[var(--ds-radius-md)] text-left focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
      >
        <span
          className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', meta.wrapClassName)}
        >
          <Icon size={15} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {!item.is_read && (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ds-accent)]" aria-hidden="true" />
            )}
            <span className="truncate text-[13px] font-semibold text-[var(--ds-text)]">{item.title}</span>
          </span>
          {item.body && (
            <span className="mt-0.5 line-clamp-2 block text-[12px] text-[var(--ds-text-muted)]">{item.body}</span>
          )}
          <span className="mt-1 block text-[11px] text-[var(--ds-text-subtle)]">
            {formatRelativeTime(item.created_at)}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDismiss();
        }}
        aria-label={t('shell.notifications.dismissOne') || 'Dismiss notification'}
        className="absolute right-2 top-2 rounded-[var(--ds-radius-sm)] p-1 text-[var(--ds-text-subtle)] opacity-0 transition-opacity hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)] focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * NotificationCenter - the TopBar bell, wired to the live `NotificationProvider`
 * (`/ws/notifications` stream + REST fallback). `useNotifications()` returns a
 * safe all-empty shape when rendered outside the provider, so this never
 * crashes even on a route that doesn't wrap it.
 */
export function NotificationCenter() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { items, unreadCount, loading, markRead, markAllRead, dismiss, clearAll } = useNotifications();

  const hasUnread = unreadCount > 0;
  const badgeLabel = unreadCount > MAX_BADGE ? `${MAX_BADGE}+` : String(unreadCount);

  const { today, earlier } = useMemo(() => {
    const todayItems: NotificationItem[] = [];
    const earlierItems: NotificationItem[] = [];
    for (const item of items) {
      (isToday(item.created_at) ? todayItems : earlierItems).push(item);
    }
    return { today: todayItems, earlier: earlierItems };
  }, [items]);

  const handleSelect = (item: NotificationItem, close: () => void): void => {
    if (!item.is_read) void markRead(item.id);
    if (item.link) {
      close();
      navigate(item.link);
    }
  };

  return (
    <Popover
      align="end"
      role="dialog"
      panelClassName="w-80"
      trigger={(triggerProps) => (
        <button
          type="button"
          ref={triggerProps.setRef}
          onClick={triggerProps.onClick}
          aria-haspopup={triggerProps['aria-haspopup']}
          aria-expanded={triggerProps['aria-expanded']}
          aria-controls={triggerProps['aria-controls']}
          aria-label={hasUnread ? `Notifications (${unreadCount} unread)` : 'Notifications'}
          className={cn(
            'relative flex h-9 w-9 items-center justify-center rounded-lg text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)]',
            triggerProps['aria-expanded'] && 'bg-[var(--ds-bg-hover)] text-[var(--ds-text)]',
          )}
        >
          {hasUnread ? <BellRing size={18} /> : <Bell size={18} />}
          {hasUnread && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--ds-danger)] px-1 text-[9px] font-bold leading-none text-white">
              {badgeLabel}
            </span>
          )}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between border-b border-[var(--ds-border)] px-4 py-3">
            <span className="text-sm font-semibold text-[var(--ds-text)]">
              {t('shell.notifications.title') || 'Notifications'}
            </span>
            <div className="flex items-center gap-3">
              {hasUnread && (
                <button
                  type="button"
                  onClick={() => void markAllRead()}
                  className="inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--ds-accent-text)] transition-opacity hover:opacity-80"
                >
                  <CheckCheck size={12} aria-hidden="true" />
                  {t('shell.notifications.markAllRead') || 'Mark all read'}
                </button>
              )}
              {items.length > 0 && (
                <button
                  type="button"
                  onClick={() => void clearAll()}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--ds-text-subtle)] transition-colors hover:text-[var(--ds-danger)]"
                >
                  <Trash2 size={12} aria-hidden="true" />
                  {t('shell.notifications.clearAll') || 'Clear all'}
                </button>
              )}
            </div>
          </div>

          <div className="max-h-96 overflow-y-auto p-1.5">
            {loading && items.length === 0 ? (
              <div className="space-y-2 p-1.5">
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
                <Skeleton className="h-12 w-full" />
              </div>
            ) : items.length === 0 ? (
              <EmptyState
                icon={Bell}
                title={t('shell.notifications.empty') || "You're all caught up"}
                description={t('shell.handoffsNewLeadsAndBilling') || 'Handoffs, new leads and billing alerts will appear here.'}
                className="border-0 px-2 py-8"
              />
            ) : (
              <>
                {today.length > 0 && (
                  <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
                    {t('shell.notifications.today') || 'Today'}
                  </div>
                )}
                {today.map((item) => (
                  <NotificationRow
                    key={item.id}
                    item={item}
                    onSelect={() => handleSelect(item, close)}
                    onDismiss={() => void dismiss(item.id)}
                  />
                ))}
                {earlier.length > 0 && (
                  <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
                    {t('shell.notifications.earlier') || 'Earlier'}
                  </div>
                )}
                {earlier.map((item) => (
                  <NotificationRow
                    key={item.id}
                    item={item}
                    onSelect={() => handleSelect(item, close)}
                    onDismiss={() => void dismiss(item.id)}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}
