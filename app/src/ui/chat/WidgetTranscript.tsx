import { Fragment, type CSSProperties, type ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { Bot } from 'lucide-react';
import PremiumOrb from './PremiumOrb';
import type { WidgetAppearance } from './widgetAppearance';
import {
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_USER_BUBBLE_COLOR,
  WIDGET_ON_PRIMARY,
  WIDGET_TEXT,
  WIDGET_TEXT_MUTED,
} from './widgetTheme';

/**
 * A conversation, drawn the way the visitor saw it.
 *
 * **Nothing in this file may use a console token.** The console is paper and
 * ink; this is a picture of a different product, rendering inside someone
 * else's website in colours its owner chose. Every value comes from the
 * `appearance` or from `widgetTheme.ts`, which mirrors the shipped widget's
 * `classic` theme, and every one is an inline style. A transcript painted in
 * `--color-surface` would be a faithful picture of the wrong thing.
 *
 * Two surfaces render this and they must agree, which is why it is here rather
 * than in either of them:
 *
 * - the Experience page's preview, where a customer is choosing the colours;
 * - the Leads drawer's Conversation tab, which replays a real conversation.
 *
 * They had two separate implementations and had already drifted: the preview
 * drew the visitor's bubble at a 16px radius against the widget's 8, and the
 * drawer drew every speaker in a console grey with an uppercase mono label
 * above each message — 23 eyebrows down a 768px column. The widget's own
 * anatomy is the one this takes:
 *
 * - **the visitor** gets a right-aligned bubble in the chatbot's colour;
 * - **the AI** gets its avatar and rendered markdown, and NO bubble;
 * - **an operator** gets their name in the chatbot's colour and plain text, and
 *   no bubble either.
 *
 * The one deliberate departure is `showTimes`. The widget shows no clocks at
 * all, because a visitor watching a conversation arrive does not need them. A
 * record read weeks later does, so the drawer turns them on — one per run, not
 * one per message.
 */

/**
 * Who is speaking.
 *
 * `system` is not a speaker: it is something that happened to the conversation
 * — a person was asked for, an operator joined, the chat closed — rendered as a
 * quiet centred line at the moment it happened, which is how the widget shows
 * the same events to the visitor.
 */
export type WidgetRole = 'visitor' | 'bot' | 'operator' | 'system';

export interface WidgetFile {
  url: string;
  filename?: string | null;
  contentType?: string | null;
}

export interface WidgetMessage {
  /** Stable list key. Callers namespace their own ids into it. */
  key: string;
  role: WidgetRole;
  text: string;
  /** ISO timestamp. Absent on a preview, where there is nothing to date. */
  at?: string | null;
  file?: WidgetFile | null;
}

export interface WidgetTranscriptProps {
  appearance: WidgetAppearance;
  messages: readonly WidgetMessage[];
  /** Who the operator was. Falls back to the `operatorFallback` label. */
  operatorName?: string | null;
  /** One timestamp under the last message of each run. Off by default. */
  showTimes?: boolean;
  /** Renders a day divider above the first message of each new day. */
  dayLabel?: (at: string | null | undefined) => string | null;
  /** Clock format. Injected so this component holds no locale of its own. */
  timeLabel?: (at: string) => string;
  /** "Operator", in the reader's language. */
  operatorFallback?: string;
  /** Alt text for an image the visitor sent, in the reader's language. */
  imageLabel?: string;
  className?: string;
}

/**
 * Markdown, as `MessageBubble` renders it in the widget.
 *
 * Not the console's `Markdown` primitive: that one styles itself with console
 * tokens and a console type scale. Block spacing is tight and inline-styled
 * because react-markdown emits real `<p>` and `<ul>` whose browser defaults
 * read as loose gaps in a chat message.
 */
function markdownComponents(linkColor: string): Components {
  return {
    p: ({ children }) => <p style={{ margin: '0 0 6px' }}>{children}</p>,
    // rtl-ok: mimics the shipped widget's own LTR-first markdown rendering, not
    // the console's chrome. See the file header.
    ul: ({ children }) => <ul style={{ margin: '0 0 6px', paddingLeft: 18 }}>{children}</ul>, // rtl-ok: see above
    ol: ({ children }) => <ol style={{ margin: '0 0 6px', paddingLeft: 18 }}>{children}</ol>, // rtl-ok: see above
    li: ({ children }) => <li style={{ margin: '2px 0' }}>{children}</li>,
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        style={{ color: linkColor, textDecoration: 'underline' }}
      >
        {children}
      </a>
    ),
    code: ({ children }) => (
      <code style={{ backgroundColor: 'rgba(16,32,44,0.06)', borderRadius: 4, padding: '1px 4px', fontSize: 13 }}>
        {children}
      </code>
    ),
  };
}

/** The chatbot's mark: an orb, an uploaded logo, or the brand circle. */
export function WidgetAvatar({
  appearance,
  size,
}: {
  appearance: WidgetAppearance;
  size: number;
}): ReactElement {
  const primary = appearance.primaryColor || DEFAULT_PRIMARY_COLOR;
  if (appearance.avatarType === 'orb') {
    return <PremiumOrb color={appearance.orbColor || primary} size={size} />;
  }
  if (appearance.avatarType === 'upload' && appearance.botLogo) {
    return (
      <img
        src={appearance.botLogo}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover' }}
      />
    );
  }
  // `mascot`, and `upload` before a logo is chosen, both fall to the brand
  // circle with a white glyph — exactly what `BotAvatar` renders.
  return (
    <span
      aria-hidden
      data-widget-avatar="mascot"
      className="flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, borderRadius: '50%', backgroundColor: primary }}
    >
      <Bot size={Math.round(size * 0.55)} color={WIDGET_ON_PRIMARY} />
    </span>
  );
}

/** An image or a file link, as the widget renders one. */
function Attachment({ file, imageLabel }: { file: WidgetFile; imageLabel: string }): ReactElement {
  if (file.contentType?.startsWith('image/')) {
    return (
      <img
        src={file.url}
        alt={file.filename || imageLabel}
        style={{ maxWidth: 200, borderRadius: 12, display: 'block' }}
      />
    );
  }
  return (
    <a
      href={file.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      style={{ color: '#2563EB', textDecoration: 'underline', fontSize: 13, wordBreak: 'break-all' }}
    >
      {file.filename || imageLabel}
    </a>
  );
}

/**
 * Where a run of messages from one speaker starts and ends.
 *
 * A visitor firing "hello / are you there? / hello" is one thought split across
 * three bubbles. The widget halves its gap for a continued run, and the
 * timestamp belongs at the foot of the run rather than under every line — the
 * drawer this replaces printed a clock and a speaker label on all three.
 */
function runFlags(messages: readonly WidgetMessage[]): { starts: boolean[]; ends: boolean[] } {
  const starts = messages.map((message, index) => {
    const previous = messages[index - 1];
    // A system line breaks any run: what happened between two messages is a
    // boundary in the conversation, not a continuation of it.
    return !previous || previous.role !== message.role || message.role === 'system';
  });
  const ends = starts.map((_, index) => index === starts.length - 1 || starts[index + 1]);
  return { starts, ends };
}

/**
 * Which messages open a new day.
 *
 * Derived, not accumulated while rendering: a variable mutated inside `map` is
 * read again on the next render with whatever the last one left in it, which
 * puts the divider on the wrong message. The inbox's transcript learned this
 * the same way.
 */
function dayFlags(
  messages: readonly WidgetMessage[],
  dayLabel: WidgetTranscriptProps['dayLabel'],
): Array<string | null> {
  if (!dayLabel) return messages.map(() => null);
  let previous: string | null = null;
  return messages.map((message) => {
    const day = dayLabel(message.at);
    if (day === null || day === previous) return null;
    previous = day;
    return day;
  });
}

/** The gap above a message: full between speakers, half within a run. */
const GAP_BETWEEN = 20;
const GAP_WITHIN = 10;

/**
 * How wide a line of the conversation is allowed to get.
 *
 * The widget is 380px, so its longest line is about 50 characters and the
 * question never comes up. A replay is read in a panel the operator can drag
 * to 1100, and the AI's answers — which have no bubble to hold them — set to
 * the full width: measured at 768 the first reply ran 699px, about 110
 * characters a line, which is roughly twice a comfortable measure and reads as
 * a wall. The bubbles keep the widget's 85% as well, whichever is smaller.
 */
const MAX_MEASURE = '34rem';

export function WidgetTranscript({
  appearance,
  messages,
  operatorName,
  showTimes = false,
  dayLabel,
  timeLabel,
  operatorFallback = 'Operator',
  imageLabel = 'Attachment',
  className,
}: WidgetTranscriptProps): ReactElement {
  const primary = appearance.primaryColor || DEFAULT_PRIMARY_COLOR;
  const visitorBubble = appearance.userBubbleColor || DEFAULT_USER_BUBBLE_COLOR;
  const components = markdownComponents(primary);
  const { starts, ends } = runFlags(messages);
  const days = dayFlags(messages, dayLabel);

  return (
    // LTR island, like the mock's panel: this mimics the shipped widget's own
    // LTR-only chrome, and its `justify-end` rows are direction-relative, so
    // without this they mirror under the console's `dir="rtl"` and misrepresent
    // what the visitor actually saw.
    <div dir="ltr" className={className} style={{ color: WIDGET_TEXT }}>
      {messages.map((message, index) => {
        const groupStart = starts[index];
        const groupEnd = ends[index];
        const day = days[index];

        const spacing: CSSProperties =
          index === 0 ? {} : { marginTop: groupStart ? GAP_BETWEEN : GAP_WITHIN };

        const time =
          showTimes && groupEnd && message.at && timeLabel ? timeLabel(message.at) : null;

        return (
          <Fragment key={message.key}>
            {day !== null ? (
              <p
                data-widget-day
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  margin: index === 0 ? '0 0 4px' : '20px 0 4px',
                  fontSize: 10,
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  color: WIDGET_TEXT_MUTED,
                }}
              >
                <span style={{ flex: 1, borderTop: '1px solid rgba(16,32,44,0.12)' }} />
                {day}
                <span style={{ flex: 1, borderTop: '1px solid rgba(16,32,44,0.12)' }} />
              </p>
            ) : null}

            {message.role === 'system' ? (
              <p
                data-widget-role="system"
                style={{ ...spacing, textAlign: 'center', fontSize: 12, margin: `${index === 0 ? 0 : 20}px 0 0`, color: WIDGET_TEXT_MUTED }}
              >
                {message.text}
                {time ? <span style={{ marginInlineStart: 6 }}>· {time}</span> : null}
              </p>
            ) : message.role === 'visitor' ? (
              <div
                data-widget-role="visitor"
                style={{ ...spacing, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}
              >
                <div
                  data-widget-bubble
                  style={{
                    maxWidth: `min(85%, ${MAX_MEASURE})`,
                    backgroundColor: visitorBubble,
                    color: WIDGET_TEXT,
                    // 8, not 16. `themeConfigs` gives the visitor bubble
                    // `rounded-lg`; the preview drew it at the window's radius.
                    borderRadius: 8,
                    padding: '7px 16px',
                    fontSize: 14,
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {/* Verbatim. This is exactly what the visitor typed, and
                      parsing it as markdown would reformat their own words. */}
                  {message.text}
                  {message.file ? (
                    <span style={{ display: 'block', marginTop: message.text ? 6 : 0 }}>
                      <Attachment file={message.file} imageLabel={imageLabel} />
                    </span>
                  ) : null}
                </div>
                {time ? <Time value={time} /> : null}
              </div>
            ) : message.role === 'bot' ? (
              <div data-widget-role="bot" style={{ ...spacing, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <span style={{ marginTop: 3, flex: 'none', visibility: groupStart ? 'visible' : 'hidden' }}>
                  <WidgetAvatar appearance={appearance} size={20} />
                </span>
                <div style={{ minWidth: 0, flex: 1, maxWidth: MAX_MEASURE }}>
                  <div
                    className="[&>*:last-child]:mb-0"
                    style={{ fontSize: 14, lineHeight: 1.6, fontWeight: 300, wordBreak: 'break-word' }}
                  >
                    {/* The AI writes markdown, so an operator reading its answer
                        would otherwise see `**Clean Images**` where the visitor
                        saw bold. No `rehype-raw`: this is a model's output, and
                        raw HTML here would render prompt-injected markup. */}
                    <ReactMarkdown components={components}>{message.text}</ReactMarkdown>
                  </div>
                  {message.file ? <Attachment file={message.file} imageLabel={imageLabel} /> : null}
                  {time ? <Time value={time} /> : null}
                </div>
              </div>
            ) : (
              <div
                data-widget-role="operator"
                style={{
                  ...spacing,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  maxWidth: MAX_MEASURE,
                }}
              >
                {groupStart ? (
                  <p style={{ margin: '0 0 2px 1px', fontSize: 11, fontWeight: 600, color: primary }}>
                    {operatorName || operatorFallback}
                  </p>
                ) : null}
                {/* Verbatim, like the visitor's: reformatting an operator's own
                    asterisks would be rewriting what they typed. */}
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {message.text}
                </p>
                {message.file ? <Attachment file={message.file} imageLabel={imageLabel} /> : null}
                {time ? <Time value={time} /> : null}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/** The run's clock. Mono, so a column of them lines up. */
function Time({ value }: { value: string }): ReactElement {
  return (
    <span
      data-widget-time
      className="figure"
      style={{ marginTop: 3, padding: '0 2px', fontSize: 10, color: WIDGET_TEXT_MUTED }}
    >
      {value}
    </span>
  );
}
