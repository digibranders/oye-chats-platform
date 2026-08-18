import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import {
  ArrowRightLeft,
  CheckCheck,
  CheckCircle2,
  CornerUpLeft,
  Download,
  FileText,
  Loader2,
  Paperclip,
  Send,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import Markdown from 'react-markdown';
import { Button, DayDivider, StatusBadge, cn } from '../../design-system';
import { formatDayLabel, isNewDay } from '../../lib/messageDay';
import type { CannedResponse } from '../../types/domain';
import type { ActiveChat, OperatorMessage, VisitorPresence } from './liveChatProtocol';
import { clockTime, initials, isSafeFileUrl } from './liveChatHelpers';

/** Maximum number of canned-response suggestions shown in the slash menu. */
const MAX_CANNED_SUGGESTIONS = 8;

/** Human-readable transcript labels for each message role. */
const TRANSCRIPT_ROLE_LABELS: Readonly<Record<OperatorMessage['role'], string>> = {
  user: 'Visitor',
  operator: 'You',
  bot: 'AI',
  system: 'System',
};

/** Slugify a visitor name for a filename: lowercase, non-alphanumerics → '-', collapse, trim. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Build the plain-text transcript body for a conversation. */
function buildTranscript(chat: ActiveChat, messages: OperatorMessage[]): string {
  const lines: string[] = [`Conversation with ${chat.visitor_name}`];
  if (chat.bot_name) lines.push(`Chatbot: ${chat.bot_name}`);
  lines.push('');
  for (const message of messages) {
    const role = TRANSCRIPT_ROLE_LABELS[message.role];
    let body: string;
    if (message.fileUrl) {
      body = `[file] ${message.filename ?? message.fileUrl} (${message.fileUrl})`;
    } else {
      body = message.content.trim();
      if (!body) continue;
    }
    lines.push(`[${clockTime(message.timestamp)}] ${role}: ${body}`);
  }
  return lines.join('\n');
}

/** Download a plain-text transcript as a `.txt` file (BOM-prefixed for editors). */
function downloadTranscript(text: string, filename: string): void {
  const blob = new Blob(['﻿', text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export interface ConversationViewProps {
  chat: ActiveChat;
  messages: OperatorMessage[];
  visitorTyping: boolean;
  presence: VisitorPresence;
  /** Epoch ms of the latest visitor read-receipt for this session, if any. */
  visitorReadAt: number | undefined;
  connected: boolean;
  /** True while the "Return to AI" action is in flight. */
  closing: boolean;
  /** True while the "Resolve" action is in flight. */
  resolving: boolean;
  /** Whether an older page of history may exist for this session. */
  hasMore: boolean;
  /** Fetch + prepend the previous page of history. */
  onLoadOlder: () => Promise<void>;
  /** Canned responses available for the `/shortcut` slash menu. */
  cannedResponses: CannedResponse[];
  onSend: (content: string) => boolean;
  onTyping: () => void;
  /** Return the visitor to the AI (session → bot mode). */
  onClose: () => void;
  /** Resolve + hard-close the conversation (marks it done for reporting). */
  onResolve: () => void;
  onTransfer: () => void;
  /** Parent uploads the file and broadcasts it to the visitor. May throw. */
  onUploadFile: (file: File) => Promise<void>;
}

/** One message bubble. Renders visitor/operator/bot/system + image/file attachments. */
function MessageBubble({
  message,
  onOpenImage,
}: {
  message: OperatorMessage;
  onOpenImage: (url: string, alt: string) => void;
}): ReactElement {
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

  const safeFileUrl = isSafeFileUrl(message.fileUrl) ? message.fileUrl : null;
  const isImage = Boolean(message.contentType?.startsWith('image/') && safeFileUrl);
  const altText = message.filename ?? 'Shared image';

  return (
    <div className={cn('flex flex-col gap-0.5', align)}>
      <div className={cn('max-w-[78%] rounded-[var(--ds-radius-lg)] px-3.5 py-2 text-[14px] leading-relaxed', bubble)}>
        {isImage && safeFileUrl ? (
          <button
            type="button"
            onClick={() => onOpenImage(safeFileUrl, altText)}
            className="block cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]"
            aria-label={`Open image: ${altText}`}
          >
            <img src={safeFileUrl} alt={altText} className="max-h-56 max-w-full rounded-md" />
          </button>
        ) : safeFileUrl ? (
          <a
            href={safeFileUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2"
          >
            {message.filename ?? 'Attachment'}
          </a>
        ) : (
          <div className="[&>p]:my-0 [&>p]:empty:hidden break-words whitespace-pre-wrap">
            <Markdown>{message.content}</Markdown>
          </div>
        )}
      </div>
      {message.timestamp && (
        <span className="px-1 text-[11px] text-[var(--ds-text-subtle)]">{clockTime(message.timestamp)}</span>
      )}
    </div>
  );
}

/**
 * ConversationView - the centre pane: live message thread, visitor typing
 * indicator, read receipt, and the operator composer.
 *
 * Composer superpowers:
 *  - Type `/` to open a canned-response slash menu (arrow keys + Enter to insert).
 *  - Attach a file/image via the paperclip or by pasting an image - both open a
 *    preview + optional caption before sending.
 *  - Click any image bubble to open it in a full-screen lightbox.
 *
 * Enter sends; Shift+Enter inserts a newline. Sending is disabled while the
 * socket is disconnected.
 */
export function ConversationView({
  chat,
  messages,
  visitorTyping,
  presence,
  visitorReadAt,
  connected,
  closing,
  resolving,
  hasMore,
  onLoadOlder,
  cannedResponses,
  onSend,
  onTyping,
  onClose,
  onResolve,
  onTransfer,
  onUploadFile,
}: ConversationViewProps): ReactElement {
  const [draft, setDraft] = useState('');
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ url: string; alt: string } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Track the previous first-message key + last measured scrollHeight so a prepend
  // of older history anchors the viewport instead of yanking it to the bottom.
  const prevFirstKeyRef = useRef<string | undefined>(messages[0]?.key);
  const prevScrollHeightRef = useRef(0);

  // ── Canned-response slash menu ──
  const menuQuery = draft.startsWith('/') && !menuDismissed ? draft.slice(1).toLowerCase() : null;
  const suggestions = useMemo(() => {
    if (menuQuery === null) return [];
    return cannedResponses
      .filter((c) => {
        const shortcut = (c.shortcut ?? '').replace(/^\//, '').toLowerCase();
        return (
          shortcut.includes(menuQuery) ||
          c.title.toLowerCase().includes(menuQuery) ||
          c.content.toLowerCase().includes(menuQuery)
        );
      })
      .slice(0, MAX_CANNED_SUGGESTIONS);
  }, [cannedResponses, menuQuery]);
  const menuOpen = suggestions.length > 0;
  const clampedIndex = Math.min(activeIndex, Math.max(suggestions.length - 1, 0));

  // Keep the thread pinned to the newest message - except when older history is
  // prepended (the first message key changes), where we hold the viewport steady
  // on the same message the operator was reading.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const firstKey = messages[0]?.key;
    const prependedOlder =
      firstKey !== undefined && prevFirstKeyRef.current !== undefined && firstKey !== prevFirstKeyRef.current;
    prevFirstKeyRef.current = firstKey;
    if (prependedOlder) {
      el.scrollTop += el.scrollHeight - prevScrollHeightRef.current;
    } else {
      el.scrollTop = el.scrollHeight;
    }
    prevScrollHeightRef.current = el.scrollHeight;
  }, [messages, visitorTyping]);

  // Focus the composer on mount. The parent keys this component by session id, so
  // switching conversations remounts it - the draft resets via initial state.
  useEffect(() => {
    composerRef.current?.focus();
  }, []);

  // Release the object URL used for the image preview thumbnail.
  const previewUrl = useMemo(
    () => (pendingFile && pendingFile.type.startsWith('image/') ? URL.createObjectURL(pendingFile) : null),
    [pendingFile],
  );
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Escape closes the lightbox. Bound only while it is open.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') setLightbox(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lightbox]);

  const submit = (): void => {
    const value = draft.trim();
    if (!value || !connected) return;
    const ok = onSend(value);
    if (ok) setDraft('');
  };

  const insertCanned = useCallback((response: CannedResponse): void => {
    // Replacing the whole draft with content that does not start with "/" also
    // closes the menu (menuQuery becomes null). Refocus + caret to the end.
    setDraft(response.content);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }, []);

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    setDraft(e.target.value);
    setActiveIndex(0);
    setMenuDismissed(false);
    onTyping();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const chosen = suggestions[clampedIndex];
        if (chosen) insertCanned(chosen);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMenuDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const openPreview = useCallback((file: File): void => {
    setPendingFile(file);
    setCaption('');
    setUploadError(null);
  }, []);

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    // Reset so re-selecting the same file re-fires onChange.
    e.target.value = '';
    if (file) openPreview(file);
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = e.clipboardData?.files;
    if (!files || files.length === 0) return;
    const image = Array.from(files).find((f) => f.type.startsWith('image/'));
    if (image) {
      e.preventDefault();
      openPreview(image);
    }
  };

  const closePreview = useCallback((): void => {
    setPendingFile(null);
    setCaption('');
    setUploadError(null);
  }, []);

  const handleSendFile = async (): Promise<void> => {
    if (!pendingFile || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      await onUploadFile(pendingFile);
      const trimmedCaption = caption.trim();
      if (trimmedCaption) onSend(trimmedCaption);
      closePreview();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Couldn’t send the file. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const openImage = useCallback((url: string, alt: string): void => {
    setLightbox({ url, alt });
  }, []);

  const handleExport = useCallback((): void => {
    if (messages.length === 0) return;
    const date = new Date().toISOString().slice(0, 10);
    const filename = `transcript-${slugify(chat.visitor_name || 'conversation') || 'conversation'}-${date}.txt`;
    downloadTranscript(buildTranscript(chat, messages), filename);
  }, [chat, messages]);

  const handleLoadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      await onLoadOlder();
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, onLoadOlder]);

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
          <Button variant="outline" size="sm" onClick={handleExport} disabled={messages.length === 0}>
            <Download size={14} aria-hidden="true" />
            Export
          </Button>
          <Button variant="outline" size="sm" onClick={onTransfer} disabled={!connected}>
            <ArrowRightLeft size={14} aria-hidden="true" />
            Transfer
          </Button>
          <Button variant="outline" size="sm" onClick={onClose} disabled={closing || resolving}>
            <CornerUpLeft size={14} aria-hidden="true" />
            {closing ? 'Returning…' : 'Return to AI'}
          </Button>
          <Button variant="danger" size="sm" onClick={onResolve} disabled={closing || resolving}>
            <CheckCircle2 size={14} aria-hidden="true" />
            {resolving ? 'Resolving…' : 'Resolve'}
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
        {hasMore && messages.length > 0 && (
          <div className="flex justify-center pb-1">
            <Button variant="ghost" size="sm" onClick={() => void handleLoadOlder()} disabled={loadingOlder}>
              {loadingOlder ? (
                <>
                  <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                  Loading…
                </>
              ) : (
                'Load earlier messages'
              )}
            </Button>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[13px] text-[var(--ds-text-subtle)]">
            No messages yet - say hello.
          </div>
        ) : (
          messages.map((m, index, all) => {
            // Day divider ("Today / Yesterday / Aug 14") when the calendar day
            // changes, so a multi-day live conversation stays readable. System
            // rows carry no timestamp and never trigger a divider.
            const showDivider = isNewDay(m.timestamp, all[index - 1]?.timestamp);
            return (
              <Fragment key={m.key}>
                {showDivider && <DayDivider label={formatDayLabel(m.timestamp)} />}
                <MessageBubble message={m} onOpenImage={openImage} />
              </Fragment>
            );
          })
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
            Reconnecting - messages can’t be sent until the connection is restored.
          </div>
        )}
        <div className="relative flex items-end gap-2">
          {/* Canned-response slash menu */}
          {menuOpen && (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-2 max-h-64 overflow-auto rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] py-1 shadow-lg">
              {suggestions.map((response, index) => (
                <button
                  key={response.id}
                  type="button"
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(e) => {
                    // Prevent the textarea from losing focus before we insert.
                    e.preventDefault();
                    insertCanned(response);
                  }}
                  className={cn(
                    'flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors',
                    index === clampedIndex ? 'bg-[var(--ds-bg-hover)]' : 'hover:bg-[var(--ds-bg-hover)]',
                  )}
                >
                  <span className="flex items-center gap-2">
                    {response.shortcut && (
                      <span className="font-mono text-[12px] text-[var(--ds-accent-text)]">
                        {response.shortcut.startsWith('/') ? response.shortcut : `/${response.shortcut}`}
                      </span>
                    )}
                    <span className="truncate text-[13px] font-medium text-[var(--ds-text)]">{response.title}</span>
                  </span>
                  <span className="truncate text-[12px] text-[var(--ds-text-muted)]">{response.content}</span>
                </button>
              ))}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,application/pdf,text/plain"
            className="hidden"
            onChange={handleFileInput}
          />
          <Button
            variant="ghost"
            size="md"
            onClick={() => fileInputRef.current?.click()}
            disabled={!connected}
            aria-label="Attach file"
          >
            <Paperclip size={16} aria-hidden="true" />
          </Button>

          <textarea
            ref={composerRef}
            value={draft}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            rows={1}
            placeholder={connected ? 'Type a reply… (Enter to send, / for canned)' : 'Waiting for connection…'}
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

      {/* File / image preview modal */}
      {pendingFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ds-overlay)] p-4">
          <div className="w-full max-w-md rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-4 shadow-lg">
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-[14px] font-semibold text-[var(--ds-text)]">Send attachment</p>
              <Button variant="ghost" size="sm" onClick={closePreview} disabled={uploading} aria-label="Cancel">
                <X size={15} aria-hidden="true" />
              </Button>
            </div>

            <div className="mb-3 flex items-center justify-center rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-sunken)] p-3">
              {previewUrl ? (
                <img src={previewUrl} alt={pendingFile.name} className="max-h-64 max-w-full rounded-md" />
              ) : (
                <div className="flex items-center gap-2 py-4 text-[13px] text-[var(--ds-text-muted)]">
                  <FileText size={18} aria-hidden="true" />
                  <span className="max-w-[16rem] truncate">{pendingFile.name}</span>
                </div>
              )}
            </div>

            <input
              type="text"
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Add a caption (optional)…"
              disabled={uploading}
              className={cn(
                'mb-3 w-full rounded-[var(--ds-radius-lg)] border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-2 text-[14px] text-[var(--ds-text)] outline-none transition-colors',
                'placeholder:text-[var(--ds-text-subtle)] focus-visible:border-[var(--ds-accent)] focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                'disabled:cursor-not-allowed disabled:opacity-60',
              )}
            />

            {uploadError && <p className="mb-3 text-[12px] text-[var(--ds-danger)]">{uploadError}</p>}

            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="md" onClick={closePreview} disabled={uploading}>
                Cancel
              </Button>
              <Button size="md" onClick={() => void handleSendFile()} disabled={uploading || !connected}>
                {uploading ? (
                  <>
                    <Loader2 size={15} className="animate-spin" aria-hidden="true" />
                    Sending…
                  </>
                ) : (
                  <>
                    <Send size={15} aria-hidden="true" />
                    Send
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Image lightbox */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.alt}
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox.url}
            alt={lightbox.alt}
            className="max-h-[90vh] max-w-[90vw] rounded-md"
          />
        </div>
      )}
    </div>
  );
}
