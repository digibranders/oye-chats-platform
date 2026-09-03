import { type CSSProperties, type ReactElement, useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import { Bot, Menu, X } from 'lucide-react';
import PremiumOrb from './PremiumOrb';
import {
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_USER_BUBBLE_COLOR,
  WIDGET_BADGE_BG,
  WIDGET_BRAND_CREDIT,
  WIDGET_CHIP_BG,
  WIDGET_CHIP_BORDER,
  WIDGET_CHIP_TEXT,
  WIDGET_CHIP_TEXT_VERTICAL,
  WIDGET_FOOTER_TEXT,
  WIDGET_INPUT_BORDER,
  WIDGET_ON_PRIMARY,
  WIDGET_RADIUS,
  WIDGET_SEND_INACTIVE,
  WIDGET_SUBTITLE,
  WIDGET_SURFACE,
  WIDGET_TEXT,
  WIDGET_TEXT_MUTED,
  WIDGET_TYPING_BG,
  WIDGET_TYPING_DOT,
  WIDGET_WINDOW_BORDER,
} from './widgetTheme';
import { PLACEHOLDERS, type ExperienceDraft } from './experience-model';
import { useTranslation } from '../../../i18n/useTranslation';

/**
 * The visitor's view, drawn from the draft to match the shipped widget.
 *
 * **Nothing in this file may use a console token.** The console is paper and
 * ink; this is a different product, rendering inside someone else's website in
 * colours its owner chose. Every value comes from the draft or from
 * `widgetTheme.ts`, which mirrors the shipped widget's own `classic` theme, and
 * every one of them is an inline style — a preview painted in `--color-surface`
 * would be a faithful preview of the wrong thing.
 *
 * It is drawn to the widget's real anatomy, not a simplified sketch of it,
 * because a preview that disagrees with what ships is worse than none:
 *
 * - The header carries no title and no clock: the left is empty on first open
 *   (the conversation-history icon appears only for a returning visitor), and
 *   the right is the actions hamburger plus the close control (`renderHeader`
 *   + the header cluster). Identity floats over the messages in a pill
 *   (`renderAgentBadge`), so the name and avatar read the same here as on the
 *   customer's site.
 * - A bot reply is an avatar and rendered markdown, never a bubble — the same
 *   ReactMarkdown the widget runs, so bold, lists and links read the same here
 *   as on the customer's site. Only the visitor's own turns get a bubble, in
 *   their chosen colour (`MessageBubble`).
 * - The composer is a bordered well with a bare send glyph, not a filled
 *   circle. The live-chat, booking, transcript, language and leave-a-message
 *   controls all moved into the header hamburger, so the footer is now just two
 *   pieces of standing text (`ChatInput`): Privacy on the left and the OyeChats
 *   credit centred — in OyeChats' own violet, never the customer's colour.
 * - The launcher is the 56px button a visitor actually sees, with the name in a
 *   tooltip above it (`Launcher`), not a pill beside it.
 *
 * It stays a mock, not the widget: it renders the states a customer configures
 * and nothing else, and the waiting and offline screens are faithful in styling
 * rather than in every animated beat. The real thing is one click away, over
 * the customer's own site, behind "Preview on my website".
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
 * `md:w-[380px]` and `md:h-[580px]` are what `widget/src/components/themeConfigs.js`
 * paints on every desktop theme. Width is the hard ceiling — a chat window
 * wider than the customer's own wraps bubbles and chips at a measure no visitor
 * will ever see. Height echoes the shipped proportion without demanding the full
 * 580px the page cannot spare inside a card column.
 */
const PANEL_MAX_WIDTH = 380;
const PANEL_HEIGHT = 540;

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
  // `mascot`, and `upload` before a logo is chosen, both fall to the brand
  // circle with a white glyph — exactly what `BotAvatar` renders.
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

/** The bot's identity, floating over the top of the messages. `renderAgentBadge`. */
function AgentBadge({ draft, agentName }: { draft: ExperienceDraft; agentName: string }): ReactElement {
  return (
    <div className="shrink-0 flex justify-center" style={{ marginTop: -12, marginBottom: -20, zIndex: 3, position: 'relative' }}>
      <span
        className="inline-flex items-center gap-2"
        style={{
          backgroundColor: WIDGET_BADGE_BG,
          border: `1px solid ${WIDGET_WINDOW_BORDER}`,
          borderRadius: 999,
          padding: '6px 14px 6px 6px',
          boxShadow: '0 10px 15px -3px rgba(16, 32, 44, 0.1)',
        }}
      >
        <Avatar draft={draft} size={28} />
        <span className="truncate" style={{ fontSize: 12, fontWeight: 600, color: WIDGET_TEXT, maxWidth: 220 }}>
          {agentName}
        </span>
      </span>
    </div>
  );
}

/** A finished bot reply: avatar plus rendered markdown, no bubble.
 *  `MessageBubble` renders the same text through ReactMarkdown, so the mock does
 *  too — otherwise the model's `**bold**`, lists and links show as raw syntax in
 *  the preview while rendering cleanly on the customer's site. Block elements are
 *  given tight, inline-styled spacing (react-markdown emits real `<p>`/`<ul>`
 *  with browser-default margins that read as loose gaps in a chat bubble). */
function BotRow({ draft, children }: { draft: ExperienceDraft; children: string }): ReactElement {
  const linkColor = draft.primaryColor || DEFAULT_PRIMARY_COLOR;
  const components: Components = {
    p: ({ children: c }) => <p style={{ margin: '0 0 6px' }}>{c}</p>,
    // rtl-ok: mimics the shipped widget's own markdown rendering (a separate,
    // LTR-first product — see the file header), not the console's chrome.
    ul: ({ children: c }) => <ul style={{ margin: '0 0 6px', paddingLeft: 18 }}>{c}</ul>, // rtl-ok: see above
    ol: ({ children: c }) => <ol style={{ margin: '0 0 6px', paddingLeft: 18 }}>{c}</ol>, // rtl-ok: see above
    li: ({ children: c }) => <li style={{ margin: '2px 0' }}>{c}</li>,
    a: ({ href, children: c }) => (
      <a href={href} target="_blank" rel="noopener noreferrer" style={{ color: linkColor, textDecoration: 'underline' }}>
        {c}
      </a>
    ),
    code: ({ children: c }) => (
      <code style={{ backgroundColor: 'rgba(16,32,44,0.06)', borderRadius: 4, padding: '1px 4px', fontSize: 13 }}>
        {c}
      </code>
    ),
  };
  return (
    <div className="flex w-full items-start gap-2">
      <span className="mt-0.5 shrink-0">
        <Avatar draft={draft} size={20} />
      </span>
      <div
        className="min-w-0 flex-1 [&>*:last-child]:mb-0"
        style={{ fontSize: 14, lineHeight: 1.6, fontWeight: 300, color: WIDGET_TEXT, wordBreak: 'break-word' }}
      >
        <Markdown components={components}>{children}</Markdown>
      </div>
    </div>
  );
}

/** A visitor turn: a right-aligned bubble in their chosen colour. */
function UserBubble({ background, children }: { background: string; children: string }): ReactElement {
  return (
    <div className="flex w-full justify-end">
      <p
        style={{
          maxWidth: '85%',
          backgroundColor: background,
          color: WIDGET_TEXT,
          borderRadius: WIDGET_RADIUS.window,
          padding: '12px 16px',
          fontSize: 14,
          lineHeight: 1.5,
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

/** The three-dot pill the bot's reply lands in while it streams. `TypingIndicator`. */
function Typing({ draft, label }: { draft: ExperienceDraft; label: string }): ReactElement {
  return (
    <div className="flex w-full items-end gap-2" aria-label={label}>
      <span className="shrink-0">
        <Avatar draft={draft} size={20} />
      </span>
      <span
        className="flex items-center gap-1.5"
        style={{ backgroundColor: WIDGET_TYPING_BG, borderRadius: 16, borderBottomLeftRadius: 4, padding: '10px 12px' }}
      >
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className="typing-dot"
            style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: WIDGET_TYPING_DOT, display: 'block' }}
          />
        ))}
      </span>
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
  const { t } = useTranslation();
  const [composed, setComposed] = useState('');
  const primary = draft.primaryColor || DEFAULT_PRIMARY_COLOR;
  const visitorBubble = draft.userBubbleColor || DEFAULT_USER_BUBBLE_COLOR;
  const suggestions = draft.quickActions.map((s) => s.trim()).filter((s) => s.length > 0);
  const branding = splitBranding(text(brandingText, PLACEHOLDERS.brandingText));
  const isVertical = draft.suggestionsLayout === 'vertical';
  const composerReady = Boolean(onSend) && state === 'welcome';
  const canSend = composed.trim().length > 0;

  const panel: CSSProperties = {
    width: '100%',
    height: PANEL_HEIGHT,
    backgroundColor: WIDGET_SURFACE,
    border: `1px solid ${WIDGET_WINDOW_BORDER}`,
    borderRadius: WIDGET_RADIUS.window,
    color: WIDGET_TEXT,
    overflow: 'hidden',
    boxShadow: '0 24px 48px -16px rgba(16, 32, 44, 0.22)',
  };

  function submit(): void {
    const question = composed.trim();
    if (!question || !onSend) return;
    setComposed('');
    onSend(question);
  }

  const showBadge = state === 'welcome';
  const hasConversation = messages.length > 0;
  // The header hamburger appears whenever it would have at least one entry. The
  // mock knows two of the five gates for certain: live chat (`liveChatVisible`,
  // already the plan+toggle result) and the transcript, which unlocks once
  // there are messages. Booking, language and leave-a-message depend on config
  // the mock isn't handed, so gating on these two is the faithful floor.
  const showMenu = liveChatVisible || hasConversation;

  return (
    // LTR island: this whole panel mimics the shipped widget's own LTR-only
    // chrome (see the rtl-ok comments below on its caret and header layout),
    // not the console's. Its `justify-end`/`items-end` rows are direction-
    // relative, so without this they silently mirror under the console's own
    // `dir="rtl"` and misrepresent what visitors actually see.
    <div
      dir="ltr"
      className="flex flex-col items-stretch gap-4"
      style={{ maxWidth: PANEL_MAX_WIDTH }}
    >
      {/* The chat window. `aria-label` rather than a heading: this is a picture
          of another product, and giving it a real heading would put a second
          document outline inside the page's own. */}
      <div style={panel} className="flex flex-col" role="group" aria-label={t('agents.chatWidgetPreview') || 'Chat widget preview'}>
        {/* Header — empty left, chrome controls on the right, no hairline.
            `renderHeader` + the header control cluster. The left carries the
            conversation-history icon only for a returning visitor with past
            threads, which a first-open preview never has, so it stays empty. */}
        <header className="flex shrink-0 items-center justify-between" style={{ padding: '8px 20px' }}>
          <span aria-hidden />
          <span className="flex items-center gap-1">
            {showMenu ? <Menu size={18} color={WIDGET_TEXT_MUTED} aria-hidden /> : null}
            <X size={18} color={WIDGET_TEXT_MUTED} aria-hidden />
          </span>
        </header>

        {showBadge ? <AgentBadge draft={draft} agentName={agentName} /> : null}

        <div
          className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto"
          style={{ padding: showBadge ? '24px 20px 4px' : '16px 20px 4px' }}
        >
          {state === 'offline' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <Avatar draft={draft} size={40} />
              <p style={{ fontSize: 14, lineHeight: 1.5, margin: 0, color: WIDGET_TEXT }}>
                {text(draft.offlineBanner, PLACEHOLDERS.offlineBanner)}
              </p>
              <span
                style={{
                  backgroundColor: primary,
                  color: WIDGET_ON_PRIMARY,
                  borderRadius: WIDGET_RADIUS.chip,
                  padding: '9px 16px',
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {t('agents.leaveAMessage') || 'Leave a message'}
              </span>
            </div>
          ) : state === 'waiting' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <span
                className="flex items-center justify-center"
                style={{ width: 44, height: 44, borderRadius: '50%', backgroundColor: `${primary}1a` }}
              >
                <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: primary, display: 'block' }} />
              </span>
              <p style={{ fontSize: 14, lineHeight: 1.5, margin: 0, color: WIDGET_TEXT }}>
                {text(draft.waitingMessage, PLACEHOLDERS.waitingMessage)}
              </p>
              <span style={{ fontSize: 11, color: WIDGET_TEXT_MUTED }}>
                {text(draft.endChatLabel, PLACEHOLDERS.endChatLabel)}
              </span>
            </div>
          ) : hasConversation ? (
            <>
              {messages.map((message, index) =>
                message.role === 'visitor' ? (
                  <UserBubble key={index} background={visitorBubble}>
                    {message.text}
                  </UserBubble>
                ) : (
                  <BotRow key={index} draft={draft}>
                    {message.text}
                  </BotRow>
                ),
              )}
              {pending ? <Typing draft={draft} label={t('agents.typing') || 'Typing'} /> : null}
            </>
          ) : (
            // Welcome. Left-aligned, pinned to the bottom of the messages area,
            // no avatar — the floating badge above carries identity. `WelcomeScreen`.
            // rtl-ok: widget welcome-screen content, mimics the shipped widget's
            // own LTR rendering, not the console's chrome.
            <div className="flex flex-1 flex-col items-start justify-end gap-0 text-left">
              <p style={{ fontSize: 24, fontWeight: 700, margin: 0, lineHeight: 1.25, color: WIDGET_TEXT }}>
                {text(draft.welcomeGreeting, PLACEHOLDERS.welcomeGreeting)}
              </p>
              <p style={{ fontSize: 15, margin: '4px 0 0', lineHeight: 1.5, color: WIDGET_SUBTITLE }}>
                {text(draft.welcomeSubtitle, PLACEHOLDERS.welcomeSubtitle)}
              </p>
              {suggestions.length > 0 ? (
                <ul
                  className="flex list-none"
                  style={{
                    margin: isVertical ? '8px 0 0' : '20px 0 0',
                    padding: 0,
                    gap: 8,
                    width: isVertical ? '100%' : undefined,
                    flexWrap: isVertical ? 'nowrap' : 'wrap',
                    flexDirection: isVertical ? 'column' : 'row',
                    alignItems: isVertical ? 'stretch' : 'flex-start',
                  }}
                >
                  {suggestions.map((suggestion, index) => (
                    <li key={`${suggestion}-${index}`} className="min-w-0" style={{ width: isVertical ? '100%' : undefined }}>
                      <button
                        type="button"
                        disabled={!onSend}
                        onClick={() => onSend?.(suggestion)}
                        style={{
                          backgroundColor: WIDGET_CHIP_BG,
                          border: `1px solid ${WIDGET_CHIP_BORDER}`,
                          color: isVertical ? WIDGET_CHIP_TEXT_VERTICAL : WIDGET_CHIP_TEXT,
                          borderRadius: isVertical ? WIDGET_RADIUS.chip : 999,
                          padding: isVertical ? '10px 16px' : '8px 16px',
                          fontSize: 13,
                          width: isVertical ? '100%' : undefined,
                          maxWidth: '100%',
                          // A starter question at the model's own character limit
                          // made the panel scroll sideways: a horizontal chip has
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
          )}
        </div>

        {/* Composer + action bar. `ChatInput`. */}
        <div className="shrink-0" style={{ padding: '0 16px 16px' }}>
          <div
            className="flex items-end gap-2"
            style={{
              backgroundColor: '#FFFFFF',
              border: `1px solid ${WIDGET_INPUT_BORDER}`,
              borderRadius: WIDGET_RADIUS.window,
              padding: '8px 12px',
              boxShadow: '0 1px 2px 0 rgba(16, 32, 44, 0.05)',
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
              disabled={!composerReady}
              aria-label={t('agents.askYourChatbotAQuestion') || 'Ask your chatbot a question in the preview'}
              placeholder={text(draft.inputPlaceholder, PLACEHOLDERS.inputPlaceholder)}
              className="min-w-0 flex-1 border-0 bg-transparent outline-none"
              style={{ fontSize: 14, color: WIDGET_TEXT }}
            />
            <button
              type="button"
              onClick={submit}
              disabled={!composerReady || !canSend}
              aria-label={t('agents.sendPreviewMessage') || 'Send preview message'}
              className="mb-0.5 flex shrink-0 items-center justify-center"
              style={{ cursor: composerReady && canSend ? 'pointer' : 'default', background: 'none', border: 0, padding: 0 }}
            >
              {/* `SendIcon`. A bare glyph, no ground; it darkens once there is
                  something to send. */}
              <svg width={18} height={18} viewBox="0 0 30 30" fill="none" aria-hidden style={{ color: canSend ? WIDGET_TEXT : WIDGET_SEND_INACTIVE }}>
                <path
                  d="M29.0178 16.0651L28.5877 16.4951L2.66773 29.7851C1.93773 30.1551 1.07772 30.0051 0.537723 29.4551C0.00772303 28.9251 -0.172253 28.0851 0.187747 27.3651L5.28772 17.1651L17.4377 14.9951L5.25775 12.7751L0.207767 2.67508C-0.162233 1.93508 -0.022277 1.09507 0.537723 0.535067C1.06772 0.00506717 1.91775 -0.174899 2.62775 0.195101L28.5577 13.4551L29.0277 13.9251C29.4377 14.6151 29.4377 15.3851 29.0277 16.0751L29.0178 16.0651Z"
                  fill="currentColor"
                />
              </svg>
            </button>
          </div>

          {/* Two pieces of standing text on a three-column grid: Privacy on the
              left and the OyeChats credit centred, with an empty right column as
              the counterweight that keeps the credit centred whether or not the
              branding renders. The handoff control that used to sit here moved
              into the header hamburger. The credit's brand word is in OyeChats'
              own violet, never the customer's colour. Privacy shows here in the
              welcome state, the moment it exists for; the shipped widget hides
              it once the first message is sent. */}
          <div className="mt-3.5 grid grid-cols-3 items-center gap-3 px-1">
            <span
              className="justify-self-start"
              style={{ fontSize: 10, fontWeight: 600, color: WIDGET_FOOTER_TEXT }}
            >
              {t('agents.privacyPolicy') || 'Privacy Policy'}
            </span>
            {draft.showBranding ? (
              <span
                className="justify-self-center truncate"
                style={{ fontSize: 10, fontWeight: 600, color: WIDGET_FOOTER_TEXT, whiteSpace: 'nowrap' }}
              >
                {branding.lead ? `${branding.lead} ` : ''}
                <span style={{ color: WIDGET_BRAND_CREDIT }}>{branding.brand}</span>
              </span>
            ) : (
              <span className="justify-self-center" />
            )}
            <span className="justify-self-end" />
          </div>
        </div>
      </div>

      {/* The launcher, closed — the 56px button and the name in a tooltip above
          it. It is the only part of the widget most visitors ever see, so a
          branding preview that omits it is missing the point. `Launcher`. */}
      <div className="flex justify-end">
        <div className="relative flex flex-col items-end">
          <div
            className="mb-3"
            style={{
              backgroundColor: '#FFFFFF',
              border: '1px solid #F3F4F6',
              borderRadius: WIDGET_RADIUS.chip,
              padding: '8px 16px',
              boxShadow: '0 10px 15px -3px rgba(16, 32, 44, 0.1)',
              position: 'relative',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700, color: '#374151' }}>
              {text(draft.launcherName, PLACEHOLDERS.launcherName)}
            </span>
            {/* The caret pointing down at the launcher. */}
            {/* rtl-ok: positions the caret exactly as the shipped widget does;
                this pane mimics the widget's own LTR chrome, not the console's. */}
            <span
              aria-hidden
              style={{
                position: 'absolute',
                bottom: -8,
                right: 24, // rtl-ok: mimics the shipped widget's own LTR chrome, not the console's
                width: 16,
                height: 16,
                backgroundColor: '#FFFFFF',
                transform: 'rotate(45deg)',
                borderRight: '1px solid #F3F4F6',
                borderBottom: '1px solid #F3F4F6',
              }}
            />
          </div>
          <span
            className="flex items-center justify-center overflow-hidden"
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              backgroundColor: '#FFFFFF',
              boxShadow: '0 10px 15px -3px rgba(16, 32, 44, 0.15)',
            }}
          >
            <Avatar draft={draft} size={56} />
          </span>
        </div>
      </div>
    </div>
  );
}
