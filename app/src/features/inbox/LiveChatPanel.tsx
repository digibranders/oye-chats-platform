import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  AlertCircle,
  Inbox,
  Loader2,
  Lock,
  MessageSquare,
  Radio,
  Sparkles,
  UserPlus,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { Button, EmptyState, IconTile, InsightCard, Skeleton, StatusBadge, cn } from '../../design-system';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import {
  acceptChat,
  addSelfAsOperator,
  cancelConnectRequest,
  closeOperatorChat,
  getCannedResponses,
  getChatHistory,
  getQualifiedBotSessions,
  resolveOperatorChat,
  sendConnectRequest,
  translateForSession,
  uploadOperatorChatFile,
} from '../../services/api';
import { type CannedResponse } from '../../types/domain';
import { type OperatorStatusState } from './useOperatorStatus';
import { useOperatorSocket } from './useOperatorSocket';
import { ConversationView } from './ConversationView';
import { SessionDetailsPanel } from './SessionDetailsPanel';
import { OperatorLanguagePicker } from './OperatorLanguagePicker';
import { TransferDialog } from './TransferDialog';
import type { ConnectionStatus, OperatorMessage, QualifiedSession, RosterOperator } from './liveChatProtocol';
import { clockTime, initials, maxVisitorDbId, parseHistoryMessage, relativeTime } from './liveChatHelpers';
import { useTranslation } from '../../i18n/useTranslation';
import { t as translateNow } from '../../i18n/i18n';

export interface LiveChatPanelProps {
  operator: OperatorStatusState;
  /** Active agent - scopes the queue / active / qualified lists to this bot. */
  botId?: number;
}

// ── Presentational helpers (non-exported; component file exports only LiveChatPanel) ──

const CONNECTION_META: Record<ConnectionStatus, { label: string; tone: 'success' | 'warning' | 'neutral' | 'danger' }> =
  {
    idle: { label: 'Offline', tone: 'neutral' },
    connecting: { label: 'Connecting…', tone: 'warning' },
    connected: { label: 'Connected', tone: 'success' },
    reconnecting: { label: 'Reconnecting…', tone: 'warning' },
    duplicate: { label: translateNow('inbox.liveChat.openInAnotherTab') || 'Open in another tab', tone: 'danger' },
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

function RailSection({
  icon,
  label,
  count,
}: {
  icon: ReactElement;
  label: string;
  /** Optional so gated sections can hide the "(N)" tail (a locked rail
   *  never has a meaningful count to report). */
  count?: number;
}): ReactElement {
  return (
    <div className="flex items-center gap-2 px-1 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide">
      <span className="text-[var(--ds-text-subtle)]" aria-hidden="true">
        {icon}
      </span>
      <span className="text-[var(--ds-text)]">{label}</span>
      {count !== undefined && <span className="text-[var(--ds-text-subtle)]">({count})</span>}
    </div>
  );
}

function TeamRoster({ roster }: { roster: RosterOperator[] }): ReactElement | null {
  const { t } = useTranslation();
  if (roster.length === 0) return null;
  return (
    <div className="border-t border-[var(--ds-border)] p-4">
      <p className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]">
        <Users size={13} aria-hidden="true" /> {t('inbox.liveChat.team') || 'Team'}
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

/** Human-facing role label for the read-only AI transcript preview. */
function previewRoleLabel(role: OperatorMessage['role']): string {
  switch (role) {
    case 'user':
      return 'Visitor';
    case 'bot':
      return 'AI';
    case 'operator':
      return 'Operator';
    default:
      return 'System';
  }
}

/**
 * LiveChatPanel - the real-time operator console.
 *
 * A three-pane workspace (queue/active/qualified · conversation · visitor details)
 * backed by the `/ws/operator` WebSocket. Operators set availability, accept
 * waiting visitors, run multiple simultaneous conversations, transfer or close
 * them, see typing + presence + read receipts, and proactively invite qualified
 * bot-mode visitors into a human chat.
 */
export function LiveChatPanel({ operator, botId }: LiveChatPanelProps): ReactElement {
  const { t } = useTranslation();
  const { isOnline, unavailable, saving, loading, error: availabilityError, toggle } = operator;
  const enabled = isOnline && !unavailable;
  // Having an operator profile is not the same as being online: the working
  // language is readable either way.
  const isOperator = !unavailable;

  const socket = useOperatorSocket({ enabled, isOperator });
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
    hasMoreBySession,
    lastError,
    operatorLanguage,
    operatorAvailableLocales,
    setOperatorLanguage,
    sendMessage,
    sendFile,
    sendTyping,
    sendReadReceipt,
    loadHistory,
    loadOlder,
    clearUnread,
  } = socket;

  const connected = status === 'connected';

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [qualified, setQualified] = useState<QualifiedSession[]>([]);
  const [qualifiedLoaded, setQualifiedLoaded] = useState(false);
  const { hasFeature } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();
  // BANT/MEDDIC scoring is Standard+. On Free/Starter the RAG pipeline
  // skips scoring (rag_service.py → is_bant_enabled_for_bot), so
  // `qualified` will stay empty forever. Rendering the empty rail as-is
  // reads as "nothing to see here" instead of "you're not entitled to
  // this signal". Swap it for an honest lock nudge.
  const bantUnlocked = hasFeature('bant');
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [awaitingConnect, setAwaitingConnect] = useState<Record<string, boolean>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [cannedResponses, setCannedResponses] = useState<CannedResponse[]>([]);
  const [previewSession, setPreviewSession] = useState<QualifiedSession | null>(null);
  const [previewMessages, setPreviewMessages] = useState<OperatorMessage[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [addingSelf, setAddingSelf] = useState(false);
  const [addSelfError, setAddSelfError] = useState<string | null>(null);
  const loadedHistoryRef = useRef<Set<string>>(new Set());

  // ── Canned responses (loaded once for the composer slash menu) ──
  useEffect(() => {
    let cancelled = false;
    getCannedResponses()
      .then((res) => {
        if (!cancelled) setCannedResponses(res.responses);
      })
      .catch(() => {
        if (!cancelled) setCannedResponses([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
  // pane falls back to its empty state - no effect / setState needed.

  // Drop the history-loaded marker for any session that has left the board so a
  // future chat reusing the id re-fetches its transcript (the socket hook has
  // already pruned that session's messages). Ref-only mutation - no setState.
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
      setPreviewSession(null);
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
          setActionError(err instanceof Error ? `Couldn’t accept chat: ${err.message}` : translateNow('inbox.liveChat.acceptFailed') || 'Couldn’t accept chat.');
        }
      } finally {
        setAcceptingId(null);
      }
    },
    [acceptingId, operatorId, loadHistory],
  );

  const handleClose = useCallback(async (): Promise<void> => {
    if (!selectedId || closingId || resolvingId) return;
    setClosingId(selectedId);
    setActionError(null);
    try {
      await closeOperatorChat(selectedId);
      // WS `chat_closed` removes it from the board + clears selection.
    } catch (err) {
      setActionError(
        err instanceof Error ? `Couldn’t return chat to AI: ${err.message}` : translateNow('inbox.liveChat.returnFailed') || 'Couldn’t return chat to AI.',
      );
    } finally {
      setClosingId(null);
    }
  }, [selectedId, closingId, resolvingId]);

  const handleResolve = useCallback(async (): Promise<void> => {
    if (!selectedId || closingId || resolvingId) return;
    setResolvingId(selectedId);
    setActionError(null);
    try {
      await resolveOperatorChat(selectedId);
      // WS `chat_closed` removes it from the board + clears selection.
    } catch (err) {
      setActionError(err instanceof Error ? `Couldn’t resolve chat: ${err.message}` : translateNow('inbox.liveChat.resolveFailed') || 'Couldn’t resolve chat.');
    } finally {
      setResolvingId(null);
    }
  }, [selectedId, closingId, resolvingId]);

  const handleConnectRequest = useCallback(
    async (sessionId: string): Promise<void> => {
      if (connectingId) return;
      setConnectingId(sessionId);
      setActionError(null);
      try {
        await sendConnectRequest(sessionId, operatorId);
        setAwaitingConnect((prev) => ({ ...prev, [sessionId]: true }));
      } catch (err) {
        setActionError(
          err instanceof Error ? `Couldn’t send invite: ${err.message}` : translateNow('inbox.liveChat.inviteFailed') || 'Couldn’t send connect invite.',
        );
      } finally {
        setConnectingId(null);
      }
    },
    [connectingId, operatorId],
  );

  const handleCancelConnect = useCallback(
    async (sessionId: string): Promise<void> => {
      if (cancellingId) return;
      setCancellingId(sessionId);
      setActionError(null);
      try {
        await cancelConnectRequest(sessionId);
        setAwaitingConnect((prev) => {
          if (!(sessionId in prev)) return prev;
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
      } catch (err) {
        setActionError(
          err instanceof Error ? `Couldn’t cancel invite: ${err.message}` : translateNow('inbox.liveChat.cancelInviteFailed') || 'Couldn’t cancel connect invite.',
        );
      } finally {
        setCancellingId(null);
      }
    },
    [cancellingId],
  );

  const handleAddSelf = useCallback(async (): Promise<void> => {
    if (addingSelf) return;
    setAddingSelf(true);
    setAddSelfError(null);
    try {
      await addSelfAsOperator(botId);
      await operator.refresh();
    } catch (err) {
      setAddSelfError(
        err instanceof Error ? `Couldn’t assign you as an operator: ${err.message}` : translateNow('inbox.liveChat.assignFailed') || 'Couldn’t assign you as an operator.',
      );
    } finally {
      setAddingSelf(false);
    }
  }, [addingSelf, botId, operator]);

  const openPreview = useCallback((session: QualifiedSession): void => {
    setPreviewSession(session);
    setPreviewMessages([]);
    setPreviewLoading(true);
  }, []);

  const closePreview = useCallback((): void => {
    setPreviewSession(null);
  }, []);

  // ── Ctrl/Cmd+1..9 jumps to the Nth active conversation ──
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key.length !== 1 || e.key < '1' || e.key > '9') return;
      if (transferOpen || previewSession) return;
      const target = visibleActive[Number(e.key) - 1];
      if (!target) return;
      e.preventDefault();
      openChat(target.session_id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visibleActive, openChat, transferOpen, previewSession]);

  // ── Read-only AI transcript preview: initial fetch + 4s poll while open ──
  useEffect(() => {
    if (!previewSession) return;
    const sid = previewSession.session_id;
    let active = true;
    const fetchTranscript = async (): Promise<void> => {
      try {
        const history = await getChatHistory(sid, { limit: 50 });
        if (active) setPreviewMessages(history.map(parseHistoryMessage));
      } catch {
        // Keep the last-known transcript on a transient poll failure.
      } finally {
        if (active) setPreviewLoading(false);
      }
    };
    void fetchTranscript();
    const interval = window.setInterval(() => {
      void fetchTranscript();
    }, 4000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [previewSession]);

  // ── Escape closes the preview while it is open ──
  useEffect(() => {
    if (!previewSession) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setPreviewSession(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewSession]);

  // ── Availability bar (always shown) ──
  const availabilityBar = (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5">
      <div className="flex items-center gap-3">
        <IconTile
          icon={isOnline ? Radio : WifiOff}
          tone={loading ? 'neutral' : unavailable ? 'warning' : isOnline ? 'success' : 'neutral'}
          size="md"
        />
        <div>
          <p className="text-[14px] font-semibold text-[var(--ds-text)]">{t('inbox.liveChat.yourAvailability') || 'Your availability'}</p>
          <p className="text-[13px] text-[var(--ds-text-muted)]">
            {loading
              ? t('inbox.liveChat.checkingAvailability') || 'Checking your availability…'
              : unavailable
                ? t('inbox.liveChat.notOperator') || 'You’re not set up as a live-chat operator in this workspace yet.'
                : isOnline
                  ? t('inbox.liveChat.online') || 'You’re online and can receive live conversations.'
                  : t('inbox.liveChat.offline') || 'You’re offline. Visitors will be offered the message form instead.'}
          </p>
        </div>
      </div>
      {loading ? (
        <Skeleton className="h-8 w-40 rounded-lg" />
      ) : unavailable ? (
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center gap-3">
            <StatusBadge tone="neutral">{t('inbox.liveChat.notAnOperator') || 'Not an operator'}</StatusBadge>
            <Button size="sm" onClick={() => void handleAddSelf()} disabled={addingSelf}>
              {addingSelf ? (
                <>
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  {t('inbox.assigning') || 'Assigning…'}
                </>
              ) : (
                <>
                  <UserPlus size={14} aria-hidden="true" />
                  {t('inbox.liveChat.assignSelf') || 'Assign myself as operator'}
                </>
              )}
            </Button>
          </div>
          {addSelfError && <p className="text-[12px] text-[var(--ds-danger)]">{addSelfError}</p>}
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <OperatorLanguagePicker
            value={operatorLanguage}
            availableLocales={operatorAvailableLocales}
            onChange={setOperatorLanguage}
          />
          <div className="flex items-center gap-3">
            {enabled && status !== 'connected' && <ConnectionPill status={status} />}
            <StatusBadge tone={isOnline ? 'success' : 'neutral'} dot>
              {isOnline ? 'Online' : 'Offline'}
            </StatusBadge>
            <Button variant="outline" size="sm" onClick={() => void toggle()} disabled={saving}>
              {saving ? 'Saving…' : isOnline ? t('inbox.liveChat.goOffline') || 'Go offline' : t('inbox.liveChat.goOnline') || 'Go online'}
            </Button>
          </div>
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
          title={unavailable ? t('inbox.liveChat.unavailableTitle') || 'Live chat isn’t available for you yet' : t('inbox.liveChat.goOnlineTitle') || 'Go online to start taking chats'}
          description={
            unavailable
              ? t('inbox.liveChat.unavailableBody') ||
                'Assign yourself as an operator below to start receiving real-time conversations from visitors on this chatbot.'
              : t('inbox.liveChat.goOnlineBody') ||
                'Flip your availability to online and waiting visitors, your active conversations, and qualified AI Chatbot chats will appear here in real time.'
          }
          action={
            unavailable ? (
              <Button size="sm" onClick={() => void handleAddSelf()} disabled={addingSelf}>
                {addingSelf ? (
                  <>
                    <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    {t('inbox.assigning') || 'Assigning…'}
                  </>
                ) : (
                  <>
                    <UserPlus size={14} aria-hidden="true" />
                    {t('inbox.liveChat.assignSelf') || 'Assign myself as operator'}
                  </>
                )}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  // ── Read-only preview action state (derived) ──
  const previewResolution = previewSession ? connectResolutions[previewSession.session_id] : undefined;
  const previewPending = previewSession ? connectingId === previewSession.session_id : false;
  const previewCancelling = previewSession ? cancellingId === previewSession.session_id : false;
  const previewAwaiting = previewSession
    ? (awaitingConnect[previewSession.session_id] ?? false) && !previewResolution
    : false;

  return (
    <div className="space-y-4">
      {availabilityBar}
      {errorBanner}

      {status === 'duplicate' && (
        <InsightCard
          tone="warning"
          title={t('inbox.liveChat.openInAnotherTabTitle') || 'Live chat is open in another tab'}
          body="Only one live-chat session can run per operator. Close the other tab, then reload this one to take over here."
        />
      )}

      <div className="grid min-h-[600px] grid-cols-1 overflow-hidden rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] lg:grid-cols-[280px_1fr] xl:grid-cols-[280px_1fr_300px]">
        {/* Left rail - queue / active / qualified */}
        <div className="flex max-h-[720px] flex-col overflow-y-auto border-b border-[var(--ds-border)] lg:border-b-0 lg:border-r">
          <div className="flex-1 space-y-1 p-3">
            <RailSection icon={<Inbox size={13} />} label={t('inbox.liveChat.waiting') || 'Waiting'} count={visibleQueue.length} />
            {visibleQueue.length === 0 ? (
              <p className="px-1 py-2 text-[12px] text-[var(--ds-text-subtle)]">No one is waiting.</p>
            ) : (
              visibleQueue.map((q) => (
                <RailButton
                  key={q.session_id}
                  active={false}
                  onClick={() => void handleAccept(q.session_id)}
                  title={q.name || 'Anonymous'}
                  subtitle={q.reason || q.bot_name || t('inbox.liveChat.waitingForOperator') || 'Waiting for an operator'}
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

            <RailSection icon={<MessageSquare size={13} />} label={t('inbox.liveChat.active') || 'Active'} count={visibleActive.length} />
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

            <RailSection
              icon={
                bantUnlocked ? (
                  <Sparkles size={13} />
                ) : (
                  <Lock size={12} strokeWidth={1.75} />
                )
              }
              label={t('inbox.liveChat.chattingWithAi') || 'Chatting with AI'}
              count={bantUnlocked ? visibleQualified.length : undefined}
            />
            {!bantUnlocked ? (
              <button
                type="button"
                onClick={() => openUpgradeModal('view_qualification')}
                title={t('inbox.liveChat.upgradeQualified') || 'Upgrade to unlock qualified AI chats'}
                className="flex w-full items-center justify-between gap-2 rounded-[var(--ds-radius-md)] border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-3 py-2 text-left transition-colors hover:border-[var(--ds-border-strong)] hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
              >
                <span className="truncate text-[12px] text-[var(--ds-text-muted)]">
                  {t('inbox.liveChat.availableOnStandard') || 'Available on Standard'}
                </span>
                <span className="shrink-0 text-[12px] font-medium text-[var(--ds-accent-text)]">
                  {t('inbox.liveChat.upgrade') || 'Upgrade'}
                </span>
              </button>
            ) : !qualifiedLoaded ? (
              <div className="space-y-1.5 px-1 py-1">
                <Skeleton className="h-10 w-full rounded-lg" />
                <Skeleton className="h-10 w-full rounded-lg" />
              </div>
            ) : visibleQualified.length === 0 ? (
              <p className="px-1 py-2 text-[12px] text-[var(--ds-text-subtle)]">{t('inbox.liveChat.noQualified') || 'No qualified AI Chatbot chats right now.'}</p>
            ) : (
              visibleQualified.map((q) => {
                const resolution = connectResolutions[q.session_id];
                const pending = connectingId === q.session_id;
                const cancelling = cancellingId === q.session_id;
                const awaiting = (awaitingConnect[q.session_id] ?? false) && !resolution;
                const previewing = previewSession?.session_id === q.session_id;
                return (
                  <div
                    key={q.session_id}
                    className={cn(
                      'rounded-[var(--ds-radius-lg)] border px-3 py-2.5',
                      previewing
                        ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-soft)]'
                        : 'border-transparent hover:bg-[var(--ds-bg-hover)]',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        onClick={() => openPreview(q)}
                        className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]"
                        aria-label={`Preview conversation with ${q.name}`}
                      >
                        <span className="block truncate text-[13px] font-medium text-[var(--ds-text)]">{q.name}</span>
                        <span className="block truncate text-[12px] text-[var(--ds-text-muted)]">
                          {q.last_message_preview || `${q.bant_tier} · ${q.bant_dimensions_count}/4 signals`}
                        </span>
                      </button>
                      {awaiting ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleCancelConnect(q.session_id)}
                          disabled={cancelling}
                        >
                          <X size={13} aria-hidden="true" />
                          {cancelling ? 'Cancelling…' : 'Cancel'}
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleConnectRequest(q.session_id)}
                          disabled={pending || resolution?.outcome === 'accepted'}
                        >
                          <UserPlus size={13} aria-hidden="true" />
                          {pending ? 'Inviting…' : 'Invite'}
                        </Button>
                      )}
                    </div>
                    {awaiting && <p className="mt-1 text-[11px] text-[var(--ds-text-muted)]">{t('inbox.liveChat.awaitingReply') || 'Awaiting reply…'}</p>}
                    {resolution && resolution.outcome !== 'accepted' && (
                      <p className="mt-1 text-[11px] capitalize text-[var(--ds-warning)]">
                        {t('inbox.liveChat.invite') || 'Invite'} {resolution.outcome}
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

        {/* Centre - conversation */}
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
              resolving={resolvingId === selectedChat.session_id}
              hasMore={hasMoreBySession[selectedChat.session_id] ?? false}
              onLoadOlder={() => loadOlder(selectedChat.session_id)}
              cannedResponses={cannedResponses}
              onSend={(content) => sendMessage(selectedChat.session_id, content)}
              onTyping={() => sendTyping(selectedChat.session_id)}
              onClose={() => void handleClose()}
              onResolve={() => void handleResolve()}
              onTransfer={() => setTransferOpen(true)}
              operatorLanguage={operatorLanguage}
              onRetryTranslation={async (messageId) => {
                // Bounded, operator-initiated backfill: one message, on
                // demand. Never an eager sweep of the transcript, which is
                // what a transfer between differently-configured operators
                // would otherwise trigger at the worst possible moment.
                const target = selectedChat.session_id;
                const source = (messagesBySession[target] ?? []).find((m) => m.dbId === messageId);
                if (!source) return;
                await translateForSession(target, source.content, messageId);
                // The result is persisted server-side; refresh this thread so
                // the bubble picks it up through the same path a reload uses.
                await loadHistory(target);
              }}
              onUploadFile={async (file) => {
                const res = await uploadOperatorChatFile(file, selectedChat.session_id);
                sendFile(selectedChat.session_id, res);
              }}
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6">
              <EmptyState
                icon={MessageSquare}
                title={t('inbox.liveChat.noConversation') || 'No conversation selected'}
                description="Accept a waiting visitor or pick an active conversation from the left to start chatting."
              />
            </div>
          )}
        </div>

        {/* Right - visitor details */}
        <div className="hidden xl:block">
          {selectedChat ? (
            <SessionDetailsPanel key={selectedChat.session_id} sessionId={selectedChat.session_id} />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-center text-[13px] text-[var(--ds-text-subtle)]">
              {t('inbox.liveChat.detailsHint') || 'Visitor details appear here once a conversation is open.'}
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

      {/* Read-only AI transcript preview */}
      {previewSession && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ds-overlay)] p-4"
          role="dialog"
          aria-modal="true"
          aria-label={`Conversation preview - ${previewSession.name}`}
        >
          <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-lg">
            {/* Header */}
            <div className="flex items-start justify-between gap-3 border-b border-[var(--ds-border)] px-4 py-3">
              <div className="min-w-0">
                <p className="truncate text-[14px] font-semibold text-[var(--ds-text)]">{previewSession.name}</p>
                {previewSession.company && (
                  <p className="truncate text-[12px] text-[var(--ds-text-muted)]">{previewSession.company}</p>
                )}
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <StatusBadge tone="accent">{previewSession.bant_tier}</StatusBadge>
                  <span className="text-[11px] text-[var(--ds-text-muted)]">
                    {t('inbox.liveChat.score') || 'Score'} {previewSession.bant_score} · {previewSession.bant_dimensions_count}/4 signals
                  </span>
                </div>
              </div>
              <Button variant="ghost" size="sm" onClick={closePreview} aria-label={t('inbox.liveChat.closePreview') || 'Close preview'}>
                <X size={15} aria-hidden="true" />
              </Button>
            </div>

            {/* Read-only transcript */}
            <div className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
              {previewLoading && previewMessages.length === 0 ? (
                <div className="space-y-2">
                  <Skeleton className="h-10 w-3/4 rounded-lg" />
                  <Skeleton className="h-10 w-2/3 rounded-lg" />
                  <Skeleton className="h-10 w-3/5 rounded-lg" />
                </div>
              ) : previewMessages.length === 0 ? (
                <p className="py-6 text-center text-[13px] text-[var(--ds-text-subtle)]">{t('inbox.liveChat.noMessages') || 'No messages yet.'}</p>
              ) : (
                previewMessages.map((m) => {
                  const isVisitor = m.role === 'user';
                  return (
                    <div
                      key={m.key}
                      className={cn('flex flex-col gap-0.5', isVisitor ? 'items-start' : 'items-end')}
                    >
                      <span className="px-1 text-[11px] font-medium text-[var(--ds-text-subtle)]">
                        {previewRoleLabel(m.role)}
                      </span>
                      <div
                        className={cn(
                          'max-w-[80%] rounded-[var(--ds-radius-lg)] px-3.5 py-2 text-[14px] leading-relaxed',
                          isVisitor
                            ? 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text)]'
                            : 'bg-[var(--ds-accent-soft)] text-[var(--ds-text)]',
                        )}
                      >
                        <span className="whitespace-pre-wrap break-words">{m.content}</span>
                      </div>
                      {m.timestamp && (
                        <span className="px-1 text-[11px] text-[var(--ds-text-subtle)]">{clockTime(m.timestamp)}</span>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Actions - mirror the qualified-row Connect/Cancel controls */}
            <div className="flex items-center justify-end gap-2 border-t border-[var(--ds-border)] px-4 py-3">
              {previewAwaiting ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleCancelConnect(previewSession.session_id)}
                  disabled={previewCancelling}
                >
                  <X size={14} aria-hidden="true" />
                  {previewCancelling ? 'Cancelling…' : t('inbox.liveChat.cancelInvite') || 'Cancel invite'}
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => void handleConnectRequest(previewSession.session_id)}
                  disabled={previewPending || previewResolution?.outcome === 'accepted'}
                >
                  <UserPlus size={14} aria-hidden="true" />
                  {previewPending ? 'Inviting…' : t('inbox.liveChat.inviteToChat') || 'Invite to chat'}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
