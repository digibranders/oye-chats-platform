/**
 * Tests for the smart-link click registry (smartLinks.js).
 *
 * The module is a singleton with localStorage persistence keyed by bot + session.
 * These tests exercise URL normalization, per-session isolation, click
 * suppression, and graceful degradation when storage is unavailable.
 *
 * Run with: `node --test src/services/smartLinks.test.js`
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal window + localStorage stub (node:test has no DOM) ─────────────────
function installStorage({ throwing = false } = {}) {
    const store = new Map();
    globalThis.window = {
        OYECHATS_BOT_KEY: 'bot-test123',
        localStorage: {
            getItem: (k) => {
                if (throwing) throw new Error('blocked');
                return store.has(k) ? store.get(k) : null;
            },
            setItem: (k, v) => {
                if (throwing) throw new Error('blocked');
                store.set(k, String(v));
            },
            removeItem: (k) => store.delete(k),
        },
        _store: store,
    };
    return store;
}

const {
    setSmartLinkUrls,
    setSmartLinkSession,
    isSmartLink,
    isSmartLinkClicked,
    markSmartLinkClicked,
} = await import('./smartLinks.js');

beforeEach(() => {
    installStorage();
    // Reset the singleton to a known, empty state for the next test. Using a
    // fresh session id forces loadClicked() to re-read from the (now empty)
    // store, and setSmartLinkUrls([]) clears the destination set.
    setSmartLinkUrls([]);
    setSmartLinkSession(`sess-${Math.random()}`);
});

test('isSmartLink matches configured destinations after normalization', () => {
    setSmartLinkUrls(['https://Acme.example/Pricing/', ' https://acme.example/docs ']);
    // Trailing slash, case and surrounding whitespace are all smoothed over.
    assert.equal(isSmartLink('https://acme.example/pricing'), true);
    assert.equal(isSmartLink('HTTPS://ACME.EXAMPLE/PRICING/'), true);
    assert.equal(isSmartLink('https://acme.example/docs'), true);
    assert.equal(isSmartLink('https://acme.example/other'), false);
});

test('isSmartLink is false when no destinations are configured', () => {
    setSmartLinkUrls([]);
    assert.equal(isSmartLink('https://acme.example/pricing'), false);
    // Non-array / junk input clears the set rather than throwing.
    setSmartLinkUrls(null);
    assert.equal(isSmartLink('https://acme.example/pricing'), false);
});

test('marking a click suppresses that link but not siblings', () => {
    setSmartLinkUrls(['https://acme.example/a', 'https://acme.example/b']);
    assert.equal(isSmartLinkClicked('https://acme.example/a'), false);

    markSmartLinkClicked('https://acme.example/A/'); // normalized to /a
    assert.equal(isSmartLinkClicked('https://acme.example/a'), true);
    assert.equal(isSmartLinkClicked('https://acme.example/b'), false);
});

test('marking is idempotent and ignores empty hrefs', () => {
    setSmartLinkUrls(['https://acme.example/a']);
    markSmartLinkClicked('https://acme.example/a');
    markSmartLinkClicked('https://acme.example/a'); // no-op second time
    markSmartLinkClicked(''); // ignored
    markSmartLinkClicked(null); // ignored
    assert.equal(isSmartLinkClicked('https://acme.example/a'), true);
    // Only one entry persisted.
    const raw = JSON.parse([...globalThis.window._store.values()][0]);
    assert.deepEqual(raw.urls, ['https://acme.example/a']);
});

test('clicks persist to localStorage tagged with the session id', () => {
    setSmartLinkSession('sess-persist');
    setSmartLinkUrls(['https://acme.example/a']);
    markSmartLinkClicked('https://acme.example/a');

    const entries = [...globalThis.window._store.entries()];
    assert.equal(entries.length, 1);
    const [key, value] = entries[0];
    assert.match(key, /^oyechats_smartlink_clicks_bot-test123$/);
    assert.deepEqual(JSON.parse(value), {
        sessionId: 'sess-persist',
        urls: ['https://acme.example/a'],
    });
});

test('a stored click is restored when the SAME session reloads', () => {
    const store = installStorage();
    store.set(
        'oyechats_smartlink_clicks_bot-test123',
        JSON.stringify({ sessionId: 'sess-A', urls: ['https://acme.example/a'] }),
    );
    setSmartLinkSession('sess-A');
    assert.equal(isSmartLinkClicked('https://acme.example/a'), true);
});

test('a NEW session ignores clicks stored under the old session id', () => {
    const store = installStorage();
    store.set(
        'oyechats_smartlink_clicks_bot-test123',
        JSON.stringify({ sessionId: 'sess-OLD', urls: ['https://acme.example/a'] }),
    );
    setSmartLinkSession('sess-NEW');
    // Different conversation → fresh start, prior clicks are not adopted.
    assert.equal(isSmartLinkClicked('https://acme.example/a'), false);
});

test('setSmartLinkSession is a no-op when the id is unchanged', () => {
    setSmartLinkSession('sess-stable');
    setSmartLinkUrls(['https://acme.example/a']);
    markSmartLinkClicked('https://acme.example/a');
    // Re-setting the same id must NOT reload/clear the in-memory clicks.
    setSmartLinkSession('sess-stable');
    assert.equal(isSmartLinkClicked('https://acme.example/a'), true);
});

test('suppression still works in-memory when localStorage throws', () => {
    installStorage({ throwing: true });
    setSmartLinkSession('sess-blocked'); // loadClicked swallows the throw
    setSmartLinkUrls(['https://acme.example/a']);
    // persistClicked throws internally but is swallowed; in-memory state holds.
    assert.doesNotThrow(() => markSmartLinkClicked('https://acme.example/a'));
    assert.equal(isSmartLinkClicked('https://acme.example/a'), true);
});

test('corrupt stored JSON degrades to an empty click set', () => {
    const store = installStorage();
    store.set('oyechats_smartlink_clicks_bot-test123', '{not valid json');
    assert.doesNotThrow(() => setSmartLinkSession('sess-corrupt'));
    assert.equal(isSmartLinkClicked('https://acme.example/a'), false);
});
