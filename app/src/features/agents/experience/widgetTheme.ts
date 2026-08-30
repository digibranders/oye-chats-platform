/**
 * The embeddable widget's own palette, as the visitor sees it.
 *
 * These are NOT console tokens and must never be swapped for one. The console
 * is paper and ink; the widget is a separate product rendering on someone
 * else's website, and a preview painted in console colours would be a preview
 * of the wrong thing. Every value here is copied from the shipped widget's
 * `classic` theme (`widget/src/components/themeConfigs.js`) and from the
 * defaults its components fall back to.
 *
 * They live in one module because two things read them and must agree: the
 * preview mock, which paints them, and `contrast.ts`'s callers, which measure
 * the customer's colours against them. A preview that draws a bubble on
 * `#F8F8F8` while the contrast readout measures against white is a readout
 * about a screen nobody is looking at.
 */

/** The chat window's ground. `themeConfigs.classic.container`. */
export const WIDGET_SURFACE = '#F8F8F8';

/** Message text, the visitor bubble, and the bot's plain reply. `classic`. */
export const WIDGET_TEXT = '#16202C';

/** Muted metadata: the header date-time, control glyphs. Tailwind `gray-400`. */
export const WIDGET_TEXT_MUTED = '#9CA3AF';

/** The welcome subtitle and the launcher greeting body. Tailwind `gray-500`. */
export const WIDGET_SUBTITLE = '#6B7280';

/** The window's outer edge. `border-[#BBE7FF]/30` in `classic.container`. The
 *  classic theme has no header or messages-area hairline — the window border is
 *  the only rule the visitor sees. */
export const WIDGET_WINDOW_BORDER = 'rgba(187, 231, 255, 0.3)';

/** The composer well's edge. `border-[#BBE7FF]/50` in `ChatInput`. */
export const WIDGET_INPUT_BORDER = 'rgba(187, 231, 255, 0.5)';

/** The send glyph before there is anything to send. `text-[#BBE7FF]`. */
export const WIDGET_SEND_INACTIVE = '#BBE7FF';

/** White pill the bot's identity floats in over the messages. `renderAgentBadge`
 *  paints `rgba(255,255,255,0.92)` with a blur; the preview drops the blur. */
export const WIDGET_BADGE_BG = 'rgba(255, 255, 255, 0.92)';

/** A starter chip: `bg-gray-50 border-gray-200 text-gray-600` (horizontal) and
 *  `text-gray-700` (vertical). `WelcomeScreen`. */
export const WIDGET_CHIP_BG = '#F9FAFB';
export const WIDGET_CHIP_BORDER = '#E5E7EB';
export const WIDGET_CHIP_TEXT = '#4B5563';
export const WIDGET_CHIP_TEXT_VERTICAL = '#374151';

/** The typing bubble the bot's reply lands in. `TypingIndicator`: a `gray-100`
 *  pill with `gray-400` dots. */
export const WIDGET_TYPING_BG = '#F3F4F6';
export const WIDGET_TYPING_DOT = '#9CA3AF';

/** The footer's Privacy and credit links. Tailwind `gray-300`. */
export const WIDGET_FOOTER_TEXT = '#D1D5DB';

/**
 * The credit line's brand word is a fixed OyeChats violet, NOT the customer's
 * primary colour: "Powered by OyeChats" is our mark, not theirs. `ChatInput`
 * paints it as `rgb(49% 23% 93%)`, kept verbatim so the preview matches to the
 * channel.
 */
export const WIDGET_BRAND_CREDIT = 'rgb(49% 23% 93%)';

/** Legacy hairline kept for callers outside the mock. */
export const WIDGET_BORDER = '#E5E7EB';

/** The bot bubble's ground — retained for callers; the classic bot reply is
 *  bubble-less plain text and no longer paints on it. */
export const WIDGET_BOT_BUBBLE = '#FFFFFF';

/** What the widget falls back to when a bot has never been given a colour.
 *  Mirrors `_bot_to_response`'s `bot.primary_color or "#ba68c8"`. */
export const DEFAULT_PRIMARY_COLOR = '#ba68c8';

/** `bot.user_bubble_color or "#DBE9FF"`, and `classic.userBubbleDefaultBg`. */
export const DEFAULT_USER_BUBBLE_COLOR = '#DBE9FF';

/** White sits on the brand colour: the launcher glyph, the send button, the
 *  mascot avatar's icon. This is the pair the brand-colour check measures. */
export const WIDGET_ON_PRIMARY = '#FFFFFF';

/**
 * The widget's own corner radii, beside its colours and for the same reason.
 *
 * The classic theme speaks in two radii: `rounded-2xl` (16px) for the window,
 * the visitor bubble and the composer well, and `rounded-xl` (12px) for a
 * stacked starter chip. A horizontal chip is a full pill and the send glyph has
 * no ground, so neither needs a value here. They are constants so the preview
 * cannot invent a third.
 */
export const WIDGET_RADIUS = {
  /** The chat window, the visitor bubble, and the composer well. `rounded-2xl`. */
  window: 16,
  /** A vertically stacked starter chip. `rounded-xl`. */
  chip: 12,
} as const;
