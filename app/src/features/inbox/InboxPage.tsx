import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MessageSquare, UserPlus } from 'lucide-react';
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  LockedState,
  SplitPane,
  Spinner,
  Switch,
  buttonClass,
  toast,
  useMediaQuery,
} from '../../ui';
import { Link } from 'react-router-dom';
import { addSelfAsOperator, getCannedResponses } from '../../services/api';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useBotContext } from '../../context/BotContext';
import { useSelectedBotPlanSlug } from '../../hooks/useSelectedBotPlanSlug';
import { planIncludesVisitorIntelligence } from '../../lib/planGates';
import type { CannedResponse } from '../../types/domain';
import { ChatPane } from './ChatPane';
import { ConversationList } from './ConversationList';
import { InboxSocketProvider } from './InboxSocketContext';
import { useInboxSocket } from './inboxSocket';
import { OperatorLanguagePicker } from './OperatorLanguagePicker';
import { MessagePane } from './MessagePane';
import { SnippetsDrawer } from './SnippetsDrawer';
import { VisitorPanel } from './VisitorPanel';
import { profileFromSession, type VisitorProfile } from './visitorProfile';
import { useOfflineMessages } from './useOfflineMessages';
import { useOperatorStatus, type OperatorStatusState } from './useOperatorStatus';
import { useQualifiedSessions, useSessionDetails } from './inboxQueries';
import {
  DEFAULT_INBOX_VIEW,
  INBOX_SOURCE_VIEWS,
  INBOX_VIEWS,
  mergeViews,
  viewMeta,
  sessionIdFromItemId,
  toLiveItem,
  toOfflineItem,
  toQualifiedItem,
  toWaitingItem,
  type InboxItem,
  type InboxSourceView,
  type InboxView,
} from './inboxModel';
import type { ConnectionStatus } from './liveChatProtocol';
import { useTranslation } from '../../i18n/useTranslation';
import { t as translateNow } from '../../i18n/i18n';

/** How often the wait timers advance. One clock for the whole surface. */
const CLOCK_MS = 5000;

/** The connection word in the reader's language. */
function connectionLabel(status: ConnectionStatus): string {
  return translateNow(`inbox.connection.${status}`) || CONNECTION[status].label;
}

// @i18n-exempt: fallbacks, read through connectionLabel above.
const CONNECTION: Record<ConnectionStatus, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  idle: { label: 'Not connected', tone: 'neutral' },
  connecting: { label: 'Connecting', tone: 'warning' },
  connected: { label: 'Connected', tone: 'success' },
  reconnecting: { label: 'Reconnecting', tone: 'warning' },
  duplicate: { label: 'Open in another tab', tone: 'danger' },
};

/**
 * Scopes that can show live-chat rows, and so speak for the live connection.
 *
 * Everything except Messages, which is served over HTTP and keeps working when
 * the socket does not. This is what decides whether an empty list should
 * explain itself in terms of the connection ("you are not taking chats")
 * rather than in terms of the data.
 */
function showsLiveChat(view: InboxView): boolean {
  return view !== 'messages';
}

/**
 * Scopes that can show NOTHING BUT live-chat rows.
 *
 * `all` shows live rows and offline messages together, so an account without
 * the live-chat feature still has real rows to read there. Locking its centre
 * pane behind the upgrade wall — which is what treating it as a live-only
 * scope would do — would leave those messages selectable and unreadable.
 */
function isLiveOnlyView(view: InboxView): boolean {
  return showsLiveChat(view) && view !== 'all';
}

function parseView(raw: string | null): InboxView {
  return INBOX_VIEWS.includes(raw as InboxView) ? (raw as InboxView) : DEFAULT_INBOX_VIEW;
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
  // `enableOnMount`: opening the inbox is the act of sitting down at it. See
  // the option's own note for why it can only fire once per visit.
  const operator = useOperatorStatus(liveChat ? botId : undefined, { enableOnMount: true });

  // Connect only when this operator is genuinely on duty. A socket opened while
  // they are away routes visitors to a desk nobody is sitting at.
  const connect = liveChat && !operator.unavailable && operator.isOnline;

  // Having an operator seat is not the same as being at the desk. The
  // self-service reads that DESCRIBE the operator — their working language —
  // are theirs whether or not they are taking chats right now, so they are
  // gated on this rather than on the live connection.
  const isOperator = liveChat && !operator.loading && !operator.unavailable;

  return (
    <InboxSocketProvider enabled={connect} isOperator={isOperator}>
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
  const { t } = useTranslation();
  const socket = useInboxSocket();
  const [params, setParams] = useSearchParams();
  // `SplitPane` shows its third pane at 1152px of split width, which beside the
  // 224px rail is a 1376px viewport. The console used to promise three panes at
  // 1280 and could not honour it: at exactly 1280 the transcript was 392px wide.
  //
  // A collapsed rail widens the split, so the pane can appear a little before
  // this says so — which offers the drawer as well as the pane for a moment,
  // rather than neither. That is the right way round for the error to fall.
  const wide = useMediaQuery('(min-width: 1376px)');

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

  // The same gate the Leads drawer applies to the same field, read the same
  // way: per chatbot, because billing attaches to the Bot. `/session/{id}/
  // details` has no visitor-intelligence gate of its own, so without this a
  // workspace that has since dropped off Professional would still be shown the
  // company its old lookups resolved. `null` while the chatbot resolves holds
  // the gate closed rather than flashing paid data.
  const planSlug = useSelectedBotPlanSlug();
  const visitorIntelligence = planSlug !== null && planIncludesVisitorIntelligence(planSlug);

  // Connection trouble is announced, not laid out. Three `Alert`s used to render
  // between the header and the grid, so a reconnect resized the transcript and
  // the composer while the operator was typing into them.
  useEffect(() => {
    if (operator.error) toast.error(operator.error);
  }, [operator.error]);

  useEffect(() => {
    if (socket.lastError) toast.warning(socket.lastError);
  }, [socket.lastError]);

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

  const bySource: Record<InboxSourceView, InboxItem[]> = useMemo(
    () => ({ waiting, yours, messages, qualified: qualifiedItems }),
    [waiting, yours, messages, qualifiedItems],
  );

  const byView: Record<InboxView, InboxItem[]> = useMemo(
    () => ({ ...bySource, all: mergeViews(bySource) }),
    [bySource],
  );

  // One quantity: open conversations in the scope. It used to be *unread
  // messages* when anything was unread and *open conversations* otherwise, so
  // the number changed meaning without telling anyone. Unread is a separate
  // signal, carried as a dot on the switcher.
  //
  // `null` is "not counted", which is not the same as zero and is now visible
  // from every scope rather than only from the one that failed: with All in
  // front of the operator, a failed Messages fetch used to sit in the switcher
  // as a confident "Messages (0)". A total that is missing a source is not a
  // total either, so All drops its own count when any source is down.
  const countsUnknown = Boolean(offline.error) || Boolean(qualified.error);
  const counts: Record<InboxView, number | null> = useMemo(
    () => ({
      all: countsUnknown ? null : byView.all.length,
      waiting: waiting.length,
      yours: yours.length,
      messages: offline.error ? null : offline.total,
      qualified: qualified.error ? null : qualifiedItems.length,
    }),
    [
      countsUnknown,
      byView.all.length,
      waiting.length,
      yours.length,
      offline.total,
      offline.error,
      qualified.error,
      qualifiedItems.length,
    ],
  );

  const yoursUnread = yours.some((item) => item.unread > 0);
  const messagesUnread = messages.some((item) => item.unread > 0);
  const unread: Partial<Record<InboxView, boolean>> = useMemo(
    () => ({
      all: yoursUnread || messagesUnread,
      yours: yoursUnread,
      messages: messagesUnread,
    }),
    [yoursUnread, messagesUnread],
  );

  // All draws on both HTTP sources, so its retry has to mean both. The two
  // reloaders are pulled out by name because the hooks return a new state
  // object every render and depending on those would rebuild this every time.
  const { reload: reloadOffline } = offline;
  const { reload: reloadQualified } = qualified;
  const reloadSources = useCallback(() => {
    reloadOffline();
    reloadQualified();
  }, [reloadOffline, reloadQualified]);

  const items = byView[view];
  // Without live chat the only rows an account is entitled to are its offline
  // messages, which All shows alongside the rest. Filtering by kind rather than
  // by scope keeps that true in both places.
  const visibleItems = liveChat ? items : items.filter((item) => item.kind === 'offline');
  const selected = visibleItems.find((item) => item.id === selectedId) ?? null;

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

  // Whichever scope can show this row, preferring the one the operator is
  // already in. Without that preference All would never hold a selection: it
  // contains every row, so every lookup would match a narrower bucket first
  // and yank the operator out of the scope they chose.
  const scopeHolding = useCallback(
    (itemId: string): InboxView | undefined =>
      byView[view].some((item) => item.id === itemId)
        ? view
        : INBOX_SOURCE_VIEWS.find((candidate) => byView[candidate].some((item) => item.id === itemId)),
    [byView, view],
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
    setSelection(scopeHolding(target) ?? view, target);
  }, [legacySession, scopeHolding, view, setSelection]);

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
  // In All the row never leaves the list, so this does not fire at all.
  useEffect(() => {
    if (!selectedId || selected) return;
    const scope = scopeHolding(selectedId);
    if (scope && scope !== view) setSelection(scope, selectedId);
  }, [selectedId, selected, scopeHolding, view, setSelection]);

  const sessionId = selected?.sessionId ?? sessionIdFromItemId(selectedId);
  const details = useSessionDetails(selected && selected.kind !== 'offline' ? sessionId : null);

  const profile: VisitorProfile | null = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === 'offline') {
      const record = offline.messages.find((message) => message.id === selected.messageId);
      if (!record) return null;
      return {
        kind: 'offline',
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
        // An offline message is a form submission, not a conversation: it has
        // no resolved language and never reached the quotation flow.
        languageCode: null,
        quotation: null,
        // A form submission carries no session and so no IP lookup.
        network: null,
      };
    }
    return details.details ? profileFromSession(details.details, selected.name) : null;
  }, [selected, offline.messages, details.details]);

  async function joinLiveChat(): Promise<void> {
    setJoining(true);
    try {
      await addSelfAsOperator(botId);
      await operator.refresh();
      toast.success(t('inbox.youCanNowTakeLive') || 'You can now take live chats');
    } catch (err) {
      toast.error(t('inbox.couldNotAddYouAs') || 'Could not add you as an operator', {
        description: err instanceof Error ? err.message : t('inbox.pleaseTryAgain') || 'Please try again.',
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

  const connection = { ...CONNECTION[socket.status], label: connectionLabel(socket.status) };
  const offlineLive = showsLiveChat(view) && !operator.isOnline;

  // Two of the four sources are fetched over HTTP and can fail on their own.
  // A scope that reads one of them reports that failure directly, because the
  // failure IS the list. All reads both, and an error state replaces the list
  // it is drawn over: blanking rows that loaded fine because a second source
  // is down would hide more than it explains. So there the failure is shown
  // only when it is the reason there is nothing to read.
  const listLoading =
    view === 'all'
      ? offline.loading || qualified.loading
      : view === 'messages'
        ? offline.loading
        : view === 'qualified'
          ? qualified.loading
          : false;
  const sourceError =
    view === 'all'
      ? (offline.error ?? qualified.error)
      : view === 'messages'
        ? offline.error
        : view === 'qualified'
          ? qualified.error
          : null;
  const listError = view === 'all' && visibleItems.length > 0 ? null : sourceError;
  const listRetry = view === 'messages' ? offline.reload : view === 'qualified' ? qualified.reload : reloadSources;

  const emptyOverride =
    // A superseded tab first: it is the only one of these where the lists are
    // empty because this tab is not listening, rather than because there is
    // nothing to hear. Saying "nobody is waiting" there is a claim about the
    // world, and it is false — a visitor can be waiting in the other tab.
    liveChat && socket.status === 'duplicate' && showsLiveChat(view)
      ? {
          title: t('inbox.thisTabIsNotTheLiveOne') || 'This tab is not the live one',
          description:
            t('inbox.theInboxIsOpenInAnother') ||
            'The inbox is open in another tab, and only one can hold the connection. Take it over here to see who is waiting.',
          action: (
            <Button onClick={() => socket.reclaim()}>
              {t('inbox.useThisTab') || 'Use this tab'}
            </Button>
          ),
        }
      : liveChat && offlineLive && showsLiveChat(view)
      ? {
          title: t('inbox.youAreNotTakingChats') || 'You are not taking chats',
          description:
            t('inbox.turnYourselfOnAboveAnd') || 'Turn yourself on above and waiting visitors will appear here the moment they ask for a person.',
        }
      : liveChat && operator.unavailable && showsLiveChat(view)
        ? {
            title: t('inbox.youAreNotSetUp') || 'You are not set up to take chats',
            description: t('inbox.addYourselfAsAnOperator') || 'Add yourself as an operator on this workspace to see and answer live conversations.',
            action: (
              <Button onClick={() => void joinLiveChat()} loading={joining} disabled={joining}>
                <UserPlus aria-hidden />
                {t('inbox.addMeAsAnOperator') || 'Add me as an operator'}
              </Button>
            ),
          }
        : !liveChat && showsLiveChat(view)
          ? {
              title: t('inbox.liveChatIsNotOn') || 'Live chat is not on your plan',
              description:
                t('inbox.upgradeToAnswerVisitorsYourself') || 'Upgrade to answer visitors yourself, take over from the AI, and see who is on your site right now.',
              action: (
                <Link to="/billing" className={buttonClass('primary', 'sm')}>
                  {t('inbox.seePlans') || 'See plans'}
                </Link>
              ),
            }
          : null;

  const listPane = (
    <ConversationList
      view={view}
      onViewChange={(next) => setSelection(next, null)}
      counts={counts}
      unread={unread}
      items={visibleItems}
      selectedId={selectedId}
      onSelect={(item) => {
        setSelection(view, item.id);
        setDetailsOpen(false);
      }}
      query={query}
      onQueryChange={setQuery}
      loading={listLoading}
      error={listError}
      onRetry={listRetry}
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
              {t('inbox.previous') || 'Previous'}
            </Button>
            <span className="figure text-2xs text-text-tertiary">
              {t('inbox.pageOf', {
                page: offline.page,
                total: Math.max(1, Math.ceil(offline.total / offline.pageSize)),
              }) || `Page ${offline.page} of ${Math.max(1, Math.ceil(offline.total / offline.pageSize))}`}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={offline.page >= Math.ceil(offline.total / offline.pageSize)}
              onClick={() => offline.setPage(offline.page + 1)}
            >
              {t('inbox.next') || 'Next'}
            </Button>
          </div>
        ) : null
      }
    />
  );

  const centrePane = (() => {
    // Without live chat the upgrade wall belongs in front of live
    // conversations, not in front of an offline message the account is
    // entitled to read. In All that is a per-row distinction, so the selection
    // decides rather than the scope.
    if (!liveChat && (isLiveOnlyView(view) || (selected !== null && selected.kind !== 'offline'))) {
      return (
        <div className="flex h-full items-center justify-center bg-canvas p-6">
          <LockedState
            className="max-w-md"
            title={t('inbox.liveChatIsAPaid') || 'Live chat is a paid feature'}
            description={t('inbox.yourVisitorsCanStillLeave') || 'Your visitors can still leave you messages, and those are in the Messages scope. Upgrade to answer them in real time, take conversations over from the AI, and route them to your team.'}
            action={
              <Link to="/billing" className={buttonClass('primary')}>
                {t('inbox.seePlans') || 'See plans'}
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
            title={t('inbox.nothingOpen') || 'Nothing open'}
            description={viewMeta(view).blurb}
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
        onShowDetails={wide ? undefined : () => setDetailsOpen(true)}
      />
    );
  })();

  const visitorProps = {
    profile,
    sessionId: selected && selected.kind !== 'offline' ? sessionId : null,
    loading: details.loading,
    error: details.error,
    onRetry: details.reload,
    visitorIntelligence,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* A status strip, not a title bar. The shell's breadcrumb already renders
          "Inbox" in the 56px top bar; a second bordered bar under it repeating
          the word cost ~100px of chrome before any conversation. */}
      <header className="flex min-h-row shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-surface px-cell">
        <h1 className="sr-only">{t('inbox.inbox') || 'Inbox'}</h1>
        {liveChat && !operator.unavailable ? (
          <Badge tone={connection.tone} dot>
            {connection.label}
          </Badge>
        ) : null}

        <div className="ms-auto flex items-center gap-3">
          {!liveChat ? (
            <Link to="/billing" className={buttonClass('primary', 'sm')}>
              {t('inbox.addLiveChat') || 'Add live chat'}
            </Link>
          ) : operator.unavailable ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => void joinLiveChat()}
              loading={joining}
              disabled={joining}
            >
              <UserPlus aria-hidden />
              {t('inbox.addMeAsAnOperator') || 'Add me as an operator'}
            </Button>
          ) : (
            <>
              {/* The working language sits beside availability because both are
                  this operator's own settings for this desk, not workspace
                  configuration — and because the language decides what they can
                  read the moment they start taking chats. It appears only when
                  the chatbot actually offers a second language. */}
              {socket.operatorAvailableLocales.length > 0 ? (
                <OperatorLanguagePicker
                  value={socket.operatorLanguage}
                  availableLocales={socket.operatorAvailableLocales}
                  onChange={socket.setOperatorLanguage}
                />
              ) : null}
              <Switch
                checked={operator.isOnline}
                onCheckedChange={() => void operator.toggle()}
                disabled={operator.saving || operator.loading}
                label={t('inbox.takingChats') || 'Taking chats'}
              />
            </>
          )}
        </div>
      </header>

      {/* `SplitPane` keeps both panes mounted when the layout stacks, so a
          half-typed reply and a scroll position survive going back and forth —
          and it lets the operator drag the split and remembers where they put
          it. The duplicate-tab `Alert` that used to sit here is gone: the badge
          above already says "Open in another tab", and rendering a banner
          between the header and the grid resized the transcript and the
          composer under an operator who was mid-sentence. */}
      <SplitPane
        list={listPane}
        detail={centrePane}
        inspector={<VisitorPanel {...visitorProps} />}
        selected={Boolean(selected)}
        onBack={() => setSelection(view, null)}
        backLabel="Conversations"
        listWidth="md"
        resizable
        storageKey="oyechats.inbox.list-width"
        listLabel="Conversations"
        detailLabel="Conversation"
        inspectorLabel="Visitor"
      />

      {!wide ? (
        /* `xs` (320), not `sm` (448). This drawer stands in for the third
           pane at widths that cannot hold it, and the pane is 288 — at `sm`
           the same content sat in 448px with 128px of empty gutter beside it,
           and its property rows changed shape between the two presentations of
           one panel. `Drawer` documents `xs` as "the width of a pane… the
           inbox's visitor panel" for exactly this. */
        <Drawer open={detailsOpen} onOpenChange={setDetailsOpen} title={t('inbox.visitorDetails') || 'Visitor details'} width="xs">
          <VisitorPanel {...visitorProps} variant="drawer" />
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
