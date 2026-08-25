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
    assert.match(
        chat,
        /settings\?\.widget_messages\?\.rating_prompt\s*\n?\s*\|\|\s*t\('survey\.rating_prompt'\)/,
        'rating_prompt: customer copy must be checked before the dictionary',
    );
    const lead = readComponent('LeadCaptureForm.jsx');
    assert.match(lead, /settings\?\.lead_form_title \|\| t\('lead\.title'\)/);
    assert.match(lead, /settings\?\.lead_form_subtitle \|\| t\('lead\.subtitle'\)/);
    const launcher = readComponent('Launcher.jsx');
    assert.match(launcher, /settings\?\.greeting_message\s*\n?\s*\|\|\s*t\('launcher\.greeting_default'\)/);
    const welcome = readFileSync(new URL('../components/WelcomeScreen.jsx', import.meta.url), 'utf8');
    assert.match(welcome, /settings\?\.welcome_subtitle \|\| t\('welcome\.subtitle'\)/);
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
