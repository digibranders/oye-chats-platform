import test from 'node:test';
import assert from 'node:assert/strict';

// `loader.js` is a browser IIFE, but its module scope only touches `window`,
// `document` and `localStorage`, so it loads under plain node once those
// exist. `OYECHATS_ASYNC_INIT` keeps it from trying to boot the React app.
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
};
globalThis.document = {
    currentScript: null,
    readyState: 'complete',
    getElementsByTagName: () => [],
    addEventListener: () => {},
};
globalThis.window = {
    OYECHATS_ASYNC_INIT: true,
    OYECHATS_BOT_KEY: 'bot-test',
    location: { hostname: 'example.com' },
    addEventListener: () => {},
};

await import('../loader.js');
const firstApi = globalThis.window.OyeChats;
// A distinct module instance, the way a second <script> tag re-executes the
// loader on one page (SPA re-mount, GTM firing on two triggers, two snippets).
await import('../loader.js?duplicate');

// ── W2: a duplicate load must not orphan window.OyeChats ────────────────────

test('a second loader execution leaves the installed API in place', async () => {
    // The bug: the second execution overwrote `window.OyeChats` with a fresh
    // stub. The app-entry module is already cached and registers exactly once,
    // into the FIRST stub, so the new stub's queue never drained and open() /
    // send() / on('ready') went silent for good.
    assert.equal(globalThis.window.OyeChats, firstApi, 'the duplicate load replaced the live API object');
});

test('calls queued on the surviving stub still replay when the app registers', async () => {
    const calls = [];
    firstApi.open();
    firstApi.send('hi');
    firstApi.__register({
        open: () => calls.push('open'),
        send: (msg) => calls.push(`send:${msg}`),
    });

    assert.deepEqual(calls, ['open', 'send:hi']);
});

// ── W11: pre-boot getLocale() must return the locale, not the stored blob ───

test('getLocale parses the stored { locale, source } shape', () => {
    store.set('oyechats_locale_bot-test', JSON.stringify({ locale: 'hi-IN', source: 'visitor' }));
    assert.equal(firstApi.getLocale(), 'hi-IN');
});

test('getLocale still accepts a legacy bare-string value', () => {
    store.set('oyechats_locale_bot-test', 'fr-FR');
    assert.equal(firstApi.getLocale(), 'fr-FR');
});

test('getLocale falls back to en-IN with nothing stored or a corrupt value', () => {
    store.delete('oyechats_locale_bot-test');
    assert.equal(firstApi.getLocale(), 'en-IN');
    store.set('oyechats_locale_bot-test', '{not json');
    assert.equal(firstApi.getLocale(), 'en-IN');
    store.set('oyechats_locale_bot-test', '{"source":"html"}');
    assert.equal(firstApi.getLocale(), 'en-IN');
});
