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

/** Message text, in both the bot and visitor bubbles. `classic.userBubble`. */
export const WIDGET_TEXT = '#16202C';

/** Muted metadata: the footer credit, the privacy line. Tailwind `gray-400`. */
export const WIDGET_TEXT_MUTED = '#9CA3AF';

/** Hairlines inside the window. */
export const WIDGET_BORDER = '#E5E7EB';

/** The bot bubble's ground — the window's own surface, with a hairline. */
export const WIDGET_BOT_BUBBLE = '#FFFFFF';

/** What the widget falls back to when a bot has never been given a colour.
 *  Mirrors `_bot_to_response`'s `bot.primary_color or "#ba68c8"`. */
export const DEFAULT_PRIMARY_COLOR = '#ba68c8';

/** `bot.user_bubble_color or "#DBE9FF"`, and `classic.userBubbleDefaultBg`. */
export const DEFAULT_USER_BUBBLE_COLOR = '#DBE9FF';

/** White sits on the brand colour: the launcher glyph, the send button, the
 *  mascot avatar's icon. This is the pair the brand-colour check measures. */
export const WIDGET_ON_PRIMARY = '#FFFFFF';
