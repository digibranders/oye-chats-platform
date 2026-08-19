import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageSquare, UserPlus } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Drawer,
  EmptyState,
  LockedState,
  Spinner,
  Switch,
  buttonClass,
  cn,
  toast,
  useMediaQuery,
} from '../../ui';
import { Link } from 'react-router-dom';
import { addSelfAsOperator, getCannedResponses } from '../../services/api';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useBotContext } from '../../context/BotContext';
import type { CannedResponse } from '../../types/domain';
import { ChatPane } from './ChatPane';
import { ConversationList } from './ConversationList';
import { InboxSocketProvider } from './InboxSocketContext';
import { useInboxSocket } from './inboxSocket';
import { MessagePane } from './MessagePane';
import { SnippetsDrawer } from './SnippetsDrawer';
import { VisitorPanel } from './VisitorPanel';
import { profileFromSession, type VisitorProfile } from './visitorProfile';
import { useOfflineMessages } from './useOfflineMessages';
import { useOperatorStatus, type OperatorStatusState } from './useOperatorStatus';
import { useQualifiedSessions, useSessionDetails } from './inboxQueries';
import {
  INBOX_VIEWS,
  VIEW_META,
  sessionIdFromItemId,
  toLiveItem,
  toOfflineItem,
  toQualifiedItem,
  toWaitingItem,
  type InboxItem,
  type InboxView,
} from './inboxModel';
import type { ConnectionStatus } from './liveChatProtocol';

/** How often the wait timers advance. One clock for the whole surface. */
const CLOCK_MS = 5000;

const CONNECTION: Record<ConnectionStatus, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  idle: { label: 'Not connected', tone: 'neutral' },
  connecting: { label: 'Connecting', tone: 'warning' },
  connected: { label: 'Connected', tone: 'success' },
  reconnecting: { label: 'Reconnecting', tone: 'warning' },
  duplicate: { label: 'Open in another tab', tone: 'danger' },
};

function isLiveView(view: InboxView): boolean {
  return view !== 'messages';
}

function parseView(raw: string | null): InboxView {
  return INBOX_VIEWS.includes(raw as InboxView) ? (raw as InboxView) : 'waiting';
}

/**
 * The inbox.
 *
 * One page, one socket, one list. The socket is mounted here — above everything
 * that can change — because the connection corresponds to "this operator is at
 * their desk", not to whichever panel happens to be rendered. The console this
 * replaces mounted it inside a conditionally-rendered tab, so switching to
 * Messages closed `/ws/operator` and discarded every transcript, unread count,
 * presence flag and typing state on the board, mid-conversation.
 */
export function InboxPage() {
  const { selectedBot } = useBotContext();
  const botId = selectedBot?.id;
  const { hasFeature, loading: planLoading } = useEntitlements();
  const liveChat = hasFeature('live_chat');
  const operator = useOperatorStatus(liveChat ? botId : undefined);

  // Connect only when this operator is genuinely on duty. A socket opened while
  // they are away routes visitors to a desk nobody is sitting at.
  const connect = liveChat && !operator.unavailable && operator.isOnline;

  return (
    <InboxSocketProvider enabled={connect}>
      <InboxConsole botId={botId} operator={operator} liveChat={liveChat} planLoading={planLoading} />
    </InboxSocketProvider>
  );
}

interface ConsoleProps {
  botId: number | undefined;
  operator: OperatorStatusState;
  liveChat: boolean;
  planLoading: boolean;
}

function InboxConsole({ botId, operator, liveChat, planLoading }: ConsoleProps) {
  const socket = useInboxSocket();
  const [params, setParams] = useSearchParams();
  const wide = useMediaQuery('(min-width: 1280px)');
  const compact = useMediaQuery('(max-width: 767px)');

  const view = parseView(params.get('view'));
  const selectedId = params.get('c');
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [snippets, setSnippets] = useState<CannedResponse[]>([]);
  const [snippetsLoading, setSnippetsLoading] = useState(true);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [joining, setJoining] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const offline = useOfflineMessages(botId);
  const qualified = useQualifiedSessions(liveChat, socket.qualifiedVersion);

  // ── One clock, so wait times count up without a timer per row ──
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);

  // ── Saved replies, shared by the composer and the message pane ──
  const loadSnippets = useCallback(() => {
    setSnippetsLoading(true);
    getCannedResponses()
      .then((result) => setSnippets(result.responses ?? []))
      .catch(() => setSnippets([]))
      .finally(() => setSnippetsLoading(false));
  }, []);
  useEffect(loadSnippets, [loadSnippets]);

  // ── The four scopes, from four sources, in one shape ──
  const matchesBot = useCallback(
    (candidate: number | null): boolean => botId == null || candidate == null || candidate === botId,
    [botId],
  );

  const waiting = useMemo(
    () => socket.queue.filter((entry) => matchesBot(entry.bot_id)).map(toWaitingItem),
    [socket.queue, matchesBot],
  );

  const yours = useMemo(
    () =>
      Object.values(socket.activeChats)
        .filter((chat) => matchesBot(chat.bot_id))
        .map((chat) =>
          toLiveItem(
            chat,
            socket.messagesBySession[chat.session_id],
            socket.unreadBySession[chat.session_id] ?? 0,
            socket.presenceBySession[chat.session_id] !== 'disconnected',
            socket.endedBySession[chat.session_id],
          ),
        ),
    [
      socket.activeChats,
      socket.messagesBySession,
      socket.unreadBySession,
      socket.presenceBySession,
      socket.endedBySession,
      matchesBot,
    ],
  );

  const messages = useMemo(() => offline.messages.map(toOfflineItem), [offline.messages]);

  const qualifiedItems = useMemo(
    () => qualified.sessions.filter((session) => matchesBot(session.bot_id)).map(toQualifiedItem),
    [qualified.sessions, matchesBot],
  );

  const byView: Record<InboxView, InboxItem[]> = useMemo(
    () => ({ waiting, yours, messages, qualified: qualifiedItems }),
    [waiting, yours, messages, qualifiedItems],
  );

  const counts: Record<InboxView, number> = useMemo(
    () => ({
      waiting: waiting.length,
      yours: yours.reduce((total, item) => total + item.unread, 0) || yours.length,
      messages: offline.total,
      qualified: qualifiedItems.length,
    }),
    [waiting.length, yours, offline.total, qualifiedItems.length],
  );

  const items = byView[view];
  const selected = items.find((item) => item.id === selectedId) ?? null;

  const setSelection = useCallback(
    (next: InboxView, itemId: string | null) => {
      setParams(
        (current) => {
          const draft = new URLSearchParams(current);
          draft.set('view', next);
          if (itemId) draft.set('c', itemId);
          else draft.delete('c');
          draft.delete('session');
          return draft;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // ── Deep links ──
  // `?session=` is what the notification banner and the rail's waiting badge
  // link to. Resolve it to whichever scope actually holds that conversation
  // rather than assuming one — the previous page assumed "live", so a link to a
  // visitor still in the queue landed on an empty panel.
  const legacySession = params.get('session');
  useEffect(() => {
    if (!legacySession) return;
    const target = `s.${legacySession}`;
    const scope = INBOX_VIEWS.find((candidate) => byView[candidate].some((item) => item.id === target));
    setSelection(scope ?? view, target);
  }, [legacySession, byView, view, setSelection]);

  // A conversation that has left every scope (accepted by someone else,
  // transferred away) must not leave the centre pane showing a stale header.
  const knownIds = useMemo(
    () => new Set(INBOX_VIEWS.flatMap((candidate) => byView[candidate].map((item) => item.id))),
    [byView],
  );
  const previousKnown = useRef(knownIds);
  useEffect(() => {
    previousKnown.current = knownIds;
  }, [knownIds]);

  // Follow a conversation across scopes: accepting a waiting visitor moves the
  // same session from Waiting into Yours, and the operator should stay on it.
  useEffect(() => {
    if (!selectedId || selected) return;
    const scope = INBOX_VIEWS.find((candidate) => byView[candidate].some((item) => item.id === selectedId));
    if (scope && scope !== view) setSelection(scope, selectedId);
  }, [selectedId, selected, byView, view, setSelection]);

  const sessionId = selected?.sessionId ?? sessionIdFromItemId(selectedId);
  const details = useSessionDetails(selected && selected.kind !== 'offline' ? sessionId : null);

  const profile: VisitorProfile | null = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === 'offline') {
      const record = offline.messages.find((message) => message.id === selected.messageId);
      if (!record) return null;
      return {
        name: selected.name,
        email: record.visitor_email ?? null,
        phone: record.visitor_phone ?? null,
        company: null,
        location: null,
        device: null,
        pageUrl: null,
        referrer: null,
        botName: record.bot_name ?? null,
        departmentName: null,
        operatorName: null,
        startedAt: record.created_at ?? null,
        lastActiveAt: record.replied_at ?? record.read_at ?? null,
        messageCount: null,
        rating: null,
        handoffReason: null,
        bant: null,
      };
    }
    return details.details ? profileFromSession(details.details, selected.name) : null;
  }, [selected, offline.messages, details.details]);

  async function joinLiveChat(): Promise<void> {
    setJoining(true);
    try {
      await addSelfAsOperator(botId);
      await operator.refresh();
      toast.success('You can now take live chats');
    } catch (err) {
      toast.error('Could not add you as an operator', {
        description: err instanceof Error ? err.message : 'Please try again.',
      });
    } finally {
      setJoining(false);
    }
  }

  // ── Plan gate ──────────────────────────────────────────────────────────
  if (!liveChat && planLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  const connection = CONNECTION[socket.status];
  const offlineLive = isLiveView(view) && !operator.isOnline;

  const emptyOverride =
    liveChat && offlineLive && isLiveView(view)
      ? {
          title: 'You are not taking chats',
          description:
            'Turn yourself on above and waiting visitors will appear here the moment they ask for a person.',
        }
      : liveChat && operator.unavailable && isLiveView(view)
        ? {
            title: 'You are not set up to take chats',
            description: 'Add yourself as an operator on this workspace to see and answer live conversations.',
            action: (
              <Button onClick={() => void joinLiveChat()} loading={joining} disabled={joining}>
                <UserPlus aria-hidden className="h-4 w-4" />
                Add me as an operator
              </Button>
            ),
          }
        : !liveChat && isLiveView(view)
          ? {
              title: 'Live chat is not on your plan',
              description:
                'Upgrade to answer visitors yourself, take over from the AI, and see who is on your site right now.',
              action: (
                <Link to="/billing" className={buttonClass('primary', 'sm')}>
                  See plans
                </Link>
              ),
            }
          : null;

  const listPane = (
    <ConversationList
      view={view}
      onViewChange={(next) => setSelection(next, null)}
      counts={counts}
      items={liveChat || view === 'messages' ? items : []}
      selectedId={selectedId}
      onSelect={(item) => {
        setSelection(view, item.id);
        if (compact) setDetailsOpen(false);
      }}
      query={query}
      onQueryChange={setQuery}
      loading={view === 'messages' ? offline.loading : view === 'qualified' ? qualified.loading : false}
      error={view === 'messages' ? offline.error : view === 'qualified' ? qualified.error : null}
      onRetry={view === 'messages' ? offline.reload : qualified.reload}
      now={now}
      emptyOverride={emptyOverride}
      footer={
        view === 'messages' && offline.total > offline.pageSize ? (
          <div className="flex items-center justify-between gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={offline.page <= 1}
              onClick={() => offline.setPage(offline.page - 1)}
            >
              Previous
            </Button>
            <span className="figure text-2xs text-text-tertiary">
              Page {offline.page} of {Math.max(1, Math.ceil(offline.total / offline.pageSize))}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={offline.page >= Math.ceil(offline.total / offline.pageSize)}
              onClick={() => offline.setPage(offline.page + 1)}
            >
              Next
            </Button>
          </div>
        ) : null
      }
    />
  );

  const centrePane = (() => {
    if (!liveChat && isLiveView(view)) {
      return (
        <div className="flex h-full items-center justify-center bg-canvas p-6">
          <LockedState
            className="max-w-md"
            title="Live chat is a paid feature"
            description="Your visitors can still leave you messages — those are in the Messages scope. Upgrade to answer them in real time, take conversations over from the AI, and route them to your team."
            action={
              <Link to="/billing" className={buttonClass('primary')}>
                See plans
              </Link>
            }
          />
        </div>
      );
    }
    if (!selected) {
      return (
        <div className="flex h-full items-center justify-center bg-canvas p-6">
          <EmptyState
            icon={MessageSquare}
            title="Nothing open"
            description={VIEW_META[view].blurb}
          />
        </div>
      );
    }
    if (selected.kind === 'offline') {
      const record = offline.messages.find((message) => message.id === selected.messageId);
      if (!record) return null;
      return (
        <MessagePane
          key={selected.id}
          message={record}
          snippets={snippets}
          onManageSnippets={() => setSnippetsOpen(true)}
          onStatusChange={offline.updateStatus}
          onDelete={async (id) => {
            await offline.remove(id);
            setSelection(view, null);
          }}
          onBack={compact ? () => setSelection(view, null) : undefined}
        />
      );
    }
    return (
      <ChatPane
        key={selected.id}
        item={selected}
        draft={drafts[selected.id] ?? ''}
        onDraftChange={(value) => setDrafts((current) => ({ ...current, [selected.id]: value }))}
        snippets={snippets}
        onManageSnippets={() => setSnippetsOpen(true)}
        now={now}
        onLeft={() => setSelection(view, null)}
        onBack={compact ? () => setSelection(view, null) : undefined}
        onShowDetails={wide ? undefined : () => setDetailsOpen(true)}
      />
    );
  })();

  const visitorPane = (
    <VisitorPanel
      profile={profile}
      sessionId={selected && selected.kind !== 'offline' ? sessionId : null}
      loading={details.loading}
      error={details.error}
      onRetry={details.reload}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-4 py-2.5 md:px-6">
        <h1 className="text-lg font-semibold text-text-primary">Inbox</h1>
        {liveChat && !operator.unavailable ? (
          <Badge tone={connection.tone} dot>
            {connection.label}
          </Badge>
        ) : null}

        <div className="ml-auto flex items-center gap-3">
          {!liveChat ? (
            <Link to="/billing" className={buttonClass('primary', 'sm')}>
              Add live chat
            </Link>
          ) : operator.unavailable ? (
            <Button size="sm" onClick={() => void joinLiveChat()} loading={joining} disabled={joining}>
              <UserPlus aria-hidden className="h-4 w-4" />
              Add me as an operator
            </Button>
          ) : (
            <Switch
              checked={operator.isOnline}
              onCheckedChange={() => void operator.toggle()}
              disabled={operator.saving || operator.loading}
              label="Taking chats"
            />
          )}
        </div>
      </header>

      {operator.error ? (
        <Alert tone="danger" live className="mx-4 mt-3 md:mx-6">
          {operator.error}
        </Alert>
      ) : null}
      {socket.status === 'duplicate' ? (
        <Alert tone="warning" live className="mx-4 mt-3 md:mx-6" title="The inbox is open in another tab">
          Only one tab can hold your live-chat connection. Close the other tab, or take over by turning yourself off
          and on again here.
        </Alert>
      ) : null}
      {socket.lastError ? (
        <Alert tone="warning" className="mx-4 mt-3 md:mx-6">
          {socket.lastError}
        </Alert>
      ) : null}

      <div
        className={cn(
          'grid min-h-0 flex-1',
          compact
            ? 'grid-cols-1'
            : wide
              ? 'grid-cols-[20rem_minmax(0,1fr)_20rem]'
              : 'grid-cols-[18rem_minmax(0,1fr)]',
        )}
      >
        {/* On a phone the list and the conversation are the same column: one is
            shown at a time, which is what the back control in the pane header is
            for. Rendering both and hiding one keeps scroll positions and drafts. */}
        <div className={cn('min-h-0', compact && selected && 'hidden')}>{listPane}</div>
        <div className={cn('min-h-0', compact && !selected && 'hidden')}>{centrePane}</div>
        {wide ? <div className="min-h-0">{visitorPane}</div> : null}
      </div>

      {!wide ? (
        <Drawer
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          title="Visitor details"
          width="sm"
          className="p-0"
        >
          {visitorPane}
        </Drawer>
      ) : null}

      <SnippetsDrawer
        open={snippetsOpen}
        onOpenChange={setSnippetsOpen}
        snippets={snippets}
        loading={snippetsLoading}
        onChanged={loadSnippets}
      />
    </div>
  );
}
