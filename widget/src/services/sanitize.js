/**
 * Input sanitization helpers for untrusted values from the settings API.
 *
 * These prevent CSS-injection and data-exfiltration attacks when bot
 * settings (colors, logo URLs) are interpolated into inline styles.
 */

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
