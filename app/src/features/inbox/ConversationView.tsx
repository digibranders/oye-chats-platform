import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { ArrowRightLeft, CheckCheck, Send, Wifi, WifiOff, X } from 'lucide-react';
import { Button, StatusBadge, cn } from '../../design-system';
import type { ActiveChat, OperatorMessage, VisitorPresence } from './liveChatProtocol';
import { clockTime, initials, isSafeFileUrl } from './liveChatHelpers';

export interface ConversationViewProps {
  chat: ActiveChat;
  messages: OperatorMessage[];
  visitorTyping: boolean;
  presence: VisitorPresence;
  /** Epoch ms of the latest visitor read-receipt for this session, if any. */
  visitorReadAt: number | undefined;
  connected: boolean;
  closing: boolean;
  onSend: (content: string) => boolean;
  onTyping: () => void;
  onClose: () => void;
  onTransfer: () => void;
}

/** One message bubble. Renders visitor/operator/bot/system + image/file attachments. */
function MessageBubble({ message }: { message: OperatorMessage }): ReactElement {
  const { role } = message;

  if (role === 'system') {
    return (
      <div className="my-1 flex justify-center">
        <span className="rounded-full bg-[var(--ds-bg-sunken)] px-3 py-1 text-[12px] text-[var(--ds-text-subtle)]">
          {message.content}
        </span>
      </div>
    );
  }

  const isOperator = role === 'operator';
  const align = isOperator ? 'items-end' : 'items-start';
  const bubble = isOperator
    ? 'bg-[var(--ds-accent)] text-[var(--ds-accent-fg)]'
    : role === 'bot'
      ? 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text-muted)]'
      : 'bg-[var(--ds-bg-sunken)] text-[var(--ds-text)]';

  const isImage = message.contentType?.startsWith('image/') && isSafeFileUrl(message.fileUrl);

  return (
    <div className={cn('flex flex-col gap-0.5', align)}>
      <div className={cn('max-w-[78%] rounded-[var(--ds-radius-lg)] px-3.5 py-2 text-[14px] leading-relaxed', bubble)}>
        {isImage ? (
          <a href={message.fileUrl} target="_blank" rel="noreferrer noopener">
            <img
              src={message.fileUrl}
              alt={message.filename ?? 'Shared image'}
              className="max-h-56 max-w-full rounded-md"
            />
          </a>
        ) : message.fileUrl && isSafeFileUrl(message.fileUrl) ? (
          <a
            href={message.fileUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2"
          >
            {message.filename ?? 'Attachment'}
          </a>
        ) : (
          <span className="whitespace-pre-wrap break-words">{message.content}</span>
        )}
      </div>
      {message.timestamp && (
        <span className="px-1 text-[11px] text-[var(--ds-text-subtle)]">{clockTime(message.timestamp)}</span>
      )}
    </div>
  );
}

/**
 * ConversationView — the centre pane: live message thread, visitor typing
 * indicator, read receipt, and the operator composer. Enter sends; Shift+Enter
 * inserts a newline. Sending is disabled while the socket is disconnected.
 */
export function ConversationView({
  chat,
  messages,
  visitorTyping,
  presence,
  visitorReadAt,
  connected,
  closing,
  onSend,
  onTyping,
  onClose,
  onTransfer,
}: ConversationViewProps): ReactElement {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // Keep the thread pinned to the newest message.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, visitorTyping]);

  // Focus the composer on mount. The parent keys this component by session id, so
  // switching conversations remounts it — the draft resets via initial state.
  useEffect(() => {
    composerRef.current?.focus();
  }, []);

  const submit = (): void => {
    const value = draft.trim();
    if (!value || !connected) return;
    const ok = onSend(value);
    if (ok) setDraft('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // "Seen" when the visitor's read-receipt post-dates our last outgoing message.
  const lastOperator = [...messages].reverse().find((m) => m.role === 'operator');
  const lastOperatorTs = lastOperator?.timestamp ? Date.parse(lastOperator.timestamp) : 0;
  const seen = Boolean(lastOperator && visitorReadAt && visitorReadAt >= lastOperatorTs);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center justify-between gap-3 border-b border-[var(--ds-border)] px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--ds-accent-soft)] text-[13px] font-semibold text-[var(--ds-accent-text)]"
            aria-hidden="true"
          >
            {initials(chat.visitor_name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[14px] font-semibold text-[var(--ds-text)]">{chat.visitor_name}</p>
            <div className="flex items-center gap-2 text-[12px] text-[var(--ds-text-muted)]">
              <span className="inline-flex items-center gap-1">
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    presence === 'online' ? 'bg-[var(--ds-success)]' : 'bg-[var(--ds-text-subtle)]',
                  )}
                  aria-hidden="true"
                />
                {presence === 'online' ? 'Online' : 'Disconnected'}
              </span>
              {chat.bot_name && <span className="truncate">· {chat.bot_name}</span>}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={onTransfer} disabled={!connected}>
            <ArrowRightLeft size={14} aria-hidden="true" />
            Transfer
          </Button>
          <Button variant="danger" size="sm" onClick={onClose} disabled={closing}>
            <X size={14} aria-hidden="true" />
            {closing ? 'Ending…' : 'End chat'}
          </Button>
        </div>
      </header>

      {chat.reason && (
        <div className="border-b border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] px-4 py-1.5 text-[12px] text-[var(--ds-text-muted)]">
          Handed off: {chat.reason}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-[var(--ds-text-subtle)]">
            No messages yet — say hello.
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.key} message={m} />)
        )}
        {visitorTyping && (
          <div className="flex items-center gap-1.5 px-1 text-[12px] text-[var(--ds-text-muted)]" aria-live="polite">
            <span className="flex gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--ds-text-subtle)] [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--ds-text-subtle)] [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--ds-text-subtle)]" />
            </span>
            {chat.visitor_name} is typing…
          </div>
        )}
        {seen && !visitorTyping && (
          <div className="flex items-center justify-end gap-1 px-1 text-[11px] text-[var(--ds-text-subtle)]">
            <CheckCheck size={13} aria-hidden="true" />
            Seen
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-[var(--ds-border)] px-3 py-3">
        {!connected && (
          <div className="mb-2 flex items-center gap-2 rounded-md bg-[var(--ds-warning-soft)] px-2.5 py-1.5 text-[12px] text-[var(--ds-warning)]">
            <WifiOff size={13} aria-hidden="true" />
            Reconnecting — messages can’t be sent until the connection is restored.
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              onTyping();
            }}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder={connected ? 'Type a reply… (Enter to send)' : 'Waiting for connection…'}
            disabled={!connected}
            className={cn(
              'max-h-32 min-h-[40px] flex-1 resize-none rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-2.5 text-[14px] leading-relaxed text-[var(--ds-text)] outline-none transition-colors',
              'placeholder:text-[var(--ds-text-subtle)] focus-visible:border-[var(--ds-accent)] focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
              'disabled:cursor-not-allowed disabled:opacity-60',
            )}
          />
          <Button size="md" onClick={submit} disabled={!connected || !draft.trim()} aria-label="Send message">
            <Send size={15} aria-hidden="true" />
          </Button>
        </div>
        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--ds-text-subtle)]">
          {connected ? <Wifi size={12} aria-hidden="true" /> : <WifiOff size={12} aria-hidden="true" />}
          <StatusBadge tone={connected ? 'success' : 'warning'} dot>
            {connected ? 'Live' : 'Offline'}
          </StatusBadge>
        </div>
      </div>
    </div>
  );
}
