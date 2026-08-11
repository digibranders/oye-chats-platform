/**
 * brandingLink - resolves the widget footer badge's href and label.
 *
 * Two jobs the component must not do inline:
 *
 *  1. Attribution. Links to our own site get `?ref=<bot_key>` plus UTMs so the
 *     badge becomes a measurable acquisition channel instead of untagged direct
 *     traffic. A white-label `branding_url` pointing anywhere else is returned
 *     verbatim - stamping our tracking onto a customer's own link would be wrong.
 *  2. Safety. `branding_url` is customer-editable, so anything unparseable or
 *     non-http (`javascript:` above all) falls back to the default rather than
 *     reaching an anchor's href.
 */

export const DEFAULT_BRANDING_TEXT = 'Powered by OyeChats';
export const DEFAULT_BRANDING_URL = 'https://www.oyechats.com';

/** Hosts we own, and therefore may append our own tracking params to. */
const OYECHATS_HOSTS = new Set(['oyechats.com', 'www.oyechats.com']);

/** Bot keys are public ids like `bot-11a026a4b8b3`; anything else is not ours. */
const BOT_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Longest label we render before the single-line footer starts to break. */
const MAX_BRANDING_TEXT_LENGTH = 60;

/**
 * Build the badge href.
 *
 * @param {string | null | undefined} brandingUrl - `settings.branding_url`.
 * @param {string | null | undefined} botKey - `window.OYECHATS_BOT_KEY`.
 * @returns {string} An absolute http(s) URL, always safe to place in an href.
 */
export function buildBrandingHref(brandingUrl, botKey) {
    const raw =
        typeof brandingUrl === 'string' && brandingUrl.trim()
            ? brandingUrl.trim()
            : DEFAULT_BRANDING_URL;

    let url;
    try {
        url = new URL(raw);
    } catch {
        url = new URL(DEFAULT_BRANDING_URL);
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        url = new URL(DEFAULT_BRANDING_URL);
    }

    // White-label destination - hand it back exactly as the customer set it.
    if (!OYECHATS_HOSTS.has(url.hostname.toLowerCase())) {
        return url.toString();
    }

    if (typeof botKey === 'string' && BOT_KEY_PATTERN.test(botKey)) {
        url.searchParams.set('ref', botKey);
    }
    url.searchParams.set('utm_source', 'widget');
    url.searchParams.set('utm_medium', 'referral');
    return url.toString();
}

/**
 * Normalise the badge label: trim, fall back to the default, and cap the length
 * so a long custom string can't blow out the footer's single-line grid.
 *
 * @param {string | null | undefined} brandingText - `settings.branding_text`.
 * @returns {string}
 */
export function resolveBrandingText(brandingText) {
    const trimmed = typeof brandingText === 'string' ? brandingText.trim() : '';
    if (!trimmed) return DEFAULT_BRANDING_TEXT;
    return trimmed.slice(0, MAX_BRANDING_TEXT_LENGTH);
}

/**
 * Split the label into a muted lead and a coloured trailing brand word, so
 * "Powered by Acme" gets the same two-tone treatment "Powered by OyeChats" has
 * always had, without the component hardcoding either.
 *
 * @param {string} text
 * @returns {{ lead: string, brand: string }}
 */
export function splitBrandingText(text) {
    const cleaned = String(text ?? '').trim();
    const lastSpace = cleaned.lastIndexOf(' ');
    if (lastSpace === -1) return { lead: '', brand: cleaned };
    return {
        lead: cleaned.slice(0, lastSpace).trim(),
        brand: cleaned.slice(lastSpace + 1),
    };
}
