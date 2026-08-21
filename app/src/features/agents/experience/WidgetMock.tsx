import { type CSSProperties, type ReactElement, useState } from 'react';
import { Bot, Headphones, Send, X } from 'lucide-react';
import PremiumOrb from './PremiumOrb';
import {
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_USER_BUBBLE_COLOR,
  WIDGET_BORDER,
  WIDGET_BOT_BUBBLE,
  WIDGET_ON_PRIMARY,
  WIDGET_SURFACE,
  WIDGET_TEXT,
  WIDGET_TEXT_MUTED,
  WIDGET_RADIUS,
} from './widgetTheme';
import { PLACEHOLDERS, type ExperienceDraft } from './experience-model';

/**
 * The visitor's view, drawn from the draft.
 *
 * **Nothing in this file may use a console token.** The console is paper and
 * ink; this is a different product, rendering inside someone else's website in
 * colours its owner chose. Every value comes from the draft or from
 * `widgetTheme.ts`, which mirrors the shipped widget's own `classic` theme, and
 * every one of them is an inline style — a preview painted in `--color-surface`
 * would be a faithful preview of the wrong thing.
 *
 * It is a mock, not the widget: it renders the states a customer configures and
 * nothing else. The real thing is one click away, over the customer's own site,
 * behind "Preview on my website".
 */

export type PreviewState = 'welcome' | 'waiting' | 'offline';

export interface PreviewMessage {
  role: 'visitor' | 'bot';
  text: string;
}

export interface WidgetMockProps {
  draft: ExperienceDraft;
  /** The chatbot's name, already resolved against its fallbacks. */
  agentName: string;
  state: PreviewState;
  messages: readonly PreviewMessage[];
  pending: boolean;
  /** Mirrors the widget config endpoint's plan gate on the handoff control. */
  liveChatVisible: boolean;
  /** The credit line's wording, so the preview shows the badge a visitor
   *  actually reads rather than the default. */
  brandingText: string;
  /** Absent while the chatbot is still loading, which disables the composer. */
  onSend?: (question: string) => void;
}

/**
 * The mock fills its column, up to the width the real widget actually is.
 *
 * A fixed panel right-aligned inside a 384px aside left 44px of dead space on
 * its left, under a heading, a badge and a segmented control that were all
 * left-aligned at x=0 — so nothing in the preview column lined up with anything
 * else in the preview column. Filling the column is right in the aside, which is
 * narrower than the widget.
 *
 * It is wrong the moment the column is wider. `Columns` drops to one column
 * below 56rem of page, and the preview then took the whole 968px measure: a
 * chat window two and a half times the width of the one on the customer's site,
 * wrapping bubbles and starter-question chips at a measure no visitor will ever
 * see. `md:w-[380px]` is what `widget/src/components/themeConfigs.js` paints on
 * every desktop theme, so that is the ceiling here.
 */
const PANEL_MAX_WIDTH = 380;
const PANEL_HEIGHT = 460;

function text(value: string, fallback: string): string {
  return value.trim().length > 0 ? value : fallback;
}

/** The badge's two-tone split, as `splitBrandingText` does it in the widget. */
function splitBranding(label: string): { lead: string; brand: string } {
  const cleaned = label.trim();
  const lastSpace = cleaned.lastIndexOf(' ');
  if (lastSpace === -1) return { lead: '', brand: cleaned };
  return { lead: cleaned.slice(0, lastSpace), brand: cleaned.slice(lastSpace + 1) };
}

function Avatar({ draft, size }: { draft: ExperienceDraft; size: number }): ReactElement {
  const primary = draft.primaryColor || DEFAULT_PRIMARY_COLOR;
  if (draft.avatarType === 'orb') {
    return <PremiumOrb color={draft.orbColor || primary} size={size} />;
  }
  if (draft.avatarType === 'upload' && draft.botLogo) {
    return (
      <img
        src={draft.botLogo}
        alt=""
        width={size}
        height={size}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover' }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, borderRadius: '50%', backgroundColor: primary }}
    >
      <Bot size={Math.round(size * 0.55)} color={WIDGET_ON_PRIMARY} />
    </span>
  );
}

function Bubble({
  children,
  background,
  align,
}: {
  children: string;
  background: string;
  align: 'start' | 'end';
}): ReactElement {
  return (
    <div className="flex w-full" style={{ justifyContent: align === 'end' ? 'flex-end' : 'flex-start' }}>
      <p
        style={{
          maxWidth: '85%',
          backgroundColor: background,
          color: WIDGET_TEXT,
          border: background === WIDGET_BOT_BUBBLE ? `1px solid ${WIDGET_BORDER}` : undefined,
          borderRadius: WIDGET_RADIUS.panel,
          padding: '8px 12px',
          fontSize: 13,
          lineHeight: 1.45,
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {children}
      </p>
    </div>
  );
}

export function WidgetMock({
  draft,
  agentName,
  state,
  messages,
  pending,
  liveChatVisible,
  brandingText,
  onSend,
}: WidgetMockProps): ReactElement {
  const [composed, setComposed] = useState('');
  const primary = draft.primaryColor || DEFAULT_PRIMARY_COLOR;
  const visitorBubble = draft.userBubbleColor || DEFAULT_USER_BUBBLE_COLOR;
  const suggestions = draft.quickActions.map((s) => s.trim()).filter((s) => s.length > 0);
  const branding = splitBranding(text(brandingText, PLACEHOLDERS.brandingText));

  const panel: CSSProperties = {
    width: '100%',
    height: PANEL_HEIGHT,
    backgroundColor: WIDGET_SURFACE,
    border: `1px solid ${WIDGET_BORDER}`,
    borderRadius: WIDGET_RADIUS.panel,
    color: WIDGET_TEXT,
    overflow: 'hidden',
  };

  function submit(): void {
    const question = composed.trim();
    if (!question || !onSend) return;
    setComposed('');
    onSend(question);
  }

  return (
    <div className="flex flex-col items-stretch gap-3" style={{ maxWidth: PANEL_MAX_WIDTH }}>
      {/* The chat window. `aria-label` rather than a heading: this is a picture
          of another product, and giving it a real heading would put a second
          document outline inside the page's own. */}
      <div style={panel} className="flex flex-col" role="group" aria-label="Chat widget preview">
        <header
          className="flex shrink-0 items-center gap-2.5"
          style={{ padding: '10px 12px', borderBottom: `1px solid ${WIDGET_BORDER}` }}
        >
          <Avatar draft={draft} size={28} />
          <span className="min-w-0 flex-1 truncate" style={{ fontSize: 13, fontWeight: 600 }}>
            {agentName}
          </span>
          {liveChatVisible ? (
            <Headphones size={14} color={WIDGET_TEXT_MUTED} aria-hidden />
          ) : null}
          <X size={14} color={WIDGET_TEXT_MUTED} aria-hidden />
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" style={{ padding: 12 }}>
          {state === 'offline' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <Avatar draft={draft} size={40} />
              <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>
                {text(draft.offlineBanner, PLACEHOLDERS.offlineBanner)}
              </p>
              <span
                style={{
                  backgroundColor: primary,
                  color: WIDGET_ON_PRIMARY,
                  borderRadius: WIDGET_RADIUS.control,
                  padding: '7px 14px',
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                Leave a message
              </span>
            </div>
          ) : state === 'waiting' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <Headphones size={22} color={primary} aria-hidden />
              <p style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>
                {text(draft.waitingMessage, PLACEHOLDERS.waitingMessage)}
              </p>
              <span style={{ fontSize: 11, color: WIDGET_TEXT_MUTED }}>
                {text(draft.endChatLabel, PLACEHOLDERS.endChatLabel)}
              </span>
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-1 flex-col justify-center gap-3">
              <Avatar draft={draft} size={44} />
              <div>
                <p style={{ fontSize: 17, fontWeight: 600, margin: 0, lineHeight: 1.3 }}>
                  {text(draft.welcomeGreeting, PLACEHOLDERS.welcomeGreeting)}
                </p>
                <p style={{ fontSize: 13, margin: '4px 0 0', lineHeight: 1.5 }}>
                  {text(draft.welcomeSubtitle, PLACEHOLDERS.welcomeSubtitle)}
                </p>
              </div>
              {suggestions.length > 0 ? (
                <ul
                  className="flex list-none flex-wrap gap-1.5"
                  style={{
                    margin: 0,
                    padding: 0,
                    flexDirection: draft.suggestionsLayout === 'vertical' ? 'column' : 'row',
                  }}
                >
                  {suggestions.map((suggestion, index) => (
                    <li key={`${suggestion}-${index}`} className="min-w-0">
                      <button
                        type="button"
                        disabled={!onSend}
                        onClick={() => onSend?.(suggestion)}
                        style={{
                          backgroundColor: WIDGET_BOT_BUBBLE,
                          border: `1px solid ${WIDGET_BORDER}`,
                          color: WIDGET_TEXT,
                          borderRadius: 999,
                          padding: '6px 11px',
                          fontSize: 12,
                          maxWidth: '100%',
                          // A starter question at the model's own character
                          // limit made the panel scroll sideways: the chip had
                          // no truncation and a flex row will not shrink it.
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          textAlign: 'left',
                          cursor: onSend ? 'pointer' : 'default',
                        }}
                      >
                        {suggestion}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : (
            <>
              {messages.map((message, index) => (
                <Bubble
                  key={index}
                  align={message.role === 'visitor' ? 'end' : 'start'}
                  background={message.role === 'visitor' ? visitorBubble : WIDGET_BOT_BUBBLE}
                >
                  {message.text}
                </Bubble>
              ))}
              {pending ? (
                <div className="flex items-center gap-1" aria-label="Typing">
                  {[0, 1, 2].map((dot) => (
                    <span
                      key={dot}
                      className="typing-dot"
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: '50%',
                        backgroundColor: primary,
                        display: 'block',
                      }}
                    />
                  ))}
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="shrink-0" style={{ padding: '0 12px 10px' }}>
          <div
            className="flex items-center gap-2"
            style={{
              backgroundColor: WIDGET_BOT_BUBBLE,
              border: `1px solid ${WIDGET_BORDER}`,
              borderRadius: WIDGET_RADIUS.composer,
              padding: '6px 8px 6px 10px',
            }}
          >
            <input
              value={composed}
              onChange={(event) => setComposed(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              disabled={!onSend || state !== 'welcome'}
              aria-label="Ask your chatbot a question in the preview"
              placeholder={text(draft.inputPlaceholder, PLACEHOLDERS.inputPlaceholder)}
              className="min-w-0 flex-1 border-0 bg-transparent outline-none"
              style={{ fontSize: 13, color: WIDGET_TEXT }}
            />
            <button
              type="button"
              onClick={submit}
              disabled={!onSend || composed.trim().length === 0 || state !== 'welcome'}
              aria-label="Send preview message"
              className="flex shrink-0 items-center justify-center"
              style={{
                width: 26,
                height: 26,
                borderRadius: WIDGET_RADIUS.control,
                backgroundColor: composed.trim().length > 0 ? primary : WIDGET_BORDER,
                cursor: composed.trim().length > 0 ? 'pointer' : 'default',
              }}
            >
              <Send size={13} color={WIDGET_ON_PRIMARY} aria-hidden />
            </button>
          </div>

          <div
            className="mt-1.5 flex items-center justify-between gap-2"
            style={{ fontSize: 10, color: WIDGET_TEXT_MUTED }}
          >
            <span>{liveChatVisible ? text(draft.liveChatLabel, PLACEHOLDERS.liveChatLabel) : ''}</span>
            <span>Privacy Policy</span>
            {draft.showBranding ? (
              <span className="truncate">
                {branding.lead ? `${branding.lead} ` : ''}
                <span style={{ color: primary, fontWeight: 600 }}>{branding.brand}</span>
              </span>
            ) : (
              <span />
            )}
          </div>
        </div>
      </div>

      {/* The launcher, closed. It is the only part of the widget most visitors
          ever see, so a branding preview that omits it is missing the point. */}
      <div className="flex items-center justify-end gap-2">
        <span
          style={{
            backgroundColor: WIDGET_BOT_BUBBLE,
            border: `1px solid ${WIDGET_BORDER}`,
            borderRadius: 999,
            padding: '5px 11px',
            fontSize: 11,
            color: WIDGET_TEXT,
          }}
        >
          {text(draft.launcherName, PLACEHOLDERS.launcherName)}
        </span>
        <span
          className="flex items-center justify-center overflow-hidden"
          style={{ width: 48, height: 48, borderRadius: '50%', backgroundColor: WIDGET_BOT_BUBBLE }}
        >
          <Avatar draft={draft} size={48} />
        </span>
      </div>
    </div>
  );
}
