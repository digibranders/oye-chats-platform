import {
    DEFAULT_LOCALE,
    getDirection,
    getLanguageCode,
    matchSupportedLocale,
    normalizeLocale,
} from './localeCatalog.js';

export { matchSupportedLocale };

/** Read the host document's <html lang="..."> tag. Null when unavailable. */
export function getHtmlLang() {
    if (typeof document === 'undefined' || !document.documentElement) return null;
    return document.documentElement.lang || null;
}

/**
 * The visitor's preferred UI language.
 *
 * `navigator.languages` is ordered by preference and is what we want first;
 * `navigator.language` is the single-value fallback for older browsers.
 */
export function getBrowserLanguages() {
    if (typeof navigator === 'undefined') return [];
    const list = Array.isArray(navigator.languages) ? navigator.languages.filter(Boolean) : [];
    if (list.length > 0) return list;
    return navigator.language ? [navigator.language] : [];
}

/**
 * Resolve the initial conversation locale.
 *
 * Precedence (highest first):
 *   1. explicit    - the visitor picked a language, now or in a past visit
 *   2. site        - the host page supplied one via OyeChats.init/update/setLocale
 *   3. html_lang   - the host page's <html lang>
 *   4. browser     - navigator.languages
 *   5. persisted   - a previously auto-resolved preference
 *   6. default     - the bot's default locale
 *
 * `htmlLang` and `browser` are read from the environment when the caller does
 * not supply them. They previously defaulted to null and were guarded with
 * `!== undefined`, which meant the environment was never consulted and tiers 3
 * and 4 could not fire in production at all.
 *
 * Each tier may be a single value or an ordered list (browser languages are a
 * list). The first entry that matches a supported locale wins.
 */
export function resolveClientLocale({
    explicit,
    site,
    htmlLang,
    browser,
    persisted,
    supportedLocales,
    defaultLocale = DEFAULT_LOCALE,
    enabled = true,
} = {}) {
    const fallbackLocale = normalizeLocale(defaultLocale) || DEFAULT_LOCALE;

    if (!enabled) {
        return {
            locale: fallbackLocale,
            language: getLanguageCode(fallbackLocale),
            direction: getDirection(fallbackLocale),
            source: 'default',
            locked: false,
        };
    }

    const effectiveHtmlLang = htmlLang === undefined ? getHtmlLang() : htmlLang;
    const effectiveBrowser = browser === undefined ? getBrowserLanguages() : browser;

    const supported =
        supportedLocales && supportedLocales.length > 0 ? supportedLocales : [fallbackLocale];

    const tiers = [
        ['explicit', explicit],
        ['site', site],
        ['html_lang', effectiveHtmlLang],
        ['browser', effectiveBrowser],
        ['persisted', persisted],
    ];

    for (const [source, value] of tiers) {
        const candidates = Array.isArray(value) ? value : [value];
        for (const candidate of candidates) {
            if (!candidate) continue;
            const matched = matchSupportedLocale(candidate, supported);
            if (matched) {
                return {
                    locale: matched,
                    language: getLanguageCode(matched),
                    direction: getDirection(matched),
                    source,
                    locked: source === 'explicit',
                };
            }
        }
    }

    const matchedDefault = matchSupportedLocale(fallbackLocale, supported) || fallbackLocale;
    return {
        locale: matchedDefault,
        language: getLanguageCode(matchedDefault),
        direction: getDirection(matchedDefault),
        source: 'default',
        locked: false,
    };
}
