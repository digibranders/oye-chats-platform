/**
 * Tests for the branding link helper (brandingLink.js).
 *
 * Run with: `node --test src/services/brandingLink.test.js`
 * (Node 18+ has a built-in test runner, no vitest/jest dep needed.)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_BRANDING_TEXT,
    DEFAULT_BRANDING_URL,
    buildBrandingHref,
    resolveBrandingText,
    splitBrandingText,
} from './brandingLink.js';

test('stamps ref and utm on the default oyechats url', () => {
    const url = new URL(buildBrandingHref(DEFAULT_BRANDING_URL, 'bot-11a026a4b8b3'));
    assert.equal(url.origin + url.pathname, 'https://www.oyechats.com/');
    assert.equal(url.searchParams.get('ref'), 'bot-11a026a4b8b3');
    assert.equal(url.searchParams.get('utm_source'), 'widget');
    assert.equal(url.searchParams.get('utm_medium'), 'referral');
});

test('stamps the apex oyechats host too', () => {
    const url = new URL(buildBrandingHref('https://oyechats.com/', 'bot-abc'));
    assert.equal(url.searchParams.get('ref'), 'bot-abc');
});

test('falls back to the default url when branding url is missing or blank', () => {
    for (const input of [undefined, null, '', '   ']) {
        const url = new URL(buildBrandingHref(input, 'bot-abc'));
        assert.equal(url.origin, 'https://www.oyechats.com');
        assert.equal(url.searchParams.get('ref'), 'bot-abc');
    }
});

test('leaves a white-label url completely untouched', () => {
    const href = buildBrandingHref('https://acme.example/support', 'bot-abc');
    assert.equal(href, 'https://acme.example/support');
});

test('omits ref when the bot key is missing or malformed', () => {
    for (const key of [undefined, '', 'bad key!', 'x'.repeat(65)]) {
        const url = new URL(buildBrandingHref(DEFAULT_BRANDING_URL, key));
        assert.equal(url.searchParams.get('ref'), null);
        assert.equal(url.searchParams.get('utm_source'), 'widget');
    }
});

test('rejects non-http protocols and unparseable urls', () => {
    for (const bad of ['javascript:alert(1)', 'not a url', 'ftp://x.example']) {
        const url = new URL(buildBrandingHref(bad, 'bot-abc'));
        assert.equal(url.origin, 'https://www.oyechats.com');
    }
});

test('preserves existing query params on a custom oyechats url', () => {
    const url = new URL(buildBrandingHref('https://www.oyechats.com/pricing?plan=pro', 'bot-abc'));
    assert.equal(url.pathname, '/pricing');
    assert.equal(url.searchParams.get('plan'), 'pro');
    assert.equal(url.searchParams.get('ref'), 'bot-abc');
});

test('resolveBrandingText trims, falls back, and caps length', () => {
    assert.equal(resolveBrandingText(undefined), DEFAULT_BRANDING_TEXT);
    assert.equal(resolveBrandingText('   '), DEFAULT_BRANDING_TEXT);
    assert.equal(resolveBrandingText('  Powered by Acme  '), 'Powered by Acme');
    assert.equal(resolveBrandingText('x'.repeat(80)).length, 60);
});

test('resolveBrandingText never splits a surrogate pair at the cap', () => {
    // 59 ASCII code units + 2 astral emoji (2 code units each) = 63 code
    // units total, straddling the 60-code-unit cap right inside the first
    // emoji's surrogate pair. A naive `.slice(0, 60)` would cut mid-pair and
    // leave a lone high surrogate ('\ud83d') dangling at the end.
    const input = 'x'.repeat(59) + '🚀🚀';
    const result = resolveBrandingText(input);

    // No unpaired surrogate: every code unit pairs up cleanly into whole
    // code points when re-decoded.
    assert.equal(Array.from(result).join(''), result);
    assert.doesNotMatch(result, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    assert.doesNotMatch(result, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);

    // Whole-character cap: 59 'x' characters plus one complete rocket emoji,
    // the second rocket dropped rather than split.
    assert.equal(Array.from(result).length, 60);
    assert.equal(result, 'x'.repeat(59) + '🚀');
});

test('splitBrandingText separates the trailing brand word', () => {
    assert.deepEqual(splitBrandingText('Powered by OyeChats'), { lead: 'Powered by', brand: 'OyeChats' });
    assert.deepEqual(splitBrandingText('Acme'), { lead: '', brand: 'Acme' });
    assert.deepEqual(splitBrandingText('Built with love by Acme'), { lead: 'Built with love by', brand: 'Acme' });
});
