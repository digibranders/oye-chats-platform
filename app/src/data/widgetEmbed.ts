/**
 * widgetEmbed - single source of truth for the markup a customer pastes.
 *
 * The widget mounts into a shadow root from JavaScript, after the visitor
 * clicks the launcher. That means nothing it renders - including the "Powered
 * by OyeChats" badge - is ever visible to a crawler: non-rendering crawlers run
 * no JS at all, and rendering ones never click. The only attribution that can
 * be indexed is an anchor that sits in the customer's served HTML next to the
 * script tag, which is what these helpers produce.
 *
 * The anchor is deliberately visible (hidden text is a Google policy violation
 * that would penalise the customer's domain) and deliberately `nofollow`
 * (a self-placed, sitewide, identical-anchor link is a named link scheme).
 * The value we want is the brand mention and the referral click, both of which
 * survive nofollow.
 */

/** Where the attribution anchor points, before per-bot tagging. */
const ATTRIBUTION_BASE_URL = 'https://www.oyechats.com/';

/** The anchor's visible text. */
export const ATTRIBUTION_TEXT = 'Powered by OyeChats';

/** Bot keys are public ids like `bot-11a026a4b8b3`. */
const BOT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Inline style keeps the line unobtrusive without depending on host CSS.
 * `color:inherit` is deliberate, not a placeholder: a fixed hex colour
 * reads fine on light backgrounds but can approach invisible on a dark
 * host footer, and an effectively-invisible link is exactly the hidden-text
 * pattern Google's link-spam policy penalises - on the customer's domain,
 * not ours. Inheriting the host's text colour and dimming it with opacity
 * keeps the line visually subordinate while staying genuinely readable on
 * any background. Kept in sync by hand with the JSX style object in
 * `attributionAnchorJsx` - same four properties, CSS syntax here vs. JSX
 * object syntax there.
 */
const ANCHOR_CSS = 'font-size:11px;color:inherit;opacity:0.7;text-decoration:none';

/** Shown for install paths that cannot produce a crawlable anchor. */
export const MANUAL_ATTRIBUTION_NOTE =
  'This install path injects the widget from JavaScript, so anything it adds is invisible to crawlers.';

/** The attribution URL for one bot. */
export function attributionHref(botKey: string): string {
  const url = new URL(ATTRIBUTION_BASE_URL);
  if (BOT_KEY_PATTERN.test(botKey)) {
    url.searchParams.set('ref', botKey);
  }
  url.searchParams.set('utm_source', 'widget');
  url.searchParams.set('utm_medium', 'referral');
  return url.toString();
}

/**
 * SAFETY INVARIANT - this markup is pasted into a customer's HTML unescaped.
 * It is only safe to interpolate because the value here is always
 * `attributionHref(botKey)`, never `botKey` itself: the allowlist regex in
 * `attributionHref` rejects any key containing `"`, `<`, `>`, `&`, a space,
 * or non-ASCII before `ref` is ever set, and `URLSearchParams` percent-encodes
 * the rest. Never interpolate `botKey` directly here or in
 * `attributionAnchorJsx`, and never loosen `BOT_KEY_PATTERN` without
 * re-verifying this holds.
 */
export function attributionAnchorHtml(botKey: string): string {
  return `<a href="${attributionHref(botKey)}" rel="nofollow" style="${ANCHOR_CSS}">${ATTRIBUTION_TEXT}</a>`;
}

/** The attribution anchor as JSX source, for server-rendered React trees. */
export function attributionAnchorJsx(botKey: string): string {
  return `<a
  href="${attributionHref(botKey)}"
  rel="nofollow"
  style={{ fontSize: 11, color: 'inherit', opacity: 0.7, textDecoration: 'none' }}
>
  ${ATTRIBUTION_TEXT}
</a>`;
}
