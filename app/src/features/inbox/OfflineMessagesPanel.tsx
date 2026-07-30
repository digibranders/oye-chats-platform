import { useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Inbox,
  Mail,
  MailOpen,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  MousePointerClick,
} from 'lucide-react';
import { Button, EmptyState, Skeleton, cn } from '../../design-system';
import { MetricCard } from '../../design-system/components/MetricCard';
import { ConversationCard } from '../../design-system/components/ConversationCard';
import { getCannedResponses } from '../../services/api';
import { type CannedResponse } from '../../types/domain';
import { useOfflineMessages, type StatusFilter } from './useOfflineMessages';
import { MessageDetail } from './MessageDetail';
import { relativeTime, statusBadge, type OfflineStatus } from './inboxHelpers';

const FILTER_OPTIONS: ReadonlyArray<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'New' },
  { key: 'read', label: 'Read' },
  { key: 'replied', label: 'Replied' },
];

export interface OfflineMessagesPanelProps {
  /** Active bot; the inbox is scoped to it. Undefined until a bot is selected. */
  botId: number | undefined;
}

/**
 * OfflineMessagesPanel - the "messages left while you were away" inbox. A metric
 * row summarizes volume, a filter switches lifecycle state, and a master list +
 * reading pane let an operator triage and reply. All states are explicit:
 * loading skeletons, an error with retry, and an empty state.
 */
export function OfflineMessagesPanel({ botId }: OfflineMessagesPanelProps): ReactElement {
  const {
    messages,
    total,
    page,
    pageSize,
    statusFilter,
    loading,
    error,
    setPage,
    setStatusFilter,
    reload,
    updateStatus,
    remove,
  } = useOfflineMessages(botId);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [savingStatusId, setSavingStatusId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [cannedResponses, setCannedResponses] = useState<CannedResponse[]>([]);

  // Load workspace quick replies once - they enrich the reply affordances but the
  // pane works without them (falls back to built-in templates).
  useEffect(() => {
    let active = true;
    void getCannedResponses()
      .then((res) => {
        if (active) setCannedResponses(res.responses ?? []);
      })
      .catch(() => {
        /* quick replies are optional; ignore failures */
      });
    return () => {
      active = false;
    };
  }, []);

  const selectedMessage = useMemo(
    () => messages.find((m) => m.id === selectedId) ?? null,
    [messages, selectedId],
  );

  const newCount = messages.filter((m) => m.status === 'new').length;
  const repliedCount = messages.filter((m) => m.status === 'replied').length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  function handleSelect(id: number, status: string | undefined): void {
    setSelectedId(id);
    setActionError(null);
    // Opening an unread message reads it (matches every inbox convention) - but
    // only under the "All" filter. Under a "New"-only filter, auto-reading would
    // immediately drop the row the operator just opened, clearing the pane.
    if (status === 'new' && statusFilter === 'all') {
      void runStatus(id, 'read');
    }
  }

  async function runStatus(id: number, status: OfflineStatus): Promise<void> {
    setSavingStatusId(id);
    setActionError(null);
    try {
      await updateStatus(id, status);
    } catch {
      setActionError('Could not update the message. Please try again.');
    } finally {
      setSavingStatusId(null);
    }
  }

  async function runDelete(id: number): Promise<void> {
    setDeletingId(id);
    setActionError(null);
    try {
      await remove(id);
      if (selectedId === id) setSelectedId(null);
    } catch {
      setActionError('Could not delete the message. Please try again.');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Volume at a glance */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <MetricCard label="Total messages" value={total.toLocaleString()} icon={Inbox} />
        <MetricCard label="New on this page" value={newCount} icon={Mail} />
        <MetricCard label="Replied on this page" value={repliedCount} icon={CheckCheck} />
      </div>

      {/* Filter */}
      <StatusFilterBar
        value={statusFilter}
        onChange={(key) => {
          setStatusFilter(key);
          setSelectedId(null);
        }}
      />

      {actionError && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] px-3 py-2 text-[13px] text-[var(--ds-danger)]"
        >
          <AlertCircle size={15} aria-hidden="true" />
          {actionError}
        </div>
      )}

      {/* Master–detail */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
        {/* List */}
        <div className="rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)]">
          <div className="max-h-[32rem] overflow-y-auto p-2 lg:max-h-[36rem]">
            {loading ? (
              <ListSkeleton />
            ) : error ? (
              <div className="p-4">
                <EmptyState
                  icon={AlertCircle}
                  title="Couldn’t load your messages"
                  description={error}
                  action={
                    <Button variant="outline" size="sm" onClick={reload}>
                      Try again
                    </Button>
                  }
                />
              </div>
            ) : messages.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  icon={MailOpen}
                  title="No messages here"
                  description={
                    statusFilter === 'all'
                      ? 'When a visitor leaves a message while your team is offline, it lands here.'
                      : 'No messages match this filter yet.'
                  }
                />
              </div>
            ) : (
              <ul className="flex flex-col">
                {messages.map((m) => {
                  const badge = statusBadge(m.status);
                  const selected = selectedId === m.id;
                  return (
                    // Convey the open row programmatically, not by tint alone, so
                    // assistive tech announces which conversation is being read.
                    <li key={m.id} aria-current={selected ? 'true' : undefined}>
                      <ConversationCard
                        name={m.visitor_name?.trim() || m.visitor_email || 'Anonymous visitor'}
                        snippet={m.message_body || 'No message content.'}
                        time={relativeTime(m.created_at)}
                        unread={m.status === 'new'}
                        status={{ label: badge.label, tone: badge.tone }}
                        onClick={() => handleSelect(m.id, m.status)}
                        className={selected ? 'bg-[var(--ds-bg-hover)]' : undefined}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Pagination */}
          {!loading && !error && total > pageSize && (
            <div className="flex items-center justify-between border-t border-[var(--ds-border)] px-3 py-2">
              <span className="text-[12px] text-[var(--ds-text-subtle)]">
                Page {page} of {totalPages}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Previous page"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Next page"
                  disabled={page >= totalPages}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight size={16} aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Detail */}
        <div className="min-h-[24rem] rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)]">
          {selectedMessage ? (
            <MessageDetail
              key={selectedMessage.id}
              message={selectedMessage}
              cannedResponses={cannedResponses}
              onSetStatus={(status) => void runStatus(selectedMessage.id, status)}
              onDelete={() => void runDelete(selectedMessage.id)}
              savingStatus={savingStatusId === selectedMessage.id}
              deleting={deletingId === selectedMessage.id}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState
                icon={MousePointerClick}
                title="Select a message"
                description="Choose a conversation on the left to read it and reply."
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface StatusFilterBarProps {
  value: StatusFilter;
  onChange: (value: StatusFilter) => void;
}

/**
 * StatusFilterBar - a single-select segmented control for the message lifecycle
 * filter. Uses `aria-pressed` toggle buttons inside a labelled group rather than
 * a tablist: this is a filter over one results list, not a set of tabpanels, so
 * the WAI-ARIA tabs pattern (with its aria-controls → tabpanel wiring) doesn't
 * apply here.
 */
function StatusFilterBar({ value, onChange }: StatusFilterBarProps): ReactElement {
  return (
    <div
      role="group"
      aria-label="Filter messages by status"
      className="inline-flex items-center gap-1 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-1"
    >
      {FILTER_OPTIONS.map((opt) => {
        const active = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.key)}
            className={cn(
              'rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
              active
                ? 'bg-[var(--ds-bg-surface)] text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)]'
                : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** Placeholder rows shown while the first page of messages loads. */
function ListSkeleton(): ReactElement {
  return (
    <ul className="flex flex-col gap-1 p-1" aria-hidden="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="flex items-start gap-3 px-3 py-3">
          <Skeleton className="mt-1 h-2 w-2 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-11/12" />
          </div>
        </li>
      ))}
    </ul>
  );
}
