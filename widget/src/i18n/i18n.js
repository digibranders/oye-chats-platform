// Runtime translation store.
//
// Bundling contract: NO dictionary is imported statically, and English is not
// loaded at runtime at all. Every t() call site passes an inline English
// default (`t('header.close') || 'Close'`), so English is already present in
// the component that renders it. Loading locales/en.js on top of that would
// ship the same strings twice, on every page view, to every visitor including
// those on bots that never enabled multilingual.
//
// locales/en.js remains the canonical English source: it is what translators
// work from and what the key-parity test asserts other dictionaries against.
// It is simply not part of the runtime fallback chain.
//
// Non-English dictionaries are fetched with a dynamic import() the first time
// their locale is selected. Do NOT add static dictionary imports here.

import {
    DEFAULT_LOCALE,
    getDirection as directionForLocale,
    getLanguageCode,
    normalizeLocale,
} from './localeCatalog.js';

/** Dynamic loaders, keyed by base language. English needs no entry. */
const DICTIONARY_LOADERS = {
    hi: () => import('./locales/hi.js'),
};

/** Dictionaries currently in memory, keyed by base language. */
const _dictionaries = {};

let _currentLocale = DEFAULT_LOCALE;
const _listeners = new Set();

export { getLanguageCode, normalizeLocale };

export function getDirection(locale = _currentLocale) {
    return directionForLocale(locale);
}

export function getLocale() {
    return _currentLocale;
}

function notify() {
    const payload = { locale: _currentLocale, direction: getDirection(_currentLocale) };
    for (const listener of _listeners) {
        try {
            listener(payload);
        } catch (e) {
            console.error('[OyeChats] i18n listener error:', e);
        }
    }
}

/**
 * Load the dictionary for a locale if it is not already resident.
 * Resolves to true when a dictionary arrived that was not there before, so the
 * caller knows whether a re-render is warranted.
 */
async function ensureDictionary(locale) {
    const lang = getLanguageCode(locale);
    if (!lang || _dictionaries[lang]) return false;

    const loader = DICTIONARY_LOADERS[lang];
    if (!loader) return false;

    try {
        const mod = await loader();
        _dictionaries[lang] = mod.default || mod;
        return true;
    } catch (e) {
        // A failed chunk fetch must not break the widget: t() keeps serving
        // English until the next attempt.
        console.warn('[OyeChats] Failed to load dictionary for', lang, e);
        return false;
    }
}

/**
 * Set the active locale. Applies synchronously so direction and formatting
 * update immediately, then notifies again once a lazily-loaded dictionary
 * arrives so subscribed components re-render with the real strings.
 */
export function setLocale(newLocale) {
    const norm = normalizeLocale(newLocale);
    if (!norm || norm === _currentLocale) return;

    _currentLocale = norm;
    notify();

    ensureDictionary(norm).then((didLoad) => {
        // Guard against a stale load resolving after another switch.
        if (didLoad && _currentLocale === norm) notify();
    });
}

/** Preload a dictionary without switching to it (used to avoid a flash). */
export function preloadDictionary(locale) {
    return ensureDictionary(locale);
}

export function onLocaleChange(listener) {
    _listeners.add(listener);
    return () => _listeners.delete(listener);
}

function dictionaryFor(locale) {
    const lang = getLanguageCode(locale);
    return (lang && _dictionaries[lang]) || null;
}

function resolveKey(dict, keyPath) {
    const parts = keyPath.split('.');
    let curr = dict?.messages;
    for (const part of parts) {
        if (!curr || typeof curr !== 'object') return null;
        curr = curr[part];
    }
    return typeof curr === 'string' ? curr : null;
}

/**
 * Look up a translated string by dotted key path, with {param} interpolation.
 *
 * Returns null when no dictionary is loaded or the key is missing from it. That
 * is deliberate: it makes the `t('a.b') || 'Fallback'` idiom used across the
 * components actually work, so the caller's inline English default renders.
 * Returning the key itself (the previous behaviour) put raw strings like
 * "header.close" in front of visitors and made every `|| 'Fallback'` dead code.
 */
export function t(key, params = {}) {
    if (!key || typeof key !== 'string') return null;

    const dict = dictionaryFor(_currentLocale);
    const template = dict ? resolveKey(dict, key) : null;
    if (template === null || template === undefined) return null;

    let out = template;
    if (params && typeof params === 'object') {
        for (const [paramKey, paramVal] of Object.entries(params)) {
            out = out.replaceAll(`{${paramKey}}`, String(paramVal ?? ''));
        }
    }
    return out;
}

export const __resetForTests = () => {
    _currentLocale = DEFAULT_LOCALE;
    _listeners.clear();
    for (const lang of Object.keys(_dictionaries)) delete _dictionaries[lang];
};
