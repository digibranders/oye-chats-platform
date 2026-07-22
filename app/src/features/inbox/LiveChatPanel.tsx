import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  AlertCircle,
  Inbox,
  MessageSquare,
  Radio,
  Sparkles,
  UserPlus,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { Button, EmptyState, InsightCard, Skeleton, StatusBadge, cn } from '../../design-system';
import { acceptChat, closeOperatorChat, getQualifiedBotSessions, sendConnectRequest } from '../../services/api';
import { type OperatorStatusState } from './useOperatorStatus';
import { useOperatorSocket } from './useOperatorSocket';
import { ConversationView } from './ConversationView';
import { SessionDetailsPanel } from './SessionDetailsPanel';
import { TransferDialog } from './TransferDialog';
import type { ConnectionStatus, QualifiedSession, RosterOperator } from './liveChatProtocol';
import { initials, maxVisitorDbId, relativeTime } from './liveChatHelpers';

export interface LiveChatPanelProps {
  operator: OperatorStatusState;
  /** Active agent — scopes the queue / active / qualified lists to this bot. */
  botId?: number;
}

// ── Presentational helpers (non-exported; component file exports only LiveChatPanel) ──

const CONNECTION_META: Record<ConnectionStatus, { label: string; tone: 'success' | 'warning' | 'neutral' | 'danger' }> =
  {
    idle: { label: 'Offline', tone: 'neutral' },
    connecting: { label: 'Connecting…', tone: 'warning' },
    connected: { label: 'Connected', tone: 'success' },
    reconnecting: { label: 'Reconnecting…', tone: 'warning' },
    duplicate: { label: 'Open in another tab', tone: 'danger' },
  };

function ConnectionPill({ status }: { status: ConnectionStatus }): ReactElement {
  const meta = CONNECTION_META[status];
  return (
    <StatusBadge tone={meta.tone} dot>
      {status === 'connected' ? <Wifi size={12} aria-hidden="true" /> : <WifiOff size={12} aria-hidden="true" />}
      {meta.label}
    </StatusBadge>
  );
}

interface RailButtonProps {
  active: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
  badge?: string;
  right?: ReactElement;
  online?: boolean;
}

function RailButton({ active, onClick, title, subtitle, badge, right, online }: RailButtonProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-[var(--ds-radius-lg)] border px-3 py-2.5 text-left transition-colors',
        active
          ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]'
          : 'border-transparent hover:bg-[var(--ds-bg-hover)]',
      )}
    >
      <span className="relative shrink-0">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--ds-bg-sunken)] text-[12px] font-semibold text-[var(--ds-text-muted)]">
          {initials(title)}
        </span>
        {online !== undefined && (
          <span
            className={cn(
              'absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--ds-bg-surface)]',
              online ? 'bg-[var(--ds-success)]' : 'bg-[var(--ds-text-subtle)]',
            )}
            aria-hidden="true"
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-[var(--ds-text)]">{title}</span>
        <span className="block truncate text-[12px] text-[var(--ds-text-muted)]">{subtitle}</span>
      </span>
      {badge && (
        <span className="shrink-0 rounded-full bg-[var(--ds-accent)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--ds-accent-fg)]">
          {badge}
        </span>
      )}
      {right}
    </button>
  );
}

function RailSection({ icon, label, count }: { icon: ReactElement; label: string; count: number }): ReactElement {
  return (
    <div className="flex items-center gap-2 px-1 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
      <span aria-hidden="true">{icon}</span>
      {label}
      <span className="text-[var(--ds-text-subtle)]">({count})</span>
    </div>
  );
}

function TeamRoster({ roster }: { roster: RosterOperator[] }): ReactElement | null {
  if (roster.length === 0) return null;
  return (
    <div className="border-t border-[var(--ds-border)] p-4">
      <p className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
        <Users size={13} aria-hidden="true" /> Team
      </p>
      <div className="space-y-1.5">
        {roster.map((op) => (
          <div key={op.operator_id} className="flex items-center gap-2 text-[13px]">
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                op.is_online ? 'bg-[var(--ds-success)]' : 'bg-[var(--ds-text-subtle)]',
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate text-[var(--ds-text)]">{op.name || 'Operator'}</span>
            <span className="text-[12px] text-[var(--ds-text-muted)]">{op.active_chats} active</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Coerce the loose qualified-sessions REST payload into typed rows. */
function parseQualifiedSessions(raw: Record<string, unknown>): QualifiedSession[] {
  const list = Array.isArray(raw.sessions) ? (raw.sessions as Array<Record<string, unknown>>) : [];
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return list.map((s) => ({
    session_id: String(s.session_id ?? ''),
    bot_id: typeof s.bot_id === 'number' ? s.bot_id : null,
    bot_name: str(s.bot_name),
    name: str(s.name) ?? 'Anonymous',
    email: str(s.email),
    phone: str(s.phone),
    company: str(s.company),
    location: str(s.location),
    device: str(s.device),
    bant_tier: str(s.bant_tier) ?? 'unqualified',
    bant_score: num(s.bant_score),
    bant_dimensions_count: num(s.bant_dimensions_count),
    last_message_preview: str(s.last_message_preview),
    last_message_at: str(s.last_message_at),
  }));
}

/**
 * LiveChatPanel — the real-time operator console.
 *
 * A three-pane workspace (queue/active/qualified · conversation · visitor details)
 * backed by the `/ws/operator` WebSocket. Operators set availability, accept
 * waiting visitors, run multiple simultaneous conversations, transfer or close
 * them, see typing + presence + read receipts, and proactively invite qualified
 * bot-mode visitors into a human chat.
 */
export function LiveChatPanel({ operator, botId }: LiveChatPanelProps): ReactElement {
  const { isOnline, unavailable, saving, loading, error: availabilityError, toggle } = operator;
  const enabled = isOnline && !unavailable;

  const socket = useOperatorSocket({ enabled });
  const {
    status,
    operatorId,
    queue,
    activeChats,
    messagesBySession,
    typingBySession,
    presenceBySession,
    unreadBySession,
    visitorReadAtBySession,
    roster,
    qualifiedVersion,
    connectResolutions,
    lastError,
    sendMessage,
    sendTyping,
    sendReadReceipt,
    loadHistory,
    clearUnread,
  } = socket;

  const connected = status === 'connected';

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [qualified, setQualified] = useState<QualifiedSession[]>([]);
  const [qualifiedLoaded, setQualifiedLoaded] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const loadedHistoryRef = useRef<Set<string>>(new Set());

  // ── Bot scoping ──
  const matchesBot = useCallback(
    (candidateBotId: number | null): boolean => botId == null || candidateBotId == null || candidateBotId === botId,
    [botId],
  );

  const visibleQueue = useMemo(() => queue.filter((q) => matchesBot(q.bot_id)), [queue, matchesBot]);
  const visibleActive = useMemo(
    () => Object.values(activeChats).filter((c) => matchesBot(c.bot_id)),
    [activeChats, matchesBot],
  );
  const visibleQualified = useMemo(() => qualified.filter((q) => matchesBot(q.bot_id)), [qualified, matchesBot]);

  const selectedChat = selectedId ? activeChats[selectedId] : undefined;
  const selectedMessages = useMemo(
    () => (selectedId ? (messagesBySession[selectedId] ?? []) : []),
    [selectedId, messagesBySession],
  );

  // ── Qualified sessions (REST; refetched on WS invalidation) ──
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    getQualifiedBotSessions(50)
      .then((raw) => {
        if (!active) return;
        setQualified(parseQualifiedSessions(raw));
        setQualifiedLoaded(true);
      })
      .catch(() => {
        if (!active) return;
        setQualifiedLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [enabled, qualifiedVersion]);

  // Selection auto-drops via render: when the selected chat leaves `activeChats`
  // (closed / transferred away), `selectedChat` becomes undefined and the centre
  // pane falls back to its empty state — no effect / setState needed.

  // Drop the history-loaded marker for any session that has left the board so a
  // future chat reusing the id re-fetches its transcript (the socket hook has
  // already pruned that session's messages). Ref-only mutation — no setState.
  useEffect(() => {
    const loaded = loadedHistoryRef.current;
    if (loaded.size === 0) return;
    for (const sid of loaded) {
      if (!(sid in activeChats)) loaded.delete(sid);
    }
  }, [activeChats]);

  // ── Auto read-receipt + unread clear for the open conversation as messages land ──
  // `sendReadReceipt` / `clearUnread` are socket-hook callbacks (not local state
  // setters), so this stays clear of react-hooks/set-state-in-effect.
  useEffect(() => {
    if (!selectedId || !connected) return;
    const highWater = maxVisitorDbId(selectedMessages);
    if (highWater > 0) sendReadReceipt(selectedId, highWater);
    clearUnread(selectedId);
  }, [selectedId, selectedMessages, connected, sendReadReceipt, clearUnread]);

  const openChat = useCallback(
    (sessionId: string): void => {
      setSelectedId(sessionId);
      setActionError(null);
      if (!loadedHistoryRef.current.has(sessionId)) {
        loadedHistoryRef.current.add(sessionId);
        void loadHistory(sessionId);
      }
      clearUnread(sessionId);
      const highWater = maxVisitorDbId(messagesBySession[sessionId] ?? []);
      if (highWater > 0) sendReadReceipt(sessionId, highWater);
    },
    [loadHistory, clearUnread, sendReadReceipt, messagesBySession],
  );

  const handleAccept = useCallback(
    async (sessionId: string): Promise<void> => {
      if (acceptingId) return;
      setAcceptingId(sessionId);
      setActionError(null);
      try {
        await acceptChat(sessionId, operatorId);
        loadedHistoryRef.current.add(sessionId);
        await loadHistory(sessionId);
        setSelectedId(sessionId);
      } catch (err) {
        // 409 = already taken by another operator; the queue update self-heals.
        const isConflict =
          typeof err === 'object' && err !== null && 'status' in err && (err as { status: number }).status === 409;
        if (!isConflict) {
          setActionError(err instanceof Error ? `Couldn’t accept chat: ${err.message}` : 'Couldn’t accept chat.');
        }
      } finally {
        setAcceptingId(null);
      }
    },
    [acceptingId, operatorId, loadHistory],
  );

  const handleClose = useCallback(async (): Promise<void> => {
    if (!selectedId || closingId) return;
    setClosingId(selectedId);
    setActionError(null);
    try {
      await closeOperatorChat(selectedId);
      // WS `chat_closed` removes it from the board + clears selection.
    } catch (err) {
      setActionError(err instanceof Error ? `Couldn’t end chat: ${err.message}` : 'Couldn’t end chat.');
    } finally {
      setClosingId(null);
    }
  }, [selectedId, closingId]);

  const handleConnectRequest = useCallback(
    async (sessionId: string): Promise<void> => {
      if (connectingId) return;
      setConnectingId(sessionId);
      setActionError(null);
      try {
        await sendConnectRequest(sessionId, operatorId);
      } catch (err) {
        setActionError(
          err instanceof Error ? `Couldn’t send invite: ${err.message}` : 'Couldn’t send connect invite.',
        );
      } finally {
        setConnectingId(null);
      }
    },
    [connectingId, operatorId],
  );

  // ── Availability bar (always shown) ──
  const availabilityBar = (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5">
      <div className="flex items-center gap-3">
        <span
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]"
          aria-hidden="true"
        >
          <Radio size={18} />
        </span>
        <div>
          <p className="text-[14px] font-semibold text-[var(--ds-text)]">Your availability</p>
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            {loading
              ? 'Checking your availability…'
              : unavailable
                ? 'You’re not set up as a live-chat operator in this workspace yet.'
                : isOnline
                  ? 'You’re online and can receive live conversations.'
                  : 'You’re offline. Visitors will be offered the message form instead.'}
          </p>
        </div>
      </div>
      {loading ? (
        <Skeleton className="h-8 w-40 rounded-lg" />
      ) : unavailable ? (
        <StatusBadge tone="neutral">Not an operator</StatusBadge>
      ) : (
        <div className="flex items-center gap-3">
          {enabled && <ConnectionPill status={status} />}
          <StatusBadge tone={isOnline ? 'success' : 'neutral'} dot>
            {isOnline ? 'Online' : 'Offline'}
          </StatusBadge>
          <Button variant="outline" size="sm" onClick={() => void toggle()} disabled={saving}>
            {saving ? 'Saving…' : isOnline ? 'Go offline' : 'Go online'}
          </Button>
        </div>
      )}
    </div>
  );

  const errorBanner = (availabilityError || lastError || actionError) && (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-lg border border-[var(--ds-danger-soft)] bg-[var(--ds-danger-soft)] px-3 py-2 text-[13px] text-[var(--ds-danger)]"
    >
      <AlertCircle size={15} aria-hidden="true" />
      {availabilityError || actionError || lastError}
    </div>
  );

  // ── Not-yet-online states ──
  if (!enabled) {
    return (
      <div className="space-y-6">
        {availabilityBar}
        {errorBanner}
        <EmptyState
          icon={MessageSquare}
          title={unavailable ? 'Live chat isn’t available for you' : 'Go online to start taking chats'}
          description={
            unavailable
              ? 'Ask a workspace admin to add you as an operator, then you’ll be able to take real-time conversations here.'
              : 'Flip your availability to online and waiting visitors, your active conversations, and qualified bot chats will appear here in real time.'
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {availabilityBar}
      {errorBanner}

      {status === 'duplicate' && (
        <InsightCard
          tone="warning"
          title="Live chat is open in another tab"
          body="Only one live-chat session can run per operator. Close the other tab, then reload this one to take over here."
        />
      )}

      <div className="grid min-h-[600px] grid-cols-1 overflow-hidden rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] lg:grid-cols-[280px_1fr] xl:grid-cols-[280px_1fr_300px]">
        {/* Left rail — queue / active / qualified */}
        <div className="flex max-h-[720px] flex-col overflow-y-auto border-b border-[var(--ds-border)] lg:border-b-0 lg:border-r">
          <div className="flex-1 space-y-1 p-3">
            <RailSection icon={<Inbox size={13} />} label="Waiting" count={visibleQueue.length} />
            {visibleQueue.length === 0 ? (
              <p className="px-1 py-2 text-[12px] text-[var(--ds-text-subtle)]">No one is waiting.</p>
            ) : (
              visibleQueue.map((q) => (
                <RailButton
                  key={q.session_id}
                  active={false}
                  onClick={() => void handleAccept(q.session_id)}
                  title={q.name || 'Anonymous'}
                  subtitle={q.reason || q.bot_name || 'Waiting for an operator'}
                  right={
                    <span className="shrink-0">
                      <StatusBadge tone="accent">
                        {acceptingId === q.session_id ? 'Accepting…' : 'Accept'}
                      </StatusBadge>
                    </span>
                  }
                />
              ))
            )}

            <RailSection icon={<MessageSquare size={13} />} label="Active" count={visibleActive.length} />
            {visibleActive.length === 0 ? (
              <p className="px-1 py-2 text-[12px] text-[var(--ds-text-subtle)]">No active conversations.</p>
            ) : (
              visibleActive.map((c) => {
                const unread = unreadBySession[c.session_id] ?? 0;
                return (
                  <RailButton
                    key={c.session_id}
                    active={selectedId === c.session_id}
                    onClick={() => openChat(c.session_id)}
                    title={c.visitor_name}
                    subtitle={
                      typingBySession[c.session_id]
                        ? 'typing…'
                        : c.bot_name || (presenceBySession[c.session_id] === 'disconnected' ? 'Disconnected' : 'Live')
                    }
                    badge={unread > 0 ? String(unread) : undefined}
                    online={presenceBySession[c.session_id] !== 'disconnected'}
                  />
                );
              })
            )}

            <RailSection icon={<Sparkles size={13} />} label="Chatting with AI" count={visibleQualified.length} />
            {!qualifiedLoaded ? (
              <div className="space-y-1.5 px-1 py-1">
                <Skeleton className="h-10 w-full rounded-lg" />
                <Skeleton className="h-10 w-full rounded-lg" />
              </div>
            ) : visibleQualified.length === 0 ? (
              <p className="px-1 py-2 text-[12px] text-[var(--ds-text-subtle)]">No qualified bot chats right now.</p>
            ) : (
              visibleQualified.map((q) => {
                const resolution = connectResolutions[q.session_id];
                const pending = connectingId === q.session_id;
                return (
                  <div
                    key={q.session_id}
                    className="rounded-[var(--ds-radius-lg)] border border-transparent px-3 py-2.5 hover:bg-[var(--ds-bg-hover)]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-[var(--ds-text)]">{q.name}</span>
                        <span className="block truncate text-[12px] text-[var(--ds-text-muted)]">
                          {q.last_message_preview || `${q.bant_tier} · ${q.bant_dimensions_count}/4 signals`}
                        </span>
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleConnectRequest(q.session_id)}
                        disabled={pending || resolution?.outcome === 'accepted'}
                      >
                        <UserPlus size={13} aria-hidden="true" />
                        {pending ? 'Inviting…' : 'Invite'}
                      </Button>
                    </div>
                    {resolution && resolution.outcome !== 'accepted' && (
                      <p className="mt-1 text-[11px] capitalize text-[var(--ds-warning)]">
                        Invite {resolution.outcome}
                      </p>
                    )}
                    {q.last_message_at && (
                      <p className="mt-0.5 text-[11px] text-[var(--ds-text-subtle)]">
                        {relativeTime(q.last_message_at)} ago
                      </p>
                    )}
                  </div>
                );
              })
            )}
          </div>
          <TeamRoster roster={roster} />
        </div>

        {/* Centre — conversation */}
        <div className="min-h-[400px] border-b border-[var(--ds-border)] lg:border-b-0 xl:border-r">
          {selectedChat ? (
            <ConversationView
              key={selectedChat.session_id}
              chat={selectedChat}
              messages={selectedMessages}
              visitorTyping={Boolean(typingBySession[selectedChat.session_id])}
              presence={presenceBySession[selectedChat.session_id] ?? 'online'}
              visitorReadAt={visitorReadAtBySession[selectedChat.session_id]}
              connected={connected}
              closing={closingId === selectedChat.session_id}
              onSend={(content) => sendMessage(selectedChat.session_id, content)}
              onTyping={() => sendTyping(selectedChat.session_id)}
              onClose={() => void handleClose()}
              onTransfer={() => setTransferOpen(true)}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState
                icon={MessageSquare}
                title="No conversation selected"
                description="Accept a waiting visitor or pick an active conversation from the left to start chatting."
              />
            </div>
          )}
        </div>

        {/* Right — visitor details */}
        <div className="hidden xl:block">
          {selectedChat ? (
            <SessionDetailsPanel key={selectedChat.session_id} sessionId={selectedChat.session_id} />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-[var(--ds-text-subtle)]">
              Visitor details appear here once a conversation is open.
            </div>
          )}
        </div>
      </div>

      {selectedChat && transferOpen && (
        <TransferDialog
          sessionId={selectedChat.session_id}
          visitorName={selectedChat.visitor_name}
          currentOperatorId={operatorId}
          onClose={() => setTransferOpen(false)}
          onTransferred={() => {
            setTransferOpen(false);
            // WS `chat_transferred` clears the chat from the board.
          }}
        />
      )}
    </div>
  );
}
