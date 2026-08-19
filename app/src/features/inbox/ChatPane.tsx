import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRightLeft, Bot, CheckCircle2, PanelRight, Sparkles, UserPlus, X } from 'lucide-react';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  StatusDot,
  cn,
  toast,
} from '../../ui';
import {
  acceptChat,
  cancelConnectRequest,
  closeOperatorChat,
  resolveOperatorChat,
  sendConnectRequest,
  uploadOperatorChatFile,
} from '../../services/api';
import type { CannedResponse } from '../../types/domain';
import { Composer } from './Composer';
import { Transcript } from './Transcript';
import { TransferDialog } from './TransferDialog';
import { useInboxSocket } from './inboxSocket';
import { useTranscript } from './inboxQueries';
import { maxVisitorDbId } from './liveChatHelpers';
import { waitLabel, waitTone, type InboxItem } from './inboxModel';
import type { OperatorMessage } from './liveChatProtocol';

export interface ChatPaneProps {
  item: InboxItem;
  /** Draft reply for this conversation, owned by the console so it survives switching. */
  draft: string;
  onDraftChange: (value: string) => void;
  snippets: CannedResponse[];
  onManageSnippets: () => void;
  /** Ticking clock for the wait timer. */
  now: number;
  /** Called after the conversation leaves this operator's board. */
  onLeft: () => void;
  /** Present only when the list is not on screen beside this pane (small viewports). */
  onBack?: () => void;
  /** Present only when the details pane is not on screen beside this pane. */
  onShowDetails?: () => void;
}

type PendingAction = 'resolve' | 'return' | null;

/** One shared empty array, so "no messages yet" is referentially stable. */
const EMPTY_MESSAGES: OperatorMessage[] = [];

function Header({
  item,
  online,
  children,
  now,
  onBack,
  onShowDetails,
}: {
  item: InboxItem;
  online: boolean;
  children: React.ReactNode;
  now: number;
  onBack?: () => void;
  onShowDetails?: () => void;
}) {
  const wait = item.kind === 'waiting' ? waitLabel(item.at, now) : '';
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-4 py-3 md:px-6">
      {onBack ? (
        <Button size="icon-sm" variant="ghost" aria-label="Back to the list" onClick={onBack}>
          <ArrowLeft aria-hidden className="h-4 w-4" />
        </Button>
      ) : null}
      <Avatar size="md" name={item.name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-lg font-semibold text-text-primary">{item.name}</h2>
          {online ? <StatusDot tone="success" pulse label="Visitor is on the page" /> : null}
        </div>
        <p className="truncate text-2xs text-text-tertiary">
          {item.botName ? `${item.botName} · ` : ''}
          {item.kind === 'waiting'
            ? 'Waiting for a person'
            : item.kind === 'qualified'
              ? 'The AI is handling this'
              : online
                ? 'On the page now'
                : 'Left the page'}
        </p>
      </div>
      {wait ? (
        <Badge tone={waitTone(item.at, now)} className="figure">
          Waiting {wait}
        </Badge>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {onShowDetails ? (
          <Button size="icon-sm" variant="ghost" aria-label="Show visitor details" onClick={onShowDetails}>
            <PanelRight aria-hidden className="h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </header>
  );
}

/**
 * A conversation, and what you can do about it.
 *
 * The same pane in three postures, because they are the same object at three
 * points in its life: someone waiting (read the transcript, then take it),
 * someone you are answering (reply, hand over, finish), and one the AI still
 * has (watch, then offer a person). The console this replaces used a different
 * layout for each and only let you read the transcript of the third — so
 * accepting a waiting visitor meant taking a conversation sight unseen.
 */
export function ChatPane({
  item,
  draft,
  onDraftChange,
  snippets,
  onManageSnippets,
  now,
  onLeft,
  onBack,
  onShowDetails,
}: ChatPaneProps) {
  const socket = useInboxSocket();
  const sessionId = item.sessionId ?? '';
  const live = item.kind === 'live';

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [confirm, setConfirm] = useState<PendingAction>(null);
  const [connecting, setConnecting] = useState(false);
  const [invited, setInvited] = useState(false);
  const loadedRef = useRef<Set<string>>(new Set());

  // Live conversations stream over the socket; the other two are read-only and
  // polled, so only one of the two sources is ever active for a given session.
  const readOnly = useTranscript(live ? null : sessionId || null, item.kind === 'qualified');
  // Memoised because it feeds an effect: `?? []` allocates a new array on every
  // render, which would re-run the read-receipt effect on every render.
  const liveMessages: OperatorMessage[] = useMemo(
    () => socket.messagesBySession[sessionId] ?? EMPTY_MESSAGES,
    [socket.messagesBySession, sessionId],
  );
  const messages = live ? liveMessages : readOnly.messages;
  const ended = socket.endedBySession[sessionId];
  const presence = socket.presenceBySession[sessionId];
  const online = live ? presence !== 'disconnected' : item.online;
  const connected = socket.status === 'connected';
  const resolution = socket.connectResolutions[sessionId];

  // Pull the transcript for a live conversation once, then let the socket keep it.
  useEffect(() => {
    if (!live || !sessionId) return;
    if (loadedRef.current.has(sessionId)) return;
    loadedRef.current.add(sessionId);
    void socket.loadHistory(sessionId);
  }, [live, sessionId, socket]);

  // Mark what is on screen as read, and tell the visitor so.
  useEffect(() => {
    if (!live || !sessionId || !connected) return;
    const highWater = maxVisitorDbId(liveMessages);
    if (highWater > 0) socket.sendReadReceipt(sessionId, highWater);
    socket.clearUnread(sessionId);
  }, [live, sessionId, connected, liveMessages, socket]);

  // A resolved connect-request is a one-shot event: report it, then clear it so
  // it cannot re-announce itself every time this pane re-renders.
  useEffect(() => {
    if (!resolution || !sessionId) return;
    const { outcome, visitorName } = resolution;
    const who = visitorName ?? 'The visitor';
    if (outcome === 'accepted') toast.success(`${who} accepted your invitation`);
    else if (outcome === 'declined') toast.info(`${who} declined your invitation`);
    else if (outcome === 'expired') toast.info(`Your invitation to ${who} expired`);
    setInvited(false);
    socket.clearConnectResolution(sessionId);
  }, [resolution, sessionId, socket]);

  const run = useCallback(
    async (label: string, action: () => Promise<unknown>): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await action();
      } catch (err) {
        setError(err instanceof Error ? `${label}: ${err.message}` : label);
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const accept = (): void => {
    void run('Could not accept this conversation', async () => {
      await acceptChat(sessionId, socket.operatorId);
      // The socket's `chat_accepted` moves it onto the board and into "Yours".
      toast.success(`You are now talking to ${item.name}`);
    });
  };

  const invite = (): void => {
    setConnecting(true);
    setError(null);
    void sendConnectRequest(sessionId, socket.operatorId)
      .then(() => {
        setInvited(true);
        toast.success(`Invitation sent to ${item.name}`, {
          description: 'They will see an offer to talk to a person.',
        });
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? `Could not send the invitation: ${err.message}` : 'Could not send the invitation.');
      })
      .finally(() => setConnecting(false));
  };

  const withdraw = (): void => {
    setConnecting(true);
    void cancelConnectRequest(sessionId)
      .then(() => {
        setInvited(false);
        toast.info('Invitation withdrawn');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? `Could not withdraw: ${err.message}` : 'Could not withdraw the invitation.');
      })
      .finally(() => setConnecting(false));
  };

  const send = (text: string): void => {
    if (!socket.sendMessage(sessionId, text)) {
      setError('That message did not send — you are not connected right now.');
      return;
    }
    onDraftChange('');
  };

  const attach = async (file: File): Promise<void> => {
    try {
      const uploaded = await uploadOperatorChatFile(file, sessionId);
      if (!socket.sendFile(sessionId, uploaded)) {
        setError('The file uploaded but could not be sent — you are not connected right now.');
      }
    } catch (err) {
      setError(err instanceof Error ? `Could not upload that file: ${err.message}` : 'Could not upload that file.');
    }
  };

  const composerBlock = !connected
    ? 'Reconnecting — your reply will not send until the connection is back.'
    : !online
      ? 'The visitor has left the page. They will see your reply when they return.'
      : ended
        ? 'This conversation has ended.'
        : null;

  return (
    <section aria-label={`Conversation with ${item.name}`} className="flex h-full min-h-0 flex-col bg-canvas">
      <Header item={item} online={online} now={now} onBack={onBack} onShowDetails={onShowDetails}>
        {item.kind === 'waiting' ? (
          <Button onClick={accept} loading={busy} disabled={busy}>
            <UserPlus aria-hidden className="h-4 w-4" />
            Accept and reply
          </Button>
        ) : null}

        {item.kind === 'qualified' ? (
          invited ? (
            <Button variant="secondary" onClick={withdraw} loading={connecting} disabled={connecting}>
              <X aria-hidden className="h-4 w-4" />
              Withdraw invitation
            </Button>
          ) : (
            <Button onClick={invite} loading={connecting} disabled={connecting}>
              <Sparkles aria-hidden className="h-4 w-4" />
              Offer to take over
            </Button>
          )
        ) : null}

        {live && !ended ? (
          <>
            <Button variant="ghost" onClick={() => setTransferOpen(true)} disabled={busy}>
              <ArrowRightLeft aria-hidden className="h-4 w-4" />
              Transfer
            </Button>
            <Button variant="ghost" onClick={() => setConfirm('return')} disabled={busy}>
              <Bot aria-hidden className="h-4 w-4" />
              Back to AI
            </Button>
            <Button onClick={() => setConfirm('resolve')} disabled={busy}>
              <CheckCircle2 aria-hidden className="h-4 w-4" />
              Resolve
            </Button>
          </>
        ) : null}
      </Header>

      {error ? (
        <Alert tone="danger" live className="mx-4 mt-3 md:mx-6">
          {error}
        </Alert>
      ) : null}

      {item.kind === 'waiting' ? (
        <p className="border-b border-border bg-surface-sunken px-4 py-2 text-xs text-text-secondary md:px-6">
          Read what they have already said before you take the conversation — they are still with the AI until you accept.
        </p>
      ) : null}

      <Transcript
        messages={messages}
        visitorName={item.name}
        visitorTyping={live && Boolean(socket.typingBySession[sessionId])}
        visitorReadAt={live ? (socket.visitorReadAtBySession[sessionId] ?? null) : null}
        loading={live ? messages.length === 0 && connected : readOnly.loading}
        onLoadOlder={
          live && socket.hasMoreBySession[sessionId] ? () => void socket.loadOlder(sessionId) : undefined
        }
        footnote={
          ended ? (
            <p className="rounded-md bg-surface-sunken px-3 py-2 text-center text-2xs text-text-secondary">
              {ended.reason === 'transferred'
                ? `You handed this conversation to ${ended.transferredTo ?? 'a colleague'}. The transcript stays here until you leave the inbox.`
                : 'This conversation has ended. The transcript stays here until you leave the inbox.'}
            </p>
          ) : null
        }
      />

      {live && !ended ? (
        <Composer
          value={draft}
          onChange={onDraftChange}
          onSend={send}
          onAttach={attach}
          onTyping={() => socket.sendTyping(sessionId)}
          snippets={snippets}
          onManageSnippets={onManageSnippets}
          disabledReason={composerBlock}
        />
      ) : (
        <div className="shrink-0 border-t border-border bg-surface px-4 py-3 text-xs text-text-secondary md:px-6">
          {item.kind === 'waiting'
            ? 'Accept the conversation to reply.'
            : item.kind === 'qualified'
              ? 'You are watching the AI answer. Offer to take over to start replying yourself.'
              : 'This conversation is closed.'}
        </div>
      )}

      {live ? (
        <TransferDialog
          open={transferOpen}
          onOpenChange={setTransferOpen}
          sessionId={sessionId}
          visitorName={item.name}
          currentOperatorId={socket.operatorId}
          onTransferred={onLeft}
        />
      ) : null}

      <ConfirmDialog
        open={confirm === 'resolve'}
        onOpenChange={(open) => setConfirm(open ? 'resolve' : null)}
        title="Resolve this conversation?"
        description={`${item.name} will be asked to rate the chat, and it leaves your inbox. You can still find it under Leads.`}
        confirmLabel="Resolve"
        onConfirm={async () => {
          await resolveOperatorChat(sessionId);
          onLeft();
        }}
      />

      <ConfirmDialog
        open={confirm === 'return'}
        onOpenChange={(open) => setConfirm(open ? 'return' : null)}
        title="Hand this back to the AI?"
        description={`${item.name} keeps their conversation, but the AI answers from here. Use this when the question turned out to be one the bot can handle.`}
        confirmLabel="Back to AI"
        onConfirm={async () => {
          await closeOperatorChat(sessionId);
          onLeft();
        }}
      />
    </section>
  );
}

/** Shared shell for the “nothing selected” centre pane. */
export function ChatPanePlaceholder({ children }: { children: React.ReactNode }) {
  return (
    <section className={cn('flex h-full items-center justify-center bg-canvas p-6')}>{children}</section>
  );
}
