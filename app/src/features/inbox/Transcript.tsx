import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { Bot, Download, FileText, Paperclip } from 'lucide-react';
import { Avatar, Button, Spinner, cn, formatDate, formatTime } from '../../ui';
import { isSafeFileUrl } from './liveChatHelpers';
import type { OperatorMessage } from './liveChatProtocol';

export interface TranscriptProps {
  messages: OperatorMessage[];
  /** The visitor's name, for their avatar and the typing line. */
  visitorName: string;
  /** Renders the three-dot line under the last message. */
  visitorTyping?: boolean;
  /** ISO or epoch ms of the visitor's last read receipt; marks your messages seen. */
  visitorReadAt?: number | null;
  /** Shown while the first page of history is in flight. */
  loading?: boolean;
  /** Present when an older page may exist. */
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  /** Rendered under the last message — an ended-conversation note, for instance. */
  footnote?: ReactNode;
  className?: string;
}

const ROLE_LABEL: Record<OperatorMessage['role'], string> = {
  user: 'Visitor',
  bot: 'AI',
  operator: 'You',
  system: 'System',
};

/** Group boundary: a date divider goes in wherever the calendar day changes. */
function dayKey(timestamp: string | null): string {
  if (!timestamp) return '';
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return '';
  const date = new Date(parsed);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function isImage(contentType: string | undefined): boolean {
  return Boolean(contentType && contentType.startsWith('image/'));
}

function Attachment({ message }: { message: OperatorMessage }) {
  if (!isSafeFileUrl(message.fileUrl)) return null;
  const name = message.filename ?? 'Attachment';

  if (isImage(message.contentType)) {
    return (
      <a
        href={message.fileUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-1.5 block overflow-hidden rounded-md border border-border"
      >
        <img
          src={message.fileUrl}
          alt={name}
          // Bounded rather than intrinsic: a 4,000px screenshot from a visitor
          // must not push the composer off the screen.
          className="max-h-64 w-auto max-w-full object-contain"
        />
      </a>
    );
  }

  return (
    <a
      href={message.fileUrl}
      target="_blank"
      rel="noreferrer noopener"
      download
      className={cn(
        'mt-1.5 inline-flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5',
        'text-xs text-text-primary transition-colors duration-[var(--dur-fast)] hover:bg-surface-hover',
      )}
    >
      <FileText aria-hidden className="h-3.5 w-3.5 text-text-tertiary" />
      <span className="max-w-[16rem] truncate">{name}</span>
      <Download aria-hidden className="h-3.5 w-3.5 text-text-tertiary" />
    </a>
  );
}

/**
 * A conversation, read top to bottom.
 *
 * Three voices, three grounds, no accent: the visitor speaks on white, the AI on
 * sunken paper, and your team speaks in ink — the same near-black as the
 * navigation rail, so "us" reads the same everywhere in the product. Blue is
 * left alone to mean interactive, which matters more here than anywhere else,
 * because this is the one screen where a row can be both selected and streaming.
 *
 * Messages carry a role word as well as a side and a ground, so the thread is
 * still legible with colour stripped, at 200% zoom, and to a screen reader
 * reading it as the list it is.
 */
export function Transcript({
  messages,
  visitorName,
  visitorTyping = false,
  visitorReadAt = null,
  loading = false,
  onLoadOlder,
  loadingOlder = false,
  footnote,
  className,
}: TranscriptProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Whether the operator is reading the newest messages. Auto-scroll is only
  // honest when they are: yanking someone back to the bottom while they scroll
  // up through history is the single most complained-about behaviour in every
  // chat console that gets it wrong.
  const pinnedRef = useRef(true);

  const onScroll = (): void => {
    const node = scrollRef.current;
    if (!node) return;
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  };

  // Layout effect, not effect: scrolling after paint shows one frame of the old
  // position, which reads as a flicker on every inbound message.
  //
  // `scrollTop`, not `scrollIntoView`: the latter also scrolls every scrollable
  // ancestor, so on a narrow viewport an inbound message would drag the whole
  // console under the operator.
  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, visitorTyping]);

  // A newly-opened conversation always starts at the newest message.
  useEffect(() => {
    pinnedRef.current = true;
  }, []);

  const lastOperatorIndex = (() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'operator') return index;
    }
    return -1;
  })();

  // Day boundaries are derived, not accumulated while rendering: a variable
  // mutated inside `map` is read again on the next render with whatever the last
  // one left in it, which puts the divider on the wrong message.
  const dividerAt = useMemo(() => {
    const flags = new Array<boolean>(messages.length).fill(false);
    let previous = '';
    messages.forEach((message, index) => {
      const key = dayKey(message.timestamp);
      if (key !== '' && key !== previous) {
        flags[index] = true;
        previous = key;
      }
    });
    return flags;
  }, [messages]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={cn('min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6', className)}
    >
      {onLoadOlder ? (
        <div className="mb-4 flex justify-center">
          <Button size="sm" variant="ghost" onClick={onLoadOlder} disabled={loadingOlder}>
            {loadingOlder ? <Spinner className="h-3.5 w-3.5" /> : null}
            Load earlier messages
          </Button>
        </div>
      ) : null}

      {loading && messages.length === 0 ? (
        <p className="py-8 text-center text-xs text-text-tertiary">Loading the conversation…</p>
      ) : null}

      <ol className="flex flex-col gap-3">
        {messages.map((message, index) => {
          const showDivider = dividerAt[index];
          const mine = message.role === 'operator';
          const system = message.role === 'system';
          const seen =
            mine &&
            index === lastOperatorIndex &&
            visitorReadAt != null &&
            message.timestamp != null &&
            Date.parse(message.timestamp) <= visitorReadAt;

          return (
            <li key={message.key} className="contents">
              {showDivider ? (
                <div className="my-2 flex items-center gap-3" role="presentation">
                  <span className="h-px flex-1 bg-border" />
                  <span className="figure text-2xs text-text-tertiary">
                    {formatDate(message.timestamp)}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              ) : null}

              {system ? (
                <p className="py-1 text-center text-2xs text-text-tertiary">{message.content}</p>
              ) : (
                <div className={cn('flex items-end gap-2', mine && 'flex-row-reverse')}>
                  {/* The AI gets a mark, not initials: two letters beside the
                      word "AI" is the same fact twice, and a person's initials
                      next to a machine's message reads as a person. */}
                  {mine ? null : message.role === 'bot' ? (
                    <span
                      aria-hidden
                      className="mb-4 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-sunken"
                    >
                      <Bot className="h-3 w-3 text-text-tertiary" />
                    </span>
                  ) : (
                    <Avatar size="xs" name={visitorName} className="mb-4 shrink-0" />
                  )}
                  <div className={cn('flex min-w-0 max-w-[min(42rem,80%)] flex-col', mine && 'items-end')}>
                    <div
                      className={cn(
                        'rounded-lg px-3 py-2 text-prose',
                        mine
                          ? 'rounded-br-xs bg-ink text-rail-text'
                          : message.role === 'bot'
                            ? 'rounded-bl-xs bg-surface-sunken text-text-primary'
                            : 'rounded-bl-xs border border-border bg-surface text-text-primary',
                      )}
                    >
                      {/* `whitespace-pre-wrap` and nothing else: message bodies are
                          visitor-authored text and are never parsed as markup. */}
                      {message.content ? (
                        <p className="whitespace-pre-wrap break-words">{message.content}</p>
                      ) : null}
                      {message.fileUrl ? <Attachment message={message} /> : null}
                    </div>
                    <p className="mt-1 flex items-center gap-1.5 px-0.5 text-2xs text-text-tertiary">
                      <span>{ROLE_LABEL[message.role]}</span>
                      {message.timestamp ? (
                        <span className="figure">{formatTime(message.timestamp)}</span>
                      ) : null}
                      {seen ? <span>· Seen</span> : null}
                    </p>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {visitorTyping ? (
        <div className="mt-3 flex items-end gap-2">
          <Avatar size="xs" name={visitorName} className="shrink-0" />
          <span
            className="flex items-center gap-1 rounded-lg rounded-bl-xs border border-border bg-surface px-3 py-2.5"
            role="status"
            aria-label={`${visitorName} is typing`}
          >
            {[0, 1, 2].map((dot) => (
              <span key={dot} aria-hidden className="typing-dot h-1.5 w-1.5 rounded-full bg-text-tertiary" />
            ))}
          </span>
        </div>
      ) : null}

      {footnote ? <div className="mt-4">{footnote}</div> : null}

      {messages.length === 0 && !loading ? (
        <p className="flex items-center justify-center gap-2 py-10 text-xs text-text-tertiary">
          <Paperclip aria-hidden className="h-3.5 w-3.5" />
          Nothing has been said yet.
        </p>
      ) : null}
    </div>
  );
}
