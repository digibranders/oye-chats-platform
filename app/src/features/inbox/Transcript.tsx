import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bot, Download, FileText, MessageSquare } from 'lucide-react';
import {
  Avatar,
  Button,
  DayDivider,
  EmptyState,
  ErrorState,
  Skeleton,
  Spinner,
  cn,
  formatTime,
} from '../../ui';
import { dayKey, formatDayLabel } from '../../lib/messageDay';
import { isSafeFileUrl, resolveDisplay, translationMissing } from './liveChatHelpers';
import { TranslationToggle } from './TranslationToggle';
import type { OperatorMessage } from './liveChatProtocol';
import { useTranslation } from '../../i18n/useTranslation';

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
  /**
   * The transcript could not be fetched.
   *
   * Without it a failed fetch rendered as an *empty conversation*, which is the
   * worst possible lie on this screen: the operator reads "nothing has been
   * said yet" and accepts a conversation sight unseen.
   */
  error?: string | null;
  onRetry?: () => void;
  /** Present when an older page may exist. */
  onLoadOlder?: () => void;
  loadingOlder?: boolean;
  /** Rendered under the last message — an ended-conversation note, for instance. */
  footnote?: ReactNode;
  /**
   * The language this operator reads in, from their own working-language
   * setting. Null means "no translation": every message renders exactly as it
   * was written, which is what a single-language desk wants.
   */
  readerLanguage?: string | null;
  /** Ask the server to translate one message again, after a failure. */
  onRetryTranslation?: (message: OperatorMessage) => Promise<void> | void;
  className?: string;
}

const ROLE_LABEL: Record<OperatorMessage['role'], string> = {
  user: 'Visitor',
  bot: 'AI',
  operator: 'You',
  system: 'System',
};

/** Uneven on purpose: three equal bars read as a rendering fault, not a wait. */
const SKELETON_BUBBLES = [
  { mine: false, width: 'w-1/2' },
  { mine: true, width: 'w-2/5' },
  { mine: false, width: 'w-3/5' },
] as const;

/** Longer than this between two messages from one speaker starts a new group. */
const GROUP_GAP_MS = 5 * 60 * 1000;

/** Milliseconds between two message timestamps, or null when either is absent. */
function elapsed(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return end - start;
}

function isImage(contentType: string | undefined): boolean {
  return Boolean(contentType && contentType.startsWith('image/'));
}

function Attachment({ message }: { message: OperatorMessage }) {
  const { t } = useTranslation();
  if (!isSafeFileUrl(message.fileUrl)) return null;
  const name = message.filename ?? (t('inbox.attachment') || 'Attachment');

  if (isImage(message.contentType)) {
    return (
      <a
        href={message.fileUrl}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-1.5 block overflow-hidden rounded-xs border border-border"
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
        'mt-1.5 flex max-w-full items-center gap-2 rounded-xs border border-border bg-surface px-2.5 py-1.5',
        'text-xs text-text-primary transition-colors duration-[var(--dur-fast)] hover:bg-surface-hover',
      )}
    >
      <FileText aria-hidden className="h-icon-sm w-icon-sm shrink-0 text-text-tertiary" />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <Download aria-hidden className="h-icon-sm w-icon-sm shrink-0 text-text-tertiary" />
    </a>
  );
}

/**
 * A conversation, read top to bottom.
 *
 * Three voices, three grounds, no accent: the visitor speaks on white, the AI on
 * sunken paper — both hairlined, because neither ground clears 2.4 L* against
 * the canvas the thread is painted on — and your team speaks in ink — the same near-black as the
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
  error = null,
  onRetry,
  onLoadOlder,
  loadingOlder = false,
  footnote,
  readerLanguage = null,
  onRetryTranslation,
  className,
}: TranscriptProps) {
  const { t } = useTranslation();
  // Per-message "show me what they actually wrote". Keyed by message, and
  // deliberately NOT a single transcript-wide flag: an operator checking one
  // suspicious translation should not have the other forty revert under them.
  const [originals, setOriginals] = useState<Record<string, boolean>>({});
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
    let previous: string | null = '';
    messages.forEach((message, index) => {
      const key = dayKey(message.timestamp);
      if (key !== null && key !== previous) {
        flags[index] = true;
        previous = key;
      }
    });
    return flags;
  }, [messages]);

  // A run from one speaker is one block: one avatar at its top, one timestamp
  // at its foot. Four short lines from a visitor used to produce four avatars
  // and four "Visitor 14:32" lines down the left edge — which every reference
  // client (Intercom, Front, Slack, Messages) groups instead.
  const grouping = useMemo(() => {
    const starts = new Array<boolean>(messages.length).fill(true);
    const ends = new Array<boolean>(messages.length).fill(true);
    messages.forEach((message, index) => {
      const previous = messages[index - 1];
      if (!previous || previous.role !== message.role) return;
      const gap = elapsed(previous.timestamp, message.timestamp);
      if (gap === null || gap > GROUP_GAP_MS) return;
      starts[index] = false;
      ends[index - 1] = false;
    });
    return { starts, ends };
  }, [messages]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={cn('min-h-0 flex-1 overflow-y-auto px-cell py-4', className)}
    >
      {onLoadOlder ? (
        <div className="mb-4 flex justify-center">
          <Button size="sm" variant="ghost" onClick={onLoadOlder} disabled={loadingOlder}>
            {loadingOlder ? <Spinner className="h-3.5 w-3.5" /> : null}
            {t('inbox.loadEarlierMessages') || 'Load earlier messages'}
          </Button>
        </div>
      ) : null}

      {/* Three bubbles at alternating alignment, not a centred sentence: the
          space has to read as "a conversation is arriving" and must not jump
          when it does. */}
      {loading && messages.length === 0 ? (
        <div aria-busy className="flex flex-col gap-3">
          {SKELETON_BUBBLES.map((bubble, index) => (
            <div key={index} className={cn('flex', bubble.mine && 'justify-end')}>
              <Skeleton className={cn('h-10 rounded-md', bubble.width)} />
            </div>
          ))}
        </div>
      ) : null}

      {error && messages.length === 0 ? (
        <ErrorState
          size="panel"
          title={t('inbox.thisConversationCouldNotBe') || 'This conversation could not be loaded'}
          description={error}
          onRetry={onRetry}
        />
      ) : null}

      <ol className="flex flex-col">
        {messages.map((message, index) => {
          const showDivider = dividerAt[index];
          const showsOriginal = originals[message.key] === true;
          const display = resolveDisplay(message, readerLanguage, showsOriginal);
          const mine = message.role === 'operator';
          const system = message.role === 'system';
          const groupStart = grouping.starts[index] || showDivider;
          const groupEnd = grouping.ends[index];
          const seen =
            mine &&
            index === lastOperatorIndex &&
            visitorReadAt != null &&
            message.timestamp != null &&
            Date.parse(message.timestamp) <= visitorReadAt;

          return (
            <li key={message.key} className="contents">
              {showDivider ? (
                // "Today" / "Yesterday" over a bare date: the two most common
                // answers are the ones a reader should not have to work out
                // from a number, and this is the marker that tells them whether
                // a lead is still warm.
                <DayDivider label={formatDayLabel(message.timestamp)} className="my-3" />
              ) : null}

              {system ? (
                <p className="py-1 text-center text-2xs text-text-tertiary">{message.content}</p>
              ) : (
                <div
                  className={cn(
                    // `items-start`, with the avatar on the bubble's top edge:
                    // the row was `items-end` and the avatar carried a guessed
                    // `mb-4` to lift it onto the bubble, which broke silently
                    // the moment the meta line changed size.
                    'flex items-start gap-2',
                    mine && 'flex-row-reverse',
                    groupStart ? 'mt-3 first:mt-0' : 'mt-0.5',
                  )}
                >
                  {/* The AI gets a mark, not initials: two letters beside the
                      word "AI" is the same fact twice, and a person's initials
                      next to a machine's message reads as a person. One per
                      group; the rest of the run is indented past the gap. */}
                  {mine || !groupStart ? (
                    <span aria-hidden className="w-5 shrink-0" />
                  ) : message.role === 'bot' ? (
                    <span
                      aria-hidden
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border bg-surface-sunken"
                    >
                      <Bot className="h-3 w-3 text-text-tertiary" />
                    </span>
                  ) : (
                    <Avatar size="xs" name={visitorName} className="shrink-0" />
                  )}
                  <div className={cn('flex min-w-0 max-w-[min(42rem,80%)] flex-col', mine && 'items-end')}>
                    <div
                      className={cn(
                        // `rounded-md` (8), not `rounded-lg` (10) — that is the
                        // card radius, and a message is not a card. 8 → 4 on
                        // the tail is a half step, which reads as a tail rather
                        // than as a nick.
                        'rounded-md px-3 py-2 text-prose',
                        mine
                          ? cn('bg-ink text-rail-text', groupEnd && 'rounded-br-xs')
                          : message.role === 'bot'
                            ? cn(
                                // The bubble is bordered as well as filled.
                                // `--color-surface-sunken` is 1.8 L* off the
                                // `bg-canvas` ground this transcript sits on —
                                // under the 2.4 L* step tokens.css sets as the
                                // floor for a felt difference — so on a support
                                // operator's panel the AI's bubble had no edge
                                // at all and its text read as loose type on the
                                // pane. The hairline draws the shape; the fill
                                // still separates it from the visitor's white.
                                'border border-border bg-surface-sunken text-text-primary',
                                groupEnd && 'rounded-bl-xs',
                              )
                            : cn(
                                'border border-border bg-surface text-text-primary',
                                groupEnd && 'rounded-bl-xs',
                              ),
                      )}
                    >
                      {/* The speaker, once per group, for the reader who cannot
                          separate the sides by colour or by ground. */}
                      {groupStart ? (
                        <span className="sr-only">{ROLE_LABEL[message.role]}: </span>
                      ) : null}
                      {/* `whitespace-pre-wrap` and nothing else: message bodies are
                          visitor-authored text and are never parsed as markup. */}
                      {display.text ? (
                        // `dir` follows the text being rendered, not the
                        // conversation: a translated Arabic message inside an
                        // English thread still has to lay out right-to-left.
                        <p dir={display.direction} className="whitespace-pre-wrap break-words">
                          {display.text}
                        </p>
                      ) : null}
                      {message.fileUrl ? <Attachment message={message} /> : null}
                    </div>
                    {readerLanguage && message.role !== 'operator' ? (
                      <TranslationToggle
                        className="mt-1 px-0.5"
                        isTranslated={display.isTranslated}
                        showOriginal={showsOriginal}
                        sourceLanguage={message.sourceLanguage}
                        onToggle={() =>
                          setOriginals((previous) => ({
                            ...previous,
                            [message.key]: !previous[message.key],
                          }))
                        }
                        onRetry={
                          onRetryTranslation && translationMissing(message, readerLanguage)
                            ? () => onRetryTranslation(message)
                            : undefined
                        }
                      />
                    ) : null}
                    {groupEnd ? (
                      <p className="mt-1 flex items-center gap-1.5 px-0.5 text-2xs text-text-tertiary">
                        {message.timestamp ? (
                          <span className="figure">{formatTime(message.timestamp)}</span>
                        ) : null}
                        {seen ? <span>· Seen</span> : null}
                      </p>
                    ) : null}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {visitorTyping ? (
        <div className="mt-3 flex items-start gap-2">
          <Avatar size="xs" name={visitorName} className="shrink-0" />
          <span
            className="flex items-center gap-1 rounded-md rounded-bl-xs border border-border bg-surface px-3 py-2.5"
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

      {messages.length === 0 && !loading && !error ? (
        <EmptyState
          size="panel"
          icon={MessageSquare}
          title={t('inbox.nothingSaidYet') || 'Nothing said yet'}
          description={t('inbox.neitherTheVisitorNorThe') || 'Neither the visitor nor the chatbot has written anything in this conversation.'}
        />
      ) : null}
    </div>
  );
}
