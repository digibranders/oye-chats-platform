// Single authoritative locale registry for the widget.
//
// This is the ONE place locale rules live on the client. The language selector,
// the direction logic, and the dictionary loader all read from here (or from
// its companion localeNames.js), so they cannot drift apart (they previously
// kept three separate lists).
//
// It mirrors `api/app/services/language_service.py` (KNOWN_LOCALES /
// RTL_LANGUAGES) and the normalization rules in `normalize_locale` there.
// `src/i18n/i18n.test.js` and `api/tests/services/test_language_service.py`
// share the NORMALIZATION_FIXTURES cases below so the two implementations are
// verified against identical input on both sides.
//
// Deliberately dictionary-free: `widget-controller.js` is bundled in the eager
// vendor chunk and imports this module, so pulling a dictionary in here would
// ship every translation to visitors who never open the chat.

/** Base language codes that render right-to-left. */
export const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);

/** The locale used when nothing else resolves. */
export const DEFAULT_LOCALE = 'en-IN';

const LOCALE_SPLIT = /[-_]/;

/**
 * Normalize a locale tag to canonical BCP-47 form, or return null if the input
 * is not a usable tag.
 *
 * Ported from `normalize_locale` in api/app/services/language_service.py so the
 * two sides agree byte for byte. Returning null (rather than a default) is part
 * of that contract: callers apply their own fallback, which keeps a malformed
 * tag from silently masquerading as a real one.
 *
 *   'en_US'        -> 'en-US'
 *   'HI-in'        -> 'hi-IN'
 *   'zh_hans_cn'   -> 'zh-Hans-CN'   (script subtag preserved)
 *   'en-US.UTF-8'  -> 'en-US'
 *   'en-US,en;q=0' -> 'en-US'
 *   'xx-YY-ZZ-WW'  -> null
 */
export function normalizeLocale(value) {
    if (!value || typeof value !== 'string') return null;

    let cleaned = value.trim();
    if (!cleaned) return null;

    // Strip POSIX character encodings, e.g. 'en_US.UTF-8'.
    if (cleaned.includes('.')) cleaned = cleaned.split('.')[0];
    // Strip Accept-Language style lists and quality values.
    if (cleaned.includes(',')) cleaned = cleaned.split(',')[0].trim();
    if (cleaned.includes(';')) cleaned = cleaned.split(';')[0].trim();
    if (!cleaned) return null;

    const parts = cleaned.split(LOCALE_SPLIT);
    if (parts.length === 0 || parts.length > 3 || parts.some((p) => !p)) return null;

    const lang = parts[0].toLowerCase();
    if (!/^[a-z]{2,3}$/.test(lang)) return null;
    if (parts.length === 1) return lang;

    const out = [lang];
    let remaining = parts.slice(1);

    // Script subtag: exactly 4 alpha characters, title-cased (e.g. 'Hans').
    if (remaining.length > 0 && /^[a-zA-Z]{4}$/.test(remaining[0])) {
        const script = remaining[0];
        out.push(script[0].toUpperCase() + script.slice(1).toLowerCase());
        remaining = remaining.slice(1);
    }

    // Region subtag: 2 alpha (uppercased) or 3 digits (UN M.49).
    if (remaining.length > 0) {
        const region = remaining[0];
        if (/^[a-zA-Z]{2}$/.test(region)) {
            out.push(region.toUpperCase());
        } else if (/^[0-9]{3}$/.test(region)) {
            out.push(region);
        } else {
            return null;
        }
        remaining = remaining.slice(1);
    }

    if (remaining.length > 0) return null;
    return out.join('-');
}

/** Base language code for a locale tag ('hi-IN' -> 'hi'), or null. */
export function getLanguageCode(locale) {
    const norm = normalizeLocale(locale);
    if (!norm) return null;
    return norm.split('-')[0];
}

/** Text direction for a locale. Unknown locales default to 'ltr'. */
export function getDirection(locale) {
    const lang = getLanguageCode(locale);
    return lang && RTL_LANGUAGES.has(lang) ? 'rtl' : 'ltr';
}

/**
 * Best supported locale for a candidate: exact tag first, then base language.
 * Returns null when neither matches, so callers can fall through to the next
 * precedence tier rather than guessing.
 *
 *   matchSupportedLocale('fr-CA', ['fr-FR']) -> 'fr-FR'
 */
export function matchSupportedLocale(candidate, supportedList = []) {
    const norm = normalizeLocale(candidate);
    if (!norm || !supportedList || supportedList.length === 0) return null;

    const supported = supportedList.map((s) => normalizeLocale(s)).filter(Boolean);

    for (const sup of supported) {
        if (norm === sup) return sup;
    }

    const lang = getLanguageCode(norm);
    for (const sup of supported) {
        if (lang && lang === getLanguageCode(sup)) return sup;
    }

    return null;
}

/**
 * Shared normalization cases, asserted by BOTH the widget test suite and the
 * backend's test_language_service.py. Keep the two lists identical: they are
 * the contract that stops the client and server parsers from diverging.
 */
export const NORMALIZATION_FIXTURES = [
    ['en_US', 'en-US'],
    ['HI-in', 'hi-IN'],
    ['fr-ca', 'fr-CA'],
    ['zh_cn', 'zh-CN'],
    ['zh-hans-cn', 'zh-Hans-CN'],
    ['en', 'en'],
    ['en-US.UTF-8', 'en-US'],
    ['en-US,en;q=0.9', 'en-US'],
    ['es-419', 'es-419'],
    ['', null],
    ['   ', null],
    ['x', null],
    ['toolongcode', null],
    ['en-US-extra-parts', null],
];
