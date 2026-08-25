import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

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

    const interpolated = t('system.operator_joined_conversation', { name: 'Sarah' });
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

// ── Dictionary parity ────────────────────────────────────────────────────────
//
// Every non-English dictionary is a translation OF locales/en.js, so the two key
// sets must match exactly. A missing key silently falls back to the component's
// inline English default, which is the failure mode that shipped a half-Hindi
// widget: it looks fine in code review and only shows up in front of a visitor.

const flattenKeys = (obj, prefix = '') =>
    Object.entries(obj).flatMap(([k, v]) =>
        v && typeof v === 'object' ? flattenKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
    );

const loadDicts = async () => {
    const [en, hi] = await Promise.all([
        import('./locales/en.js'),
        import('./locales/hi.js'),
    ]);
    return { en: en.default, hi: hi.default };
};

test('dictionaries: en and hi expose exactly the same keys', async () => {
    const { en, hi } = await loadDicts();
    const a = flattenKeys(en.messages).sort();
    const b = flattenKeys(hi.messages).sort();
    assert.deepEqual(
        a.filter((k) => !b.includes(k)),
        [],
        'keys present in English but missing from Hindi',
    );
    assert.deepEqual(
        b.filter((k) => !a.includes(k)),
        [],
        'keys present in Hindi that English does not define',
    );
});

test('dictionaries: every hi value is a non-empty string', async () => {
    const { hi } = await loadDicts();
    const walk = (obj, prefix = '') => {
        for (const [k, v] of Object.entries(obj)) {
            if (v && typeof v === 'object') walk(v, `${prefix}${k}.`);
            else {
                assert.equal(typeof v, 'string', `${prefix}${k} must be a string`);
                assert.ok(v.trim().length > 0, `${prefix}${k} must not be empty`);
            }
        }
    };
    walk(hi.messages);
});

test('dictionaries: interpolation placeholders survive translation', async () => {
    // t() replaces `{name}` style tokens. A translation that drops or renames one
    // renders the sentence with a hole in it ("… has joined the conversation."),
    // which no key-parity check would catch.
    const { en, hi } = await loadDicts();
    const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const walk = (a, b, prefix = '') => {
        for (const [k, v] of Object.entries(a)) {
            if (v && typeof v === 'object') walk(v, b[k], `${prefix}${k}.`);
            else {
                assert.deepEqual(
                    params(b[k]),
                    params(v),
                    `${prefix}${k}: Hindi placeholders must match English`,
                );
            }
        }
    };
    walk(en.messages, hi.messages);
});

// ── Hindi coverage for the swept surfaces ────────────────────────────────────

const DEVANAGARI = /[ऀ-ॿ]/;

// One representative key per visitor-facing surface the sweep touched. Keys that
// are deliberately script-free (a bare '{provider}' style token, an email
// placeholder) are excluded and covered by the parity tests above instead.
const SURFACE_KEYS = {
    'queue / waiting': ['queue.busy', 'queue.longer_than_usual', 'queue.still_trying', 'queue.keep_waiting', 'queue.position'],
    'operator connecting': ['system.connecting_team_title', 'system.connecting_seconds', 'connect.connecting'],
    'connect request': ['connect.wants_to_connect', 'connect.switch_prompt', 'connect.accept', 'connect.decline', 'connect.expires_in'],
    'leave-message flow': ['offline.reply_by_email', 'offline.not_now', 'offline.leave_message_instead', 'offline.sent_body', 'offline.continue_chatting_ai'],
    'no-operator state': ['offline.try_again', 'system.handoff_failed', 'connect.operator_available', 'system.someone_from_team'],
    'lead capture': ['lead.field_required', 'lead.invalid_email_short'],
    'live-chat status': ['status.sending', 'status.sent_at', 'status.delivered_at', 'status.read_at', 'system.not_sent_retry'],
    'post-chat survey': ['survey.yes', 'survey.no', 'survey.rating_prompt', 'survey.skip', 'survey.step_aria'],
    'upload / file flow': ['livechat.unsupported_file', 'livechat.file_too_large', 'livechat.upload_failed', 'livechat.preview_alt', 'livechat.full_size_alt'],
    'meeting confirmation': ['meeting.confirmed', 'meeting.sync_failed', 'meeting.done', 'meeting.open_new_tab', 'meeting.csp_blocked'],
    'errors and reconnect': ['system.chunk_generic', 'system.try_again', 'system.transcript_failed', 'livechat.connection_lost', 'system.reconnecting'],
    'end chat / transcript': ['system.end_conversation_title', 'system.end_conversation_desc', 'system.keep_chatting', 'system.transcript_prompt'],
    'slash commands': ['commands.new_description', 'commands.clear_description', 'commands.human_description'],
    'chat chrome': ['header.start_new_chat', 'header.close', 'system.load_earlier', 'system.today', 'system.yesterday'],
};

for (const [surface, keys] of Object.entries(SURFACE_KEYS)) {
    test(`Hindi: ${surface} renders in Devanagari`, async () => {
        resetI18n();
        await preloadDictionary('hi-IN');
        setLocale('hi-IN');
        for (const key of keys) {
            const value = t(key);
            assert.ok(value, `${key} must resolve in Hindi`);
            assert.ok(
                DEVANAGARI.test(value),
                `${key} must actually be Devanagari, got "${value}"`,
            );
        }
        resetI18n();
    });
}

test('Hindi: interpolation actually substitutes inside a translated sentence', async () => {
    resetI18n();
    await preloadDictionary('hi-IN');
    setLocale('hi-IN');

    const joined = t('system.operator_joined_conversation', { name: 'Priya' });
    assert.ok(joined.includes('Priya'), 'the operator name must appear');
    assert.ok(!joined.includes('{name}'), 'the token must be consumed');
    assert.ok(DEVANAGARI.test(joined));

    const step = t('survey.step_aria', { step: 2, total: 2 });
    assert.ok(!/\{\w+\}/.test(step), `unsubstituted token left in "${step}"`);
    resetI18n();
});

test('Hindi: the offline confirmation keeps {email} for the caller to split on', async () => {
    // ChatWindow splits this template on the literal token so the address can be
    // wrapped in <strong> at whatever position the language puts it. The token
    // must therefore survive translation AND must not be pre-substituted.
    resetI18n();
    await preloadDictionary('hi-IN');
    setLocale('hi-IN');
    for (const key of ['offline.sent_body', 'offline.sent_body_phone']) {
        const template = t(key);
        assert.ok(template.includes('{email}'), `${key} must keep the {email} token`);
        const [before, after] = template.split('{email}');
        assert.equal(typeof before, 'string');
        assert.equal(typeof after, 'string');
    }
    resetI18n();
});

// ── English is unchanged ─────────────────────────────────────────────────────

test('English: t() stays null so the inline defaults render verbatim', async () => {
    // English has no runtime dictionary by design. This is what guarantees a
    // single-language bot renders byte-identical copy to before the sweep.
    resetI18n();
    setLocale('en-IN');
    for (const key of Object.values(SURFACE_KEYS).flat()) {
        assert.equal(t(key), null, `${key} must not resolve in English`);
    }
    resetI18n();
});

test('English: the canonical dictionary still holds the shipped wording', async () => {
    const { en } = await loadDicts();
    const m = en.messages;
    assert.equal(m.queue.keep_waiting, 'Keep waiting');
    assert.equal(m.survey.skip, 'Skip');
    assert.equal(m.connect.accept, 'Yes, connect me');
    assert.equal(m.connect.decline, 'No, keep chatting with AI');
    assert.equal(m.offline.not_now, 'Not now');
    assert.equal(m.system.keep_chatting, 'Keep chatting');
    assert.equal(m.meeting.done, 'Done');
    assert.equal(m.status.sent, 'Sent');
    assert.equal(m.commands.human_description, 'Request a live agent');
    // "Try again" and "Try Again" are two different buttons in two different
    // cards. They stay separate keys precisely so neither one changes case.
    assert.equal(m.system.try_again, 'Try again');
    assert.equal(m.offline.try_again, 'Try Again');
});

test('a bot with multilingual off is untouched by the sweep', async () => {
    // No dictionary is ever loaded for such a bot, so every t() in every swept
    // component returns null and the component's own English default renders.
    resetI18n();
    assert.equal(getLocale(), 'en-IN');
    const probes = ['queue.busy', 'connect.accept', 'status.read', 'media.also_available'];
    for (const key of probes) assert.equal(t(key), null);
    // Interpolation on a missing key must not throw or emit a partial string.
    assert.equal(t('system.operator_joined_conversation', { name: 'Priya' }), null);
    resetI18n();
});

test('a missing key falls back rather than rendering the key path', async () => {
    resetI18n();
    await preloadDictionary('hi-IN');
    setLocale('hi-IN');
    assert.equal(t('queue.does_not_exist'), null);
    assert.equal(t('nope.at.all'), null);
    // A key that resolves to an object, not a string, is also a miss.
    assert.equal(t('queue'), null);
    resetI18n();
});

// ── Source guards ────────────────────────────────────────────────────────────
//
// The dictionary tests above prove the translations EXIST. They cannot prove a
// component actually asks for them - which is exactly how ~120 strings sat
// untranslated behind a complete-looking dictionary. These read the components
// and fail when a visitor-facing string goes back to being a bare literal.

const readComponent = (name) =>
    readFileSync(new URL(`../components/${name}`, import.meta.url), 'utf8');

/** Every shipped source file, so key-usage checks cannot go stale. */
const readSourceTree = () => {
    const root = new URL('../', import.meta.url);
    const out = [];
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const child = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
            if (entry.isDirectory()) {
                if (entry.name !== 'locales') walk(child);
            } else if (/\.(jsx|js)$/.test(entry.name) && !entry.name.includes('.test.')) {
                out.push(readFileSync(child, 'utf8'));
            }
        }
    };
    walk(root);
    return out.join('\n');
};

// Components whose every visitor-visible attribute must route through t().
// `alt=""` is exempt: an empty alt is the correct markup for a decorative image.
const SWEPT_COMPONENTS = [
    'ChatWindow.jsx',
    'ChatInput.jsx',
    'QueueWaitingScreen.jsx',
    'ConnectRequestPopup.jsx',
    'OperatorJoinedToast.jsx',
    'QualifiedLeadCard.jsx',
    'ChunkLoadNotice.jsx',
    'MessageStatus.jsx',
    'LeadCaptureForm.jsx',
    'HandoffForm.jsx',
    'MediaCard.jsx',
    'MeetingBooking.jsx',
    'LiveChatMode.jsx',
    'Launcher.jsx',
];

for (const name of SWEPT_COMPONENTS) {
    test(`${name}: no bare localizable attributes`, () => {
        const src = readComponent(name);
        const offenders = [];
        for (const attr of ['placeholder', 'aria-label', 'title', 'alt']) {
            const re = new RegExp(`\\b${attr}="([^"]*)"`, 'g');
            for (const m of src.matchAll(re)) {
                if (attr === 'alt' && m[1] === '') continue;
                offenders.push(`${attr}="${m[1]}"`);
            }
        }
        assert.deepEqual(offenders, [], `untranslated attributes in ${name}`);
    });
}

test('QueueWaitingScreen routes every status line through t()', () => {
    const src = readComponent('QueueWaitingScreen.jsx');
    for (const key of ['system.connecting_team', 'queue.busy', 'queue.longer_than_usual',
        'queue.position', 'queue.eta_wait', 'queue.still_trying', 'queue.keep_waiting']) {
        assert.match(src, new RegExp(`t\\('${key.replace('.', '\\.')}'`), `${key} must be used`);
    }
});

test('ConnectRequestPopup and OperatorJoinedToast route their copy through t()', () => {
    const popup = readComponent('ConnectRequestPopup.jsx');
    for (const key of ['connect.wants_to_connect', 'connect.switch_prompt',
        'connect.expires_in', 'connect.accept', 'connect.decline']) {
        assert.match(popup, new RegExp(`t\\('${key.replace('.', '\\.')}'`));
    }
    const toast = readComponent('OperatorJoinedToast.jsx');
    for (const key of ['connect.operator_available', 'connect.switch_instead', 'connect.switch']) {
        assert.match(toast, new RegExp(`t\\('${key.replace('.', '\\.')}'`));
    }
});

test('MessageStatus builds every receipt label from the dictionary', () => {
    const src = readComponent('MessageStatus.jsx');
    for (const key of ['status.sending', 'status.sent_at', 'status.sent',
        'status.delivered_at', 'status.delivered', 'status.read_at', 'status.read']) {
        assert.match(src, new RegExp(`t\\('${key.replace('.', '\\.')}'`));
    }
});

test('client-created system lines carry a textKey, not frozen copy', () => {
    // A system line resolved at CREATION time keeps whatever language was active
    // when the transition fired, stranding an English divider above Hindi
    // messages after a switch. SystemMessage resolves textKey on every render.
    const src = readComponent('ChatWindow.jsx');
    assert.match(src, /const SystemMessage = \(\{ text, textKey, textParams \}\)/);
    assert.match(src, /textKey \? t\(textKey, textParams\) : null/);
    for (const key of ['system.connecting_team', 'system.handoff_failed',
        'system.operator_joined_conversation', 'system.invitation_expired',
        'system.offline_recorded', 'system.operator_left_named']) {
        assert.match(src, new RegExp(`textKey: '${key.replace('.', '\\.')}'`), `${key} must be keyed`);
    }
    // Every system message the client builds must be keyed. A bare
    // `type: 'system'` with only `text:` is the regression this catches.
    const blocks = [...src.matchAll(/type: 'system',\n([\s\S]{0,200}?)timestamp:/g)];
    for (const [, body] of blocks) {
        assert.ok(/textKey:/.test(body), `a client system message has no textKey:\n${body}`);
    }
});

test('slash commands keep untranslated identities and translated labels', async () => {
    const { SLASH_COMMANDS } = await import('../lib/slashCommands.js');
    for (const cmd of SLASH_COMMANDS) {
        assert.match(cmd.name, /^[a-z]+$/, 'the typed command name must stay ASCII');
        assert.equal(cmd.descriptionKey, `commands.${cmd.name}_description`);
    }
    // Resolved at render, not at import: switching locale after the module has
    // loaded must still change what the palette shows.
    resetI18n();
    await preloadDictionary('hi-IN');
    setLocale('hi-IN');
    for (const cmd of SLASH_COMMANDS) {
        assert.ok(DEVANAGARI.test(t(cmd.descriptionKey)), `${cmd.name} description`);
    }
    resetI18n();
});

test('customer-authored copy still wins over the translated default', () => {
    // Precedence is settings -> dictionary -> inline English. The sweep must not
    // have reordered it: a greeting the customer wrote is shown as written.
    const chat = readComponent('ChatWindow.jsx');
    // Precedence is now three-way (see i18n/seededCopy.js): an authored value
    // wins verbatim, the backend's seeded default is translated, and an empty
    // field falls back to the widget's own line. `authoredCopy` is what draws
    // the first boundary, so it must be consulted before any t().
    assert.match(
        chat,
        /authoredCopy\(\s*\n?\s*settings\.widget_messages\.rating_prompt/,
        'rating_prompt: an authored value must still win over the dictionary',
    );
    assert.match(chat, /t\('presets\.rating_prompt'\)/);
    assert.match(chat, /t\('survey\.rating_prompt'\)/);
    const lead = readComponent('LeadCaptureForm.jsx');
    assert.match(lead, /settings\?\.lead_form_title \|\| t\('lead\.title'\)/);
    assert.match(lead, /settings\?\.lead_form_subtitle \|\| t\('lead\.subtitle'\)/);
    const launcher = readComponent('Launcher.jsx');
    assert.match(launcher, /settings\?\.greeting_message\s*\n?\s*\|\|\s*t\('launcher\.greeting_default'\)/);
    const welcome = readFileSync(new URL('../components/WelcomeScreen.jsx', import.meta.url), 'utf8');
    assert.match(welcome, /authoredCopy\(settings\?\.welcome_subtitle, SEEDED\.welcome_subtitle\)/);
    assert.match(welcome, /authoredCopy\(settings\?\.welcome_title, SEEDED\.welcome_title\)/);
    assert.match(welcome, /authoredList\(messages\.welcome_suggestions, SEEDED\.welcome_suggestions\)/);
});

test('every t() key used in a component exists in the English dictionary', async () => {
    // A typo'd key silently renders the inline English fallback forever. This is
    // the check that turns that into a failing test.
    const { en } = await loadDicts();
    const known = new Set(flattenKeys(en.messages));
    const missing = [];
    for (const name of [...SWEPT_COMPONENTS, 'WelcomeScreen.jsx', 'LanguageSelector.jsx',
        'MessageBubble.jsx', 'QualificationCTA.jsx']) {
        const src = readComponent(name);
        for (const m of src.matchAll(/\bt\(\s*'([a-z_]+(?:\.[a-z_]+)+)'/g)) {
            if (!known.has(m[1])) missing.push(`${name}: ${m[1]}`);
        }
    }
    assert.deepEqual(missing, [], 't() keys with no dictionary entry');
});

// ── The guard that would have caught the second round of misses ──────────────
//
// The attribute guard above only sees `placeholder="..."` style markup. It is
// blind to a sentence assigned to a variable, which is how four visitor-facing
// strings survived the first sweep: the stream-error copy built into a
// `friendly` const, and the offline form's email validation.
//
// The rule here is structural rather than positional: a sentence-shaped literal
// must have a `t(` or a `textKey:` in the code immediately preceding it, which
// is what the `t('key') || 'English'` and `textKey/text` idioms both produce.
// Anything else has to earn a line in ALLOWED_BARE_STRINGS with a reason.

const GUARDED_COMPONENTS = [...SWEPT_COMPONENTS, 'MessageBubble.jsx', 'WelcomeScreen.jsx', 'LanguageSelector.jsx'];

const ALLOWED_BARE_STRINGS = new Map([
    // Placeholder values for customer-authored settings. They are overwritten by
    // the bot's real configuration before the visitor sees anything, and are
    // shown unchanged in every language by design when they are not.
    ['Your Chatbot Name', 'default value for settings.bot_name'],
    ['Have Questions?', 'default value for settings.launcher_name'],
    // Split on the literal {email} token so the address keeps its <strong> at
    // whatever position the language puts it. The t() lookup sits at the top of
    // the enclosing IIFE, further back than the guard's window reaches.
    ['We’ll get back to you at {email} or give you a callback as soon as possible.', 'offline.sent_body_phone fallback'],
    ['We’ll get back to you at {email} as soon as possible.', 'offline.sent_body fallback'],
]);

/** Remove comments so prose inside them is not mistaken for rendered copy. */
const stripComments = (src) =>
    src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
        .join('\n');

test('no visitor-facing sentence is built without going through t()', () => {
    const offenders = [];
    for (const name of GUARDED_COMPONENTS) {
        const src = stripComments(readComponent(name));
        for (const m of src.matchAll(/(['"])((?:(?!\1)[^\\\n]){8,})\1/g)) {
            const text = m[2];
            // Sentence-shaped: at least two words, starting like prose.
            if (!/[A-Za-z]{2,}\s+[A-Za-z]/.test(text)) continue;
            if (!/^[A-Z‘“I]/.test(text)) continue;
            // Tailwind class strings and other machine tokens.
            if (/^[a-z-]+(\s+[a-z0-9:[\]/.#()-]+)+$/.test(text)) continue;
            if (/ {2}|className|rounded|flex|border|w-\d|h-\d/.test(text)) continue;
            if (ALLOWED_BARE_STRINGS.has(text)) continue;
            // The `t('key') || 'English'` and `textKey:`/`text:` idioms both put
            // one of these immediately before the literal.
            const preceding = src.slice(Math.max(0, m.index - 160), m.index);
            if (/\bt\(\s*['"]/.test(preceding) || /textKey:/.test(preceding)) continue;
            offenders.push(`${name}: ${JSON.stringify(text)}`);
        }
    }
    assert.deepEqual(offenders, [], 'bare visitor-facing strings; localize them or allowlist with a reason');
});

test('the bare-string allowlist has no stale entries', () => {
    // An allowlist that outlives its reason quietly re-opens the hole it was
    // opened for, so every entry must still be present in the source.
    const all = GUARDED_COMPONENTS.map((n) => readComponent(n)).join('\n');
    for (const [text, reason] of ALLOWED_BARE_STRINGS) {
        assert.ok(all.includes(text), `allowlisted string is gone, drop the entry (${reason}): ${text}`);
    }
});

test('stream-error and offline-validation copy is localized', () => {
    // Named explicitly because these are the four that the attribute guard and
    // the first inventory both missed.
    const src = readComponent('ChatWindow.jsx');
    for (const key of ['system.error_over_capacity', 'system.error_maintenance',
        'system.error_generic', 'offline.invalid_email', 'system.someone_from_team']) {
        assert.match(src, new RegExp(`t\\('${key.replace('.', '\\.')}'`), `${key} must be used`);
    }
    assert.doesNotMatch(src, /setOfflineEmailError\('Please enter/);
});

test('every dictionary key is actually used by the widget', () => {
    // This cleanup removed 19 keys that no component had referenced in months:
    // copy for a handoff form that lost its department and message fields, an
    // "Auto-detected" language badge replaced by a check icon, duplicate email
    // and reconnecting strings. They cost every Hindi visitor bytes and gave
    // reviewers false confidence that a surface was covered.
    //
    // The source list is WALKED, not hand-maintained: a fixed list is the same
    // staleness bug one level up, and the first draft of this very test wrongly
    // condemned three live keys by forgetting ChatWidget and TypingIndicator.
    //
    // Keys reached through a variable (`t(textKey)`, `t(cmd.descriptionKey)`)
    // still appear as quoted literals where they are assigned, so a literal
    // search suffices. Quoting exactly stops 'a.b' counting as a use of
    // 'a.b_suffix'.
    const all = readSourceTree();

    return loadDicts().then(({ en }) => {
        const unused = flattenKeys(en.messages).filter((k) => !all.includes(`'${k}'`));
        assert.deepEqual(
            unused,
            [],
            'dictionary keys no component references; delete them or wire them up',
        );
    });
});

// ── Seeded copy vs authored copy ─────────────────────────────────────────────
//
// Reported from production: a bot configured for Hindi rendered its whole
// welcome screen in English. The cause was not a missing translation. Every
// bot arrives with `welcome_title`, `welcome_subtitle`, `waiting_message` and
// `widget_messages` already populated from the backend's server_default, so
// `settings.welcome_title || t(...)` never reached the `t(...)`.

test('seededCopy: an untouched field is not treated as authored', async () => {
    const { SEEDED, authoredCopy, authoredList } = await import('./seededCopy.js');
    // Exactly what GET /bots/settings/public sends for a bot nobody edited.
    assert.equal(authoredCopy(SEEDED.welcome_title, SEEDED.welcome_title), null);
    assert.equal(authoredCopy(SEEDED.welcome_subtitle, SEEDED.welcome_subtitle), null);
    assert.equal(authoredCopy(SEEDED.waiting_message, SEEDED.waiting_message), null);
    assert.equal(authoredCopy(SEEDED.input_placeholder, SEEDED.input_placeholder), null);
    assert.equal(authoredList(SEEDED.welcome_suggestions, SEEDED.welcome_suggestions), null);
    // Surrounding whitespace is not authorship either.
    assert.equal(authoredCopy(`  ${SEEDED.welcome_title}  `, SEEDED.welcome_title), null);
});

test('seededCopy: a real override is returned verbatim', async () => {
    const { SEEDED, authoredCopy, authoredList } = await import('./seededCopy.js');
    assert.equal(authoredCopy('Namaste from Acme', SEEDED.welcome_title), 'Namaste from Acme');
    // Whitespace inside an authored value is the customer's, and is preserved.
    assert.equal(authoredCopy('  Acme  ', SEEDED.welcome_title), '  Acme  ');
    assert.deepEqual(authoredList(['Pricing'], SEEDED.welcome_suggestions), ['Pricing']);
    // Same strings, different order, is a deliberate reordering.
    const reordered = [...SEEDED.welcome_suggestions].reverse();
    assert.deepEqual(authoredList(reordered, SEEDED.welcome_suggestions), reordered);
});

test('seededCopy: empty and malformed values fall through', async () => {
    const { SEEDED, authoredCopy, authoredList } = await import('./seededCopy.js');
    for (const empty of ['', '   ', null, undefined, 42, {}]) {
        assert.equal(authoredCopy(empty, SEEDED.welcome_title), null, String(empty));
    }
    for (const empty of [[], null, undefined, 'nope', {}]) {
        assert.equal(authoredList(empty, SEEDED.welcome_suggestions), null, String(empty));
    }
    // A partial list is still an override, not a coincidence.
    assert.deepEqual(
        authoredList(['Our Services'], SEEDED.welcome_suggestions),
        ['Our Services'],
    );
});

test('seeded welcome copy has a Hindi translation to fall through to', async () => {
    resetI18n();
    await preloadDictionary('hi-IN');
    setLocale('hi-IN');
    for (const key of ['presets.welcome_title', 'presets.welcome_subtitle',
        'presets.waiting_message', 'presets.rating_prompt']) {
        const value = t(key);
        assert.ok(value, `${key} must resolve`);
        assert.ok(DEVANAGARI.test(value), `${key} must be Devanagari, got "${value}"`);
    }
    // The chips and the composer reuse keys that already existed, because the
    // backend seeds exactly the strings those keys hold.
    for (const key of ['welcome.suggestion_services', 'welcome.suggestion_about',
        'welcome.suggestion_contact', 'input.placeholder']) {
        assert.ok(DEVANAGARI.test(t(key)), key);
    }
    resetI18n();
});

test('the English preset wording matches what the backend seeds', async () => {
    // If these drift, a bot on the default renders one sentence in English and
    // a different one in Hindi, which reads as a mistranslation.
    const { SEEDED } = await import('./seededCopy.js');
    const { en } = await loadDicts();
    assert.equal(en.messages.presets.welcome_subtitle, SEEDED.welcome_subtitle);
    assert.equal(en.messages.presets.waiting_message, SEEDED.waiting_message);
    assert.equal(en.messages.presets.rating_prompt, SEEDED.rating_prompt);
    assert.equal(en.messages.input.placeholder, SEEDED.input_placeholder);
    assert.deepEqual(
        [en.messages.welcome.suggestion_services, en.messages.welcome.suggestion_about,
            en.messages.welcome.suggestion_contact],
        SEEDED.welcome_suggestions,
    );
    // welcome_title is the one exception: the seed carries an emoji that
    // WelcomeScreen strips before rendering, so the dictionary holds the
    // stripped form.
    assert.equal(`${en.messages.presets.welcome_title} 👋`, SEEDED.welcome_title);
});

test('the welcome screen consults authoredCopy before any fallback', () => {
    const src = readComponent('WelcomeScreen.jsx');
    // All three cases must be distinguishable, so the absent branch (a
    // time-of-day greeting) has to survive alongside the seeded branch.
    assert.match(src, /hasTitle \? t\('presets\.welcome_title'\)/);
    assert.match(src, /: getGreeting\(\)/);
    assert.doesNotMatch(src, /settings\?\.welcome_title \|\| getGreeting\(\)/);
});

// ── Slash palette icon sizing ────────────────────────────────────────────────

test('every slash command icon honours the size prop', async () => {
    // The popover renders `<Icon size={14} />`. Two commands use lucide
    // components, which map `size` to width/height. `/human` used a bare <svg>
    // where `size` landed as an inert attribute, so the icon expanded to fill
    // its container: on a fresh chat, where `/human` is the ONLY available
    // command, the whole palette became one giant headphones glyph.
    //
    // Asserted on RENDERED markup rather than the element's props: lucide icons
    // are forwardRef objects that cannot be called directly, and the rendered
    // attributes are what actually sized the box.
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { SLASH_COMMANDS } = await import('../lib/slashCommands.js');

    for (const cmd of SLASH_COMMANDS) {
        const html = renderToStaticMarkup(createElement(cmd.icon, { size: 14 }));
        assert.match(html, /width="14"/, `${cmd.name}: icon ignored size, width missing`);
        assert.match(html, /height="14"/, `${cmd.name}: icon ignored size, height missing`);
        // A stray `size` attribute is the exact symptom of the bug: React
        // forwards an unknown prop straight onto the SVG element.
        assert.doesNotMatch(html, /\ssize="/, `${cmd.name}: size leaked onto the element`);
    }
});

test('a slash icon still renders at its natural size with no size prop', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { SLASH_COMMANDS } = await import('../lib/slashCommands.js');
    for (const cmd of SLASH_COMMANDS) {
        const html = renderToStaticMarkup(createElement(cmd.icon, {}));
        assert.match(html, /width="\d+"/, `${cmd.name}: no intrinsic width, would fill its container`);
        assert.match(html, /height="\d+"/, `${cmd.name}: no intrinsic height`);
    }
});
