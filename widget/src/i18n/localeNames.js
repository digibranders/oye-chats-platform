// Human-readable locale names for the language selector.
//
// Split out of localeCatalog.js on purpose: the catalog's pure functions are
// imported by widget-controller.js and therefore land in the eager vendor
// chunk, whereas these display strings are only ever rendered by the lazily
// loaded LanguageSelector. Keeping them here means visitors who never open the
// language menu do not download them.

import { getDirection, getLanguageCode, normalizeLocale } from './localeCatalog.js';

/**
 * Locale metadata, keyed by canonical BCP-47 tag.
 * `name` is the English display name, `native` the endonym shown to visitors.
 */
export const LOCALE_CATALOG = {
    'en-IN': { code: 'en', name: 'English (India)', native: 'English (India)', direction: 'ltr' },
    'en-US': { code: 'en', name: 'English (United States)', native: 'English (US)', direction: 'ltr' },
    'en-GB': { code: 'en', name: 'English (United Kingdom)', native: 'English (UK)', direction: 'ltr' },
    'hi-IN': { code: 'hi', name: 'Hindi (India)', native: 'हिन्दी', direction: 'ltr' },
    'es-ES': { code: 'es', name: 'Spanish (Spain)', native: 'Español (España)', direction: 'ltr' },
    'es-MX': { code: 'es', name: 'Spanish (Mexico)', native: 'Español (México)', direction: 'ltr' },
    'fr-FR': { code: 'fr', name: 'French (France)', native: 'Français (France)', direction: 'ltr' },
    'fr-CA': { code: 'fr', name: 'French (Canada)', native: 'Français (Canada)', direction: 'ltr' },
    'de-DE': { code: 'de', name: 'German (Germany)', native: 'Deutsch', direction: 'ltr' },
    'pt-BR': { code: 'pt', name: 'Portuguese (Brazil)', native: 'Português (Brasil)', direction: 'ltr' },
    'pt-PT': { code: 'pt', name: 'Portuguese (Portugal)', native: 'Português (Portugal)', direction: 'ltr' },
    'it-IT': { code: 'it', name: 'Italian (Italy)', native: 'Italiano', direction: 'ltr' },
    'nl-NL': { code: 'nl', name: 'Dutch (Netherlands)', native: 'Nederlands', direction: 'ltr' },
    'ja-JP': { code: 'ja', name: 'Japanese (Japan)', native: '日本語', direction: 'ltr' },
    'ko-KR': { code: 'ko', name: 'Korean (South Korea)', native: '한국어', direction: 'ltr' },
    'zh-CN': { code: 'zh', name: 'Chinese (Simplified)', native: '简体中文', direction: 'ltr' },
    'zh-TW': { code: 'zh', name: 'Chinese (Traditional)', native: '繁體中文', direction: 'ltr' },
    'ar-SA': { code: 'ar', name: 'Arabic (Saudi Arabia)', native: 'العربية', direction: 'rtl' },
    'ar-AE': { code: 'ar', name: 'Arabic (UAE)', native: 'العربية (الإمارات)', direction: 'rtl' },
    'tr-TR': { code: 'tr', name: 'Turkish (Turkey)', native: 'Türkçe', direction: 'ltr' },
    'id-ID': { code: 'id', name: 'Indonesian (Indonesia)', native: 'Bahasa Indonesia', direction: 'ltr' },
    'vi-VN': { code: 'vi', name: 'Vietnamese (Vietnam)', native: 'Tiếng Việt', direction: 'ltr' },
    'th-TH': { code: 'th', name: 'Thai (Thailand)', native: 'ไทย', direction: 'ltr' },
    'pl-PL': { code: 'pl', name: 'Polish (Poland)', native: 'Polski', direction: 'ltr' },
    'ru-RU': { code: 'ru', name: 'Russian (Russia)', native: 'Русский', direction: 'ltr' },
    'uk-UA': { code: 'uk', name: 'Ukrainian (Ukraine)', native: 'Українська', direction: 'ltr' },
    'he-IL': { code: 'he', name: 'Hebrew (Israel)', native: 'עברית', direction: 'rtl' },
    'fa-IR': { code: 'fa', name: 'Persian (Iran)', native: 'فارسی', direction: 'rtl' },
    'ur-PK': { code: 'ur', name: 'Urdu (Pakistan)', native: 'اردو', direction: 'rtl' },
};

/**
 * Display names for the language selector. Falls back to the base language
 * entry, then to the raw tag, so an unrecognised locale still renders.
 */
export function getLocaleDisplay(locale) {
    const norm = normalizeLocale(locale) || locale;
    if (LOCALE_CATALOG[norm]) return LOCALE_CATALOG[norm];

    const lang = getLanguageCode(norm);
    if (lang) {
        const entry = Object.entries(LOCALE_CATALOG).find(([, meta]) => meta.code === lang);
        if (entry) return entry[1];
    }
    return { code: lang || 'en', name: norm, native: norm, direction: getDirection(norm) };
}
