import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingConversations,
  PaneHeader,
  SearchField,
  Select,
  StatusDot,
  cn,
  formatRelative,
} from '../../ui';
import {
  INBOX_VIEWS,
  VIEW_META,
  byRecency,
  matchesQuery,
  shortAgo,
  waitLabel,
  waitTone,
  type InboxItem,
  type InboxView,
} from './inboxModel';

export interface ConversationListProps {
  view: InboxView;
  onViewChange: (view: InboxView) => void;
  counts: Record<InboxView, number>;
  /** True when a scope holds something unread, so the switcher can say so. */
  unread?: Partial<Record<InboxView, boolean>>;
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
  /**
   * Replaces the scope's own empty copy when the list is empty for a reason the
   * scope does not know about — being offline, for instance, which is why there
   * is no queue rather than the queue being clear.
   */
  emptyOverride?: { title: string; description: string; action?: React.ReactNode } | null;
}

/**
 * One conversation, in a fixed 72px box.
 *
 * It used to be 90–110px, because the preview was a `line-clamp-2` — a
 * *maximum*, not a box — so adjacent rows differed in height by 20px and the
 * list read as ragged rather than as a column. Eight conversations filled the
 * pane. Intercom's row is 72px and Front's is 64; this is two lines, fixed:
 * name · state · time, then the preview.
 */
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
      title={item.at ? `${item.name} · ${formatRelative(item.at)}` : item.name}
      onClick={() => onSelect(item)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(item);
        }
      }}
      className={cn(
        'flex h-18 cursor-pointer items-center gap-3 border-b border-border px-cell last:border-b-0',
        'transition-colors duration-[var(--dur-fast)]',
        // `div[role=option][tabindex]` is deliberately outside the one
        // `:focus-visible` selector in `tokens.css`, so `move()` called
        // `.focus()` on a row and nothing was drawn. Inset, because the row is
        // flush to the pane's edges and a +2 outline is clipped by the list's
        // own `overflow-y-auto`.
        'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2',
        'focus-visible:outline-accent-500',
        selected
          ? 'bg-accent-50 shadow-[inset_3px_0_0_var(--color-accent-500)]'
          : 'bg-surface hover:bg-surface-hover',
      )}
    >
      <div className="relative shrink-0">
        <Avatar size="md" name={item.name} />
        {item.online ? (
          <span className="absolute -bottom-0.5 -right-0.5 rounded-full bg-surface p-0.5">
            <StatusDot tone="success" pulse label="Online now" />
          </span>
        ) : null}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
            {item.name}
          </p>
          {item.state ? (
            <Badge tone={item.state.tone} className="shrink-0">
              {item.state.label}
            </Badge>
          ) : null}
          {wait ? (
            <Badge tone={waitTone(item.at, now)} className="figure shrink-0">
              {wait}
            </Badge>
          ) : (
            /* `14h`, not `14 hours ago`. See `shortAgo`. The long form is
               still announced and still on the row's title, so nothing is
               lost — only the ~90px the phrase was costing the name beside
               it. An `aria-label` on the row would have been the shorter
               diff and would have thrown away the preview and the unread
               count with it. */
            <span className="figure shrink-0 text-2xs text-text-tertiary">
              <span aria-hidden>{shortAgo(item.at, now)}</span>
              <span className="sr-only">{formatRelative(item.at)}</span>
            </span>
          )}
          {/* On line 1, pinned, and capped. It used to be `ml-auto` inside a
              wrapping row, so behind a long chatbot name the most important
              number on the row wrapped to the left edge of a second line. */}
          {item.unread > 0 ? (
            <Badge tone="ink" className="figure shrink-0">
              {item.unread > 99 ? '99+' : item.unread}
              <span className="sr-only"> unread</span>
            </Badge>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-xs text-text-secondary">{item.preview}</p>
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
 * The scope is a `Select`, not a segmented control. Four segments each carrying
 * a count came to roughly 340px against the 296px this pane has, and
 * `SegmentedControl` neither wraps nor scrolls nor sets `min-w-0`, so it
 * painted straight over the pane's own right border.
 *
 * Search filters within the current scope only. Searching across all four would
 * be a different feature (and a server-side one); pretending to do it client
 * side over one page of offline messages would be a lie about coverage.
 */
export function ConversationList({
  view,
  onViewChange,
  counts,
  unread = {},
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
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <PaneHeader
        title="Conversations"
        actions={
          <>
            {/* Colour is never the only signal, so the scope that holds unread
                messages carries a dot beside its name as well as a count. */}
            {unread[view] ? <StatusDot tone="danger" label="Unread in this scope" /> : null}
            <div className="w-36">
              <Select<InboxView>
                size="sm"
                aria-label="Conversation scope"
                value={view}
                onChange={(event) => onViewChange(event.target.value as InboxView)}
                options={INBOX_VIEWS.map((value) => ({
                  value,
                  label: `${VIEW_META[value].label} (${counts[value]})`,
                }))}
              />
            </div>
          </>
        }
      >
        <SearchField
          size="sm"
          label={`Search ${meta.label.toLowerCase()}`}
          placeholder={`Search ${meta.label.toLowerCase()}…`}
          value={query}
          onValueChange={onQueryChange}
          className="w-full"
        />
      </PaneHeader>

      <div
        ref={listRef}
        role="listbox"
        aria-label={`${meta.label} conversations`}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {loading && visible.length === 0 ? (
          <LoadingConversations rows={6} />
        ) : error ? (
          <ErrorState size="panel" polite description={error} onRetry={onRetry} />
        ) : visible.length === 0 ? (
          <EmptyState
            size="panel"
            title={query ? 'Nothing matched' : (emptyOverride?.title ?? meta.emptyTitle)}
            description={
              query
                ? `No conversation in ${meta.label} matches “${query}”.`
                : (emptyOverride?.description ?? meta.emptyBody)
            }
            // A "nothing matched" state with no way out is a dead end.
            action={
              query ? (
                <Button size="sm" variant="secondary" onClick={() => onQueryChange('')}>
                  Clear search
                </Button>
              ) : (
                emptyOverride?.action
              )
            }
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

      {footer ? (
        <div className="shrink-0 border-t border-border px-cell py-2">{footer}</div>
      ) : null}
    </div>
  );
}
