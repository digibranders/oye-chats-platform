/**
 * Input sanitization helpers for untrusted values from the settings API.
 *
 * These prevent CSS-injection and data-exfiltration attacks when bot
 * settings (colors, logo URLs) are interpolated into inline styles.
 */

/**
 * The brand colour to paint with until a bot's own colour is known, or when
 * the stored one is not a hex value. Matches `Bot.primary_color`'s default in
 * api/app/db/models.py, so the fallback is the colour a new bot really has.
 */
export const DEFAULT_PRIMARY_COLOR = '#a21caf';

const HEX_COLOR_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Return `color` only if it is a valid hex colour; otherwise return `fallback`.
 */
export const sanitizeColor = (color, fallback = '#2B66BC') => {
    if (typeof color === 'string' && HEX_COLOR_RE.test(color)) return color;
    return fallback;
};

/**
 * Return `url` only if it uses http(s) or a safe data:image/ prefix.
 * Blocks javascript:, data:text/html, and other dangerous schemes.
 */
export const sanitizeImageUrl = (url) => {
    if (!url || typeof url !== 'string') return null;
    if (/^https?:\/\//i.test(url)) return url;
    if (/^data:image\//i.test(url)) return url;
    return null;
};

/**
 * Return `url` only if it uses http(s). For use with file download links
 * and other non-image URLs where data: URIs are not expected.
 */
export const sanitizeFileUrl = (url) => {
    if (!url || typeof url !== 'string') return null;
    if (/^https?:\/\//i.test(url)) return url;
    return null;
};
