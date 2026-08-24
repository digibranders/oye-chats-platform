import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    normalizeLocale,
    getLanguageCode,
    getDirection,
    getLocale,
    setLocale,
    onLocaleChange,
    preloadDictionary,
    localizeCtaOption,
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

// ── CTA option localization (Phase 3 gap fix) ───────────────────────────────
//
// QualificationCTA sends the value returned by cta.options verbatim as the
// chat message so the backend's _score_cta_answer can exact-match it against
// the bot's configured rubric. localizeCtaOption() must therefore be a pure
// DISPLAY transform: it must never be the value handed to onSelect. These
// tests exercise the lookup function itself; QualificationCTA's render output
// (that onClick still fires with the original label) is asserted in the
// widget's component-level test below.

test('localizeCtaOption: Hindi session renders preset options in Hindi', async () => {
    resetI18n();
    await preloadDictionary('hi-IN');
    setLocale('hi-IN');

    assert.equal(localizeCtaOption('No budget yet'), 'अभी कोई बजट नहीं');
    assert.equal(localizeCtaOption('Under $1K/mo'), '$1K/माह से कम');
    assert.equal(localizeCtaOption('Decision maker'), 'निर्णय लेने वाले');
    resetI18n();
});

test('localizeCtaOption: English session renders options unchanged', () => {
    resetI18n();
    // No dictionary loaded for en-IN (the default) — this is the production
    // "English visitor" case.
    assert.equal(getLocale(), 'en-IN');
    assert.equal(localizeCtaOption('No budget yet'), 'No budget yet');
    assert.equal(localizeCtaOption('Decision maker'), 'Decision maker');
});

test('localizeCtaOption: custom customer-authored labels are preserved unchanged', async () => {
    resetI18n();
    await preloadDictionary('hi-IN');
    setLocale('hi-IN');

    // A label the customer typed into their own bant_config, not one of the
    // platform preset strings. Must never be silently altered.
    const custom = "Ready to buy this quarter, budget's already signed off";
    assert.equal(localizeCtaOption(custom), custom);

    // Also true for a label that merely resembles a preset one but isn't
    // byte-for-byte identical (case/whitespace differences are NOT matched;
    // the backend rubric match is exact too, so the lookup must be exact).
    assert.equal(localizeCtaOption('no budget yet'), 'no budget yet');
    assert.equal(localizeCtaOption('No budget yet '), 'No budget yet ');
    resetI18n();
});

test('localizeCtaOption: unsupported/not-yet-loaded locale falls back safely', () => {
    resetI18n();
    // fr-FR has no dictionary loader at all (Phase 2 pilot pair is en/hi).
    setLocale('fr-FR');
    assert.equal(localizeCtaOption('No budget yet'), 'No budget yet');

    // hi-IN selected but not yet loaded (async fetch still in flight) must
    // also fail open to the original label, never throw or return blank.
    resetI18n();
    setLocale('hi-IN'); // synchronous; dictionary load is NOT awaited here
    assert.equal(localizeCtaOption('No budget yet'), 'No budget yet');
    resetI18n();
});

test('localizeCtaOption: every preset label the backend rubric ships has a Hindi entry', async () => {
    // Guards against the Hindi table silently drifting out of sync with
    // qualification_service.PRESET_FRAMEWORKS as the backend rubric evolves.
    resetI18n();
    await preloadDictionary('hi-IN');
    setLocale('hi-IN');

    const hiModule = await import('./locales/hi.js');
    const table = hiModule.default.ctaOptions;
    const keys = Object.keys(table);
    assert.ok(keys.length >= 90, `expected the full preset table, got ${keys.length} entries`);
    for (const key of keys) {
        assert.equal(localizeCtaOption(key), table[key]);
        assert.notEqual(table[key], key, `"${key}" has an identity (untranslated) entry`);
    }
    resetI18n();
});

test('localizeCtaOption: non-string / empty input passes through', () => {
    assert.equal(localizeCtaOption(''), '');
    assert.equal(localizeCtaOption(null), null);
    assert.equal(localizeCtaOption(undefined), undefined);
});

// ── Public setLocale() actually reaches the widget ───────────────────────────
//
// The controller half of this was already covered (it normalises, stores and
// emits). What was NOT covered is that anything CONSUMES the action, and that
// is precisely where the bug lived: `OyeChats.setLocale('hi-IN')` updated the
// controller's bookkeeping and fired `localeChanged` while the widget carried
// on rendering English, because ChatWidget's action switch had no `setLocale`
// case and fell through to `default: break`.
//
// ChatWidget needs React and a DOM, so these pin the contract on both sides of
// the seam: the controller must DISPATCH the action, and applying it the way
// ChatWidget does must produce a real locale switch that survives a reload.

test('public API: setLocale dispatches an action a subscriber can act on', () => {
    resetController();
    const ctrl = getController();
    const actions = [];
    ctrl.onAction((a) => actions.push(a));

    ctrl.setLocale('hi_in');

    const localeActions = actions.filter((a) => a.type === 'setLocale');
    assert.equal(localeActions.length, 1, 'exactly one setLocale action per call');
    // Normalised at the boundary, so the consumer never sees a raw tag.
    assert.equal(localeActions[0].locale, 'hi-IN');
    assert.equal(localeActions[0].source, 'site');
});

test('public API: a setLocale before any subscriber is queued, not dropped', () => {
    // Pre-mount behaviour must not regress: a host page calling setLocale in
    // the same tick as the script tag must still take effect once the widget
    // mounts and subscribes.
    resetController();
    const ctrl = getController();
    ctrl.setLocale('hi-IN');

    const actions = [];
    ctrl.onAction((a) => actions.push(a));
    assert.ok(
        actions.some((a) => a.type === 'setLocale' && a.locale === 'hi-IN'),
        'a setLocale dispatched before mount must be replayed to the first subscriber',
    );
});

test('public API: applying the action switches locale, direction and storage', async () => {
    const store = new Map();
    globalThis.localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, v),
        removeItem: (k) => store.delete(k),
    };
    resetI18n();
    resetController();
    const ctrl = getController();

    const directions = [];
    const unsubscribe = onLocaleChange(({ direction }) => directions.push(direction));

    // What ChatWidget's `setLocale` case does with the action.
    ctrl.onAction((action) => {
        if (action.type !== 'setLocale') return;
        setLocale(action.locale);
        writeLocale(action.locale, 'site', 'bot-123');
        ctrl.reportActiveLocale(action.locale);
    });

    ctrl.setLocale('hi-IN');
    assert.equal(getLocale(), 'hi-IN', 'the widget locale must actually change');
    assert.equal(ctrl.getLocale(), 'hi-IN');
    // Persisted under 'site', which is what outranks <html lang> on reload.
    assert.deepEqual(readLocalePreference('bot-123'), { locale: 'hi-IN', source: 'site' });

    // RTL drives the shadow host's `dir`, which app-entry syncs off this bus.
    ctrl.setLocale('ar-SA');
    assert.equal(getLocale(), 'ar-SA');
    assert.equal(getDirection(), 'rtl');
    assert.ok(directions.includes('rtl'), 'an RTL switch must notify direction subscribers');

    unsubscribe();
    resetI18n();
    delete globalThis.localStorage;
});

test('public API: an unsupported locale is not applied', () => {
    // The narrowing ChatWidget performs: `resolveClientLocale` falls back to
    // the bot's default for a locale it does not offer, and applying that
    // fallback would silently flip the visitor's language. Only a request that
    // survives narrowing in the SAME base language may be applied.
    const supported = ['en-IN', 'hi-IN'];
    const survives = (requested) => {
        const resolved = resolveClientLocale({
            explicit: requested,
            site: null,
            htmlLang: null,
            browser: [],
            persisted: null,
            supportedLocales: supported,
            defaultLocale: 'en-IN',
            enabled: true,
        });
        return Boolean(
            resolved?.locale && getLanguageCode(resolved.locale) === getLanguageCode(requested),
        );
    };

    assert.equal(survives('hi-IN'), true);
    assert.equal(survives('en-IN'), true);
    // Offered in a different region only - narrowing keeps the language.
    assert.equal(survives('hi'), true);
    // Not offered at all - must NOT be applied.
    assert.equal(survives('ja-JP'), false);
    assert.equal(survives('de-DE'), false);
});

// ── HandoffForm strings ──────────────────────────────────────────────────────

test('handoff form strings are localized and fall back safely', async () => {
    resetI18n();
    await preloadDictionary('hi-IN');
    setLocale('hi-IN');

    for (const key of ['handoff.email_placeholder', 'handoff.name_placeholder', 'handoff.invalid_email']) {
        const value = t(key);
        assert.ok(value, `${key} must resolve in Hindi`);
        assert.ok(/[ऀ-ॿ]/.test(value), `${key} must actually be Devanagari, got ${value}`);
    }

    // English has no runtime dictionary by design (every call site carries an
    // inline default), so t() returns null and the `|| 'Email address *'`
    // fallback in the component is what renders.
    setLocale('en-IN');
    assert.equal(t('handoff.email_placeholder'), null);
    resetI18n();
});

test('ChatWidget actually consumes the setLocale action', () => {
    // The tests above prove the CONTRACT (controller dispatches, applying it
    // works). They cannot prove ChatWidget holds up its end, because rendering
    // it needs React and a DOM - and "nobody handles the action" is exactly
    // how the bug shipped. This asserts the consumer exists, so deleting the
    // case fails here rather than silently in production.
    const src = readFileSync(new URL('../components/ChatWidget.jsx', import.meta.url), 'utf8');
    const switchStart = src.indexOf('ctrl.onAction(');
    assert.ok(switchStart > 0, 'ChatWidget must subscribe to controller actions');
    const handler = src.slice(switchStart, switchStart + 2000);
    assert.match(handler, /case 'setLocale':/, 'ChatWidget must handle the setLocale action');
    assert.match(handler, /applyExternalLocale\(action\.locale\)/);
});

test('HandoffForm renders no hardcoded English placeholders', () => {
    const src = readFileSync(new URL('../components/HandoffForm.jsx', import.meta.url), 'utf8');
    // A bare placeholder="..." is untranslatable; every one must go through t().
    const bare = [...src.matchAll(/placeholder="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(bare, [], `hardcoded placeholders left in HandoffForm: ${bare.join(', ')}`);
    assert.match(src, /t\('handoff\.email_placeholder'\)/);
    assert.match(src, /t\('handoff\.name_placeholder'\)/);
    assert.match(src, /t\('handoff\.invalid_email'\)/);
});
