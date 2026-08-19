import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { Avatar, Badge, EmptyState, ErrorState, LoadingRows, SearchField, SegmentedControl, StatusDot, cn, formatRelative } from '../../ui';
import { INBOX_VIEWS, VIEW_META, byRecency, matchesQuery, waitLabel, waitTone, type InboxItem, type InboxView } from './inboxModel';

export interface ConversationListProps {
  view: InboxView;
  onViewChange: (view: InboxView) => void;
  counts: Record<InboxView, number>;
  items: InboxItem[];
  selectedId: string | null;
  onSelect: (item: InboxItem) => void;
  query: string;
  onQueryChange: (query: string) => void;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  /** Ticking clock, so wait times count up without every row owning a timer. */
  now: number;
  /** Rendered under the list — pagination for the offline scope. */
  footer?: React.ReactNode;
  emptyAction?: React.ReactNode;
  /**
   * Replaces the scope's own empty copy when the list is empty for a reason the
   * scope does not know about — being offline, for instance, which is why there
   * is no queue rather than the queue being clear.
   */
  emptyOverride?: { title: string; description: string; action?: React.ReactNode } | null;
}

function Row({
  item,
  selected,
  onSelect,
  now,
}: {
  item: InboxItem;
  selected: boolean;
  onSelect: (item: InboxItem) => void;
  now: number;
}) {
  const waiting = item.kind === 'waiting';
  const wait = waiting ? waitLabel(item.at, now) : '';

  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-item-id={item.id}
      onClick={() => onSelect(item)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(item);
        }
      }}
      className={cn(
        'flex cursor-pointer gap-3 border-b border-border px-3 py-3',
        'transition-colors duration-[var(--dur-fast)]',
        selected ? 'bg-accent-50' : 'bg-surface hover:bg-surface-hover',
      )}
    >
      <div className="relative shrink-0 pt-0.5">
        <Avatar size="md" name={item.name} />
        {item.online ? (
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-surface p-0.5">
            <StatusDot tone="success" pulse label="Online now" />
          </span>
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 flex-1 truncate text-base font-medium text-text-primary">{item.name}</p>
          {wait ? (
            <Badge tone={waitTone(item.at, now)} className="figure">
              {wait}
            </Badge>
          ) : (
            <span className="figure shrink-0 text-2xs text-text-tertiary">
              {formatRelative(item.at)}
            </span>
          )}
        </div>
        <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-text-secondary">{item.preview}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {item.state ? <Badge tone={item.state.tone}>{item.state.label}</Badge> : null}
          {item.botName ? (
            <span className="truncate text-2xs text-text-tertiary">{item.botName}</span>
          ) : null}
          {item.unread > 0 ? (
            <span className="figure ml-auto rounded-full bg-ink px-1.5 py-0.5 text-2xs font-medium text-rail-text">
              {item.unread}
              <span className="sr-only"> unread</span>
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The one list, and the scope switcher over it.
 *
 * A `listbox`, because that is what it is: a single selection that drives the
 * two panes beside it. The rows the console it replaces used were bare `div`s
 * with a click handler — unreachable by keyboard at all — inside three separate
 * lists that each maintained their own idea of what was selected.
 *
 * Search filters within the current scope only. Searching across all four would
 * be a different feature (and a server-side one); pretending to do it client
 * side over one page of offline messages would be a lie about coverage.
 */
export function ConversationList({
  view,
  onViewChange,
  counts,
  items,
  selectedId,
  onSelect,
  query,
  onQueryChange,
  loading,
  error,
  onRetry,
  now,
  footer,
  emptyAction,
  emptyOverride = null,
}: ConversationListProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const meta = VIEW_META[view];

  const visible = useMemo(
    () => items.filter((item) => matchesQuery(item, query)).sort(byRecency),
    [items, query],
  );

  const move = useCallback(
    (delta: number) => {
      if (visible.length === 0) return;
      const current = visible.findIndex((item) => item.id === selectedId);
      const next = visible[Math.min(Math.max(current + delta, 0), visible.length - 1)] ?? visible[0];
      onSelect(next);
      listRef.current
        ?.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(next.id)}"]`)
        ?.focus();
    },
    [visible, selectedId, onSelect],
  );

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      move(-visible.length);
    } else if (event.key === 'End') {
      event.preventDefault();
      move(visible.length);
    }
  }

  // Keep the selected row in view when selection changes from outside the list
  // (a deep link, or a conversation being accepted from the centre pane).
  // Feature-checked because `scrollIntoView` is absent in jsdom, and a test
  // environment is not a reason for a component to throw.
  useEffect(() => {
    if (!selectedId) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-item-id="${CSS.escape(selectedId)}"]`,
    );
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  return (
    <div className="flex h-full min-h-0 flex-col border-r border-border bg-surface">
      <div className="shrink-0 space-y-2.5 border-b border-border px-3 py-3">
        <SegmentedControl
          size="sm"
          label="Conversation scope"
          value={view}
          onChange={onViewChange}
          items={INBOX_VIEWS.map((value) => ({
            value,
            label: VIEW_META[value].label,
            count: counts[value],
          }))}
        />
        <SearchField
          size="sm"
          label={`Search ${meta.label.toLowerCase()}`}
          placeholder={`Search ${meta.label.toLowerCase()}…`}
          value={query}
          onValueChange={onQueryChange}
        />
      </div>

      <div
        ref={listRef}
        role="listbox"
        aria-label={`${meta.label} conversations`}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {loading && visible.length === 0 ? (
          <LoadingRows rows={6} className="p-3" />
        ) : error ? (
          <ErrorState compact description={error} onRetry={onRetry} />
        ) : visible.length === 0 ? (
          <EmptyState
            compact
            title={query ? 'Nothing matched' : (emptyOverride?.title ?? meta.emptyTitle)}
            description={
              query
                ? `No conversation in ${meta.label} matches “${query}”.`
                : (emptyOverride?.description ?? meta.emptyBody)
            }
            action={query ? undefined : (emptyOverride?.action ?? emptyAction)}
          />
        ) : (
          visible.map((item) => (
            <Row
              key={item.id}
              item={item}
              selected={item.id === selectedId}
              onSelect={onSelect}
              now={now}
            />
          ))
        )}
      </div>

      {footer ? <div className="shrink-0 border-t border-border px-3 py-2">{footer}</div> : null}
    </div>
  );
}
