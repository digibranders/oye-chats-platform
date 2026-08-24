import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizeLocale,
    getLanguageCode,
    getDirection,
    getLocale,
    setLocale,
    onLocaleChange,
    preloadDictionary,
    t,
    __resetForTests as resetI18n,
} from './i18n.js';

import { NORMALIZATION_FIXTURES, matchSupportedLocale } from './localeCatalog.js';
import { getLocaleDisplay, LOCALE_CATALOG } from './localeNames.js';
import { resolveClientLocale } from './localeResolver.js';

import {
    formatTime,
    formatDate,
    formatHeaderDateTime,
} from './formatters.js';

import {
    getLocaleKey,
    readLocale,
    readLocalePreference,
    writeLocale,
    clearLocale,
} from '../services/storage-keys.js';

import {
    getController,
    __resetForTests as resetController,
} from '../widget-controller.js';

// ── Normalization ───────────────────────────────────────────────────────────

test('i18n: normalizeLocale matches the shared backend fixtures', () => {
    // The same table is asserted by api/tests/services/test_language_service.py.
    // If these two implementations ever diverge, one of the suites fails.
    for (const [input, expected] of NORMALIZATION_FIXTURES) {
        assert.equal(normalizeLocale(input), expected, `normalizeLocale(${JSON.stringify(input)})`);
    }
});

test('i18n: normalizeLocale preserves script subtags', () => {
    // The previous implementation uppercased the second subtag unconditionally
    // and dropped the third, turning zh-Hans-CN into zh-HANS.
    assert.equal(normalizeLocale('zh-Hans-CN'), 'zh-Hans-CN');
    assert.equal(normalizeLocale('zh_hant_tw'), 'zh-Hant-TW');
});

test('i18n: normalizeLocale returns null for unusable input', () => {
    // Null rather than a default: a malformed tag must not masquerade as a real
    // one, and callers apply their own fallback.
    assert.equal(normalizeLocale(null), null);
    assert.equal(normalizeLocale(undefined), null);
    assert.equal(normalizeLocale(42), null);
    assert.equal(normalizeLocale('en--US'), null);
});

test('i18n: getLanguageCode extracts base language', () => {
    assert.equal(getLanguageCode('hi-IN'), 'hi');
    assert.equal(getLanguageCode('zh-Hans-CN'), 'zh');
    assert.equal(getLanguageCode('en'), 'en');
    assert.equal(getLanguageCode('nonsense-input-here'), null);
});

test('i18n: getDirection identifies RTL vs LTR languages', () => {
    for (const rtl of ['ar', 'ar-SA', 'he-IL', 'fa-IR', 'ur-PK']) {
        assert.equal(getDirection(rtl), 'rtl', rtl);
    }
    for (const ltr of ['en-IN', 'hi-IN', 'fr-FR', 'zh-CN']) {
        assert.equal(getDirection(ltr), 'ltr', ltr);
    }
});

// ── Catalog ─────────────────────────────────────────────────────────────────

test('localeCatalog: every catalogued locale has a consistent direction', () => {
    for (const [tag, meta] of Object.entries(LOCALE_CATALOG)) {
        assert.equal(getDirection(tag), meta.direction, tag);
        assert.equal(getLanguageCode(tag), meta.code, tag);
    }
});

test('localeNames: display lookup falls back without throwing', () => {
    assert.equal(getLocaleDisplay('hi-IN').native, 'हिन्दी');
    // Unknown region, known base language.
    assert.equal(getLocaleDisplay('hi-XX').code, 'hi');
    // Entirely unknown tag still returns a renderable shape.
    assert.ok(getLocaleDisplay('qq-ZZ').native);
});

// ── Translation lookup ──────────────────────────────────────────────────────

test('i18n: t() returns null for missing keys so inline fallbacks render', async (tCtx) => {
    tCtx.after(() => resetI18n());
    resetI18n();

    // No dictionary is loaded for English: the inline default at the call site
    // is the English copy. t() must report "missing" rather than echoing the
    // key, which previously rendered "header.close" to visitors.
    assert.equal(t('header.close'), null);
    assert.equal(t('does.not.exist'), null);
    assert.equal(t(''), null);
    assert.equal(t(null), null);

    // The `t('x') || 'Fallback'` idiom used across the components must work.
    assert.equal(t('header.close') || 'Close', 'Close');
});

test('i18n: t() resolves and interpolates once a dictionary is loaded', async (tCtx) => {
    tCtx.after(() => resetI18n());
    resetI18n();

    await preloadDictionary('hi-IN');
    setLocale('hi-IN');

    assert.equal(getLocale(), 'hi-IN');
    assert.equal(typeof t('header.close'), 'string');
    assert.ok(t('header.close').length > 0);

    const interpolated = t('system.operator_joined', { name: 'Sarah' });
    assert.ok(interpolated.includes('Sarah'), interpolated);
});

test('i18n: onLocaleChange notifies subscribers and unsubscribes cleanly', () => {
    resetI18n();
    const events = [];
    const unsubscribe = onLocaleChange((payload) => events.push(payload));

    setLocale('ar-SA');
    assert.equal(events.length, 1);
    assert.equal(events[0].locale, 'ar-SA');
    assert.equal(events[0].direction, 'rtl');

    unsubscribe();
    setLocale('en-IN');
    assert.equal(events.length, 1, 'no further events after unsubscribe');
    resetI18n();
});

// ── Resolver ────────────────────────────────────────────────────────────────

test('localeResolver: matchSupportedLocale narrows to the supported variant', () => {
    const supported = ['en-IN', 'hi-IN', 'fr-FR'];
    assert.equal(matchSupportedLocale('en-in', supported), 'en-IN');
    assert.equal(matchSupportedLocale('hi_IN', supported), 'hi-IN');
    assert.equal(matchSupportedLocale('hi', supported), 'hi-IN');
    // Regional variant narrows to the one the bot actually offers.
    assert.equal(matchSupportedLocale('fr-CA', supported), 'fr-FR');
    assert.equal(matchSupportedLocale('de-DE', supported), null);
    assert.equal(matchSupportedLocale(null, supported), null);
});

test('localeResolver: follows strict precedence', () => {
    const supported = ['en-IN', 'hi-IN', 'fr-FR', 'es-ES'];

    let res = resolveClientLocale({
        explicit: 'hi-IN', site: 'fr-FR', htmlLang: 'es-ES', browser: 'en-IN',
        persisted: 'fr-FR', supportedLocales: supported,
    });
    assert.equal(res.locale, 'hi-IN');
    assert.equal(res.source, 'explicit');
    assert.equal(res.locked, true);

    res = resolveClientLocale({
        site: 'fr-FR', htmlLang: 'es-ES', browser: 'en-IN', persisted: 'es-ES',
        supportedLocales: supported,
    });
    assert.equal(res.source, 'site');

    res = resolveClientLocale({
        htmlLang: 'es-ES', browser: 'en-IN', persisted: 'hi-IN', supportedLocales: supported,
    });
    assert.equal(res.source, 'html_lang');

    res = resolveClientLocale({
        browser: 'hi-IN', persisted: 'fr-FR', supportedLocales: supported,
    });
    assert.equal(res.source, 'browser');

    // htmlLang/browser are passed explicitly as empty here: omitting them now
    // makes the resolver read the real environment, which is the whole point of
    // the C1 fix and would otherwise leak into this assertion.
    res = resolveClientLocale({
        htmlLang: null, browser: [], persisted: 'fr-FR', supportedLocales: supported,
    });
    assert.equal(res.source, 'persisted');

    res = resolveClientLocale({
        htmlLang: null, browser: [], defaultLocale: 'en-IN', supportedLocales: supported,
    });
    assert.equal(res.locale, 'en-IN');
    assert.equal(res.source, 'default');

    res = resolveClientLocale({ explicit: 'hi-IN', defaultLocale: 'en-IN', enabled: false });
    assert.equal(res.locale, 'en-IN');
    assert.equal(res.source, 'default');
});

test('localeResolver: an unsupported candidate falls through to the next tier', () => {
    const res = resolveClientLocale({
        htmlLang: 'de-DE',          // not offered by this bot
        browser: 'hi-IN',
        supportedLocales: ['en-IN', 'hi-IN'],
        defaultLocale: 'en-IN',
    });
    assert.equal(res.locale, 'hi-IN');
    assert.equal(res.source, 'browser');
});

test('localeResolver: browser tier honours the ordered language list', () => {
    // navigator.languages is preference-ordered. The visitor accepts Hindi even
    // though English is listed first, and this bot only offers Hindi.
    const res = resolveClientLocale({
        browser: ['en-US', 'en', 'hi-IN'],
        supportedLocales: ['hi-IN'],
        defaultLocale: 'hi-IN',
    });
    assert.equal(res.locale, 'hi-IN');
    assert.equal(res.source, 'browser');
});

test('localeResolver: regional browser locale narrows to the supported variant', () => {
    const res = resolveClientLocale({
        browser: ['fr-CA'],
        supportedLocales: ['en-IN', 'fr-FR'],
        defaultLocale: 'en-IN',
    });
    assert.equal(res.locale, 'fr-FR');
});

// ── Production call-shape regression (C1) ───────────────────────────────────
//
// The precedence test above passes htmlLang/browser explicitly, which is NOT
// how ChatWidget calls the resolver. That gap is exactly how a resolver whose
// html_lang and browser tiers could never fire in production shipped green.
// These tests reproduce the real call shape.

const productionResolve = ({ htmlLang, browserLanguages, stored, siteLocale, langCfg }) => {
    // Mirrors ChatWidget.jsx: environment readers supply the tiers.
    const storedExplicit = stored?.source === 'explicit' ? stored.locale : null;
    return resolveClientLocale({
        explicit: storedExplicit,
        site: siteLocale || null,
        htmlLang: htmlLang ?? null,
        browser: browserLanguages ?? [],
        persisted: storedExplicit ? null : stored?.locale || null,
        supportedLocales: langCfg.supported_locales,
        defaultLocale: langCfg.default_locale || 'en-IN',
        enabled: langCfg.enabled === true,
    });
};

const LANG_CFG = {
    enabled: true,
    default_locale: 'en-IN',
    supported_locales: ['en-IN', 'hi-IN'],
};

test('C1: html lang is honoured through the production call shape', () => {
    const res = productionResolve({
        htmlLang: 'hi-IN', browserLanguages: ['en-US'], stored: null, langCfg: LANG_CFG,
    });
    assert.equal(res.locale, 'hi-IN');
    assert.equal(res.source, 'html_lang');
});

test('C1: browser language is honoured through the production call shape', () => {
    const res = productionResolve({
        htmlLang: null, browserLanguages: ['hi-IN', 'en-US'], stored: null, langCfg: LANG_CFG,
    });
    assert.equal(res.locale, 'hi-IN');
    assert.equal(res.source, 'browser');
});

test('C1: site locale outranks html lang and browser', () => {
    const res = productionResolve({
        htmlLang: 'en-IN', browserLanguages: ['en-US'], siteLocale: 'hi-IN',
        stored: null, langCfg: LANG_CFG,
    });
    assert.equal(res.locale, 'hi-IN');
    assert.equal(res.source, 'site');
});

test('C1: a disabled bot always resolves to its default', () => {
    const res = productionResolve({
        htmlLang: 'hi-IN', browserLanguages: ['hi-IN'], stored: null,
        langCfg: { default_locale: 'en-IN', supported_locales: ['en-IN', 'hi-IN'] },
    });
    assert.equal(res.locale, 'en-IN');
    assert.equal(res.source, 'default');
});

test('H5: a persisted explicit choice outranks html lang and browser', () => {
    // The visitor chose Hindi on a previous visit. An English host page and an
    // English browser must not silently override that.
    const res = productionResolve({
        htmlLang: 'en-IN',
        browserLanguages: ['en-US'],
        stored: { locale: 'hi-IN', source: 'explicit' },
        langCfg: LANG_CFG,
    });
    assert.equal(res.locale, 'hi-IN');
    assert.equal(res.source, 'explicit');
    assert.equal(res.locked, true);
});

test('H5: a persisted auto-resolved value does NOT outrank html lang', () => {
    const res = productionResolve({
        htmlLang: 'en-IN',
        browserLanguages: [],
        stored: { locale: 'hi-IN', source: 'browser' },
        langCfg: LANG_CFG,
    });
    assert.equal(res.locale, 'en-IN');
    assert.equal(res.source, 'html_lang');
});

// ── Formatters ──────────────────────────────────────────────────────────────

test('formatters: format according to locale', () => {
    const testDate = new Date('2026-08-22T12:30:00Z');
    assert.ok(formatTime(testDate, 'en-IN'));
    assert.ok(formatDate(testDate, 'en-IN'));
    assert.ok(formatHeaderDateTime(testDate, 'en-IN').includes('·'));
    assert.equal(formatTime(null), '');
    assert.equal(formatDate('not a date'), '');
});

// ── Persistence ─────────────────────────────────────────────────────────────

test('storage-keys: locale preference records both value and source', () => {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
    };

    assert.ok(getLocaleKey('bot-123').startsWith('oyechats_locale_'));

    writeLocale('hi-IN', 'explicit', 'bot-123');
    assert.deepEqual(readLocalePreference('bot-123'), { locale: 'hi-IN', source: 'explicit' });
    assert.equal(readLocale('bot-123'), 'hi-IN');

    writeLocale('fr-FR', 'browser', 'bot-123');
    assert.deepEqual(readLocalePreference('bot-123'), { locale: 'fr-FR', source: 'browser' });

    clearLocale('bot-123');
    assert.equal(readLocalePreference('bot-123'), null);
    assert.equal(readLocale('bot-123'), null);

    // A value written by an earlier build was a bare string. It must still read
    // back, and must be treated as auto-resolved rather than explicit.
    store.set(getLocaleKey('bot-legacy'), 'hi-IN');
    assert.deepEqual(readLocalePreference('bot-legacy'), { locale: 'hi-IN', source: null });

    delete globalThis.localStorage;
});

// ── Public API ──────────────────────────────────────────────────────────────

test('widget-controller: setLocale updates state and emits one canonical event', () => {
    resetController();
    const ctrl = getController();
    const events = [];
    ctrl.on('localeChanged', (p) => events.push(p));

    ctrl.setLocale('hi-IN');
    assert.equal(ctrl.getLocale(), 'hi-IN');
    assert.equal(events.length, 1);
    assert.equal(events[0].locale, 'hi-IN');
    assert.equal(events[0].language, 'hi');
    assert.equal(events[0].direction, 'ltr');
    assert.equal(events[0].source, 'site');

    // Normalization happens at the boundary.
    ctrl.setLocale('ar_sa');
    assert.equal(ctrl.getLocale(), 'ar-SA');
    assert.equal(events[1].direction, 'rtl');

    // Junk is rejected rather than stored.
    ctrl.setLocale('!!!');
    assert.equal(ctrl.getLocale(), 'ar-SA');
    assert.equal(events.length, 2);

    // The React layer reports what it actually rendered.
    ctrl.reportActiveLocale('hi-IN');
    assert.equal(ctrl.getLocale(), 'hi-IN');

    resetController();
});
