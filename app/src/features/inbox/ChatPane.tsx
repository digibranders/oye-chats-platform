import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  Bot,
  CheckCircle2,
  MoreHorizontal,
  PanelRight,
  Sparkles,
  UserPlus,
  X,
} from 'lucide-react';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  ConfirmDialog,
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
  PaneHeader,
  StatusDot,
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
  onShowDetails,
}: {
  item: InboxItem;
  online: boolean;
  children: React.ReactNode;
  now: number;
  onShowDetails?: () => void;
}) {
  const wait = item.kind === 'waiting' ? waitLabel(item.at, now) : '';
  return (
    <PaneHeader
      titleAs="h2"
      title={
        <span className="flex min-w-0 items-center gap-2">
          <Avatar size="md" name={item.name} className="shrink-0" />
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate">{item.name}</span>
              {online ? <StatusDot tone="success" pulse label="Visitor is on the page" /> : null}
            </span>
            <span className="block truncate text-2xs font-normal text-text-tertiary">
              {item.botName ? `${item.botName} · ` : ''}
              {item.kind === 'waiting'
                ? 'Waiting for a person'
                : item.kind === 'qualified'
                  ? 'The AI is handling this'
                  : online
                    ? 'On the page now'
                    : 'Left the page'}
            </span>
          </span>
        </span>
      }
      actions={
        <>
          {wait ? (
            <Badge tone={waitTone(item.at, now)} className="figure">
              Waiting {wait}
            </Badge>
          ) : null}
          {children}
          {onShowDetails ? (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Show visitor details"
              onClick={onShowDetails}
            >
              <PanelRight aria-hidden />
            </Button>
          ) : null}
        </>
      }
    />
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
      <Header item={item} online={online} now={now} onShowDetails={onShowDetails}>
        {item.kind === 'waiting' ? (
          <Button size="sm" variant="primary" onClick={accept} loading={busy} disabled={busy}>
            <UserPlus aria-hidden />
            Accept and reply
          </Button>
        ) : null}

        {item.kind === 'qualified' ? (
          invited ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={withdraw}
              loading={connecting}
              disabled={connecting}
            >
              <X aria-hidden />
              Withdraw invitation
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              onClick={invite}
              loading={connecting}
              disabled={connecting}
            >
              <Sparkles aria-hidden />
              Offer to take over
            </Button>
          )
        ) : null}

        {live && !ended ? (
          <>
            {/* The two secondary actions collapse into an overflow menu, so the
                header cannot squeeze the visitor's name to nothing on a narrow
                centre pane. Resolve stays secondary: with Accept primary in the
                other posture, each posture has exactly one filled button. */}
            <MenuRoot>
              <MenuTrigger
                render={
                  <Button size="icon-sm" variant="ghost" aria-label="More actions" disabled={busy}>
                    <MoreHorizontal aria-hidden />
                  </Button>
                }
              />
              <MenuContent>
                <MenuItem icon={<ArrowRightLeft aria-hidden />} onSelect={() => setTransferOpen(true)}>
                  Transfer
                </MenuItem>
                <MenuItem icon={<Bot aria-hidden />} onSelect={() => setConfirm('return')}>
                  Back to AI
                </MenuItem>
              </MenuContent>
            </MenuRoot>
            <Button size="sm" onClick={() => setConfirm('resolve')} disabled={busy}>
              <CheckCircle2 aria-hidden />
              Resolve
            </Button>
          </>
        ) : null}
      </Header>

      {error ? (
        <Alert tone="danger" live className="mx-cell mt-3">
          {error}
        </Alert>
      ) : null}

      {item.kind === 'waiting' ? (
        <p className="border-b border-border bg-surface-sunken px-cell py-2 text-xs text-text-secondary">
          Read what they have already said before you take the conversation — they are still with the AI until you accept.
        </p>
      ) : null}

      <Transcript
        messages={messages}
        visitorName={item.name}
        visitorTyping={live && Boolean(socket.typingBySession[sessionId])}
        visitorReadAt={live ? (socket.visitorReadAtBySession[sessionId] ?? null) : null}
        loading={live ? messages.length === 0 && connected : readOnly.loading}
        error={live ? null : readOnly.error}
        onRetry={live ? undefined : readOnly.reload}
        onLoadOlder={
          live && socket.hasMoreBySession[sessionId] ? () => void socket.loadOlder(sessionId) : undefined
        }
        footnote={
          ended ? (
            <Alert tone="neutral">
              {ended.reason === 'transferred'
                ? `You handed this conversation to ${ended.transferredTo ?? 'a colleague'}. The transcript stays here until you leave the inbox.`
                : 'This conversation has ended. The transcript stays here until you leave the inbox.'}
            </Alert>
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
        <div className="shrink-0 border-t border-border bg-surface px-cell py-3 text-xs text-text-secondary">
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
