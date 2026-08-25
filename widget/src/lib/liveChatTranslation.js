/**
 * Picking what a visitor should see for a live-chat message.
 *
 * WHY THIS EXISTS AS A MODULE
 * ---------------------------
 * The widget rebuilds its live-chat thread from `GET /chat/history` on every
 * `status: connected` frame, not just the first: a network blip, a tab wake, a
 * reconnect after the operator's worker restarted. That restore path appends
 * any row newer than the last message already in memory.
 *
 * Operator replies are persisted in the operator's own language (that is the
 * canonical original, and it is never rewritten). The visitor was shown the
 * translation live. So if the restore path rendered `content`, a Hindi visitor
 * who lost their connection for three seconds would watch their conversation
 * turn into English halfway down, with no explanation. Reading the persisted
 * translation instead is what keeps the thread in one language.
 *
 * It lives in `src/lib/` rather than inline in the component because that is
 * where the widget's test runner looks (`node --test src/lib/*.test.js`).
 */

/**
 * Choose the text to render for one persisted history row.
 *
 * @param {{content?: string, translations?: Record<string, {content?: string, status?: string}>}} message
 * @param {string|null|undefined} sessionLanguage - the visitor's language, e.g. 'hi' or 'hi-IN'
 * @returns {string} the translated text when a usable one exists, else the original
 */
export function displayTextFor(message, sessionLanguage) {
    const original = typeof message?.content === 'string' ? message.content : '';
    const lang = baseLanguage(sessionLanguage);
    if (!lang) return original;

    const entry = message?.translations?.[lang];
    // `status: 'failed'` rows exist on purpose: they record that we tried and
    // the provider was down, which stops a pointless retry. They carry no
    // content, so they fall through to the original exactly like a missing key.
    if (!entry || entry.status !== 'ok') return original;
    return typeof entry.content === 'string' && entry.content ? entry.content : original;
}

/**
 * Base language code from a locale tag: `hi-IN` -> `hi`.
 *
 * @param {string|null|undefined} locale
 * @returns {string|null}
 */
export function baseLanguage(locale) {
    if (!locale || typeof locale !== 'string') return null;
    const trimmed = locale.trim();
    if (!trimmed) return null;
    return trimmed.split(/[-_]/)[0].toLowerCase() || null;
}

/** Languages that render right-to-left. Mirrors `RTL_LANGUAGES` on the server. */
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur']);

/**
 * Text direction for a locale or bare language code.
 *
 * @param {string|null|undefined} locale
 * @returns {'ltr'|'rtl'}
 */
export function directionFor(locale) {
    const lang = baseLanguage(locale);
    return lang && RTL_LANGUAGES.has(lang) ? 'rtl' : 'ltr';
}
