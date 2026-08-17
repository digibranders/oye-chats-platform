/**
 * Tests for input sanitization helpers (sanitize.js).
 *
 * These helpers are a security boundary: bot settings (colors, logo/file URLs)
 * come from the settings API and are interpolated into inline styles and
 * href/src attributes. A bypass here is a stored-XSS / CSS-injection vector,
 * so the negative cases matter as much as the happy path.
 *
 * Run with: `node --test src/services/sanitize.test.js`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeColor, sanitizeImageUrl, sanitizeFileUrl } from './sanitize.js';

// ── sanitizeColor ────────────────────────────────────────────────────────────

test('sanitizeColor accepts 3/4/6/8-digit hex in either case', () => {
    for (const good of ['#abc', '#ABC', '#abcd', '#a1b2c3', '#A1B2C3', '#a1b2c3d4']) {
        assert.equal(sanitizeColor(good), good, `expected ${good} to pass through`);
    }
});

test('sanitizeColor rejects malformed hex and falls back', () => {
    // Wrong length (1,2,5,7 digits), missing hash, non-hex chars.
    for (const bad of ['#a', '#ab', '#abcde', '#abcdefg', 'abc123', '#xyz', '#12g']) {
        assert.equal(sanitizeColor(bad), '#2B66BC', `expected ${bad} to fall back`);
    }
});

test('sanitizeColor blocks CSS-injection payloads dressed up as colors', () => {
    // The whole point: a value that would break out of the style context.
    const attacks = [
        'red; background: url(https://evil.example/x)',
        '#fff; } body { display:none',
        'expression(alert(1))',
        'url(javascript:alert(1))',
    ];
    for (const payload of attacks) {
        assert.equal(sanitizeColor(payload), '#2B66BC');
    }
});

test('sanitizeColor honours a custom fallback', () => {
    assert.equal(sanitizeColor(undefined, '#000000'), '#000000');
    assert.equal(sanitizeColor('not-a-color', '#123456'), '#123456');
});

test('sanitizeColor rejects non-string input', () => {
    for (const bad of [null, undefined, 42, {}, [], true]) {
        assert.equal(sanitizeColor(bad), '#2B66BC');
    }
});

// ── sanitizeImageUrl ──────────────────────────────────────────────────────────

test('sanitizeImageUrl allows http(s) and data:image', () => {
    assert.equal(sanitizeImageUrl('https://cdn.example/logo.png'), 'https://cdn.example/logo.png');
    assert.equal(sanitizeImageUrl('http://cdn.example/logo.png'), 'http://cdn.example/logo.png');
    assert.equal(
        sanitizeImageUrl('data:image/png;base64,iVBORw0KGgo='),
        'data:image/png;base64,iVBORw0KGgo=',
    );
    assert.equal(sanitizeImageUrl('HTTPS://CDN.EXAMPLE/L.PNG'), 'HTTPS://CDN.EXAMPLE/L.PNG');
});

test('sanitizeImageUrl blocks dangerous schemes', () => {
    // javascript:, data:text/html and vbscript: are the classic image-src XSS
    // vectors; each must return null (caller renders nothing).
    const attacks = [
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'data:text/html;base64,PHNjcmlwdD4=',
        'vbscript:msgbox(1)',
        '  javascript:alert(1)', // leading space must not smuggle it past ^https?
        'jAvAsCrIpT:alert(1)',
    ];
    for (const payload of attacks) {
        assert.equal(sanitizeImageUrl(payload), null, `expected ${payload} to be blocked`);
    }
});

test('sanitizeImageUrl rejects empty and non-string input', () => {
    for (const bad of ['', null, undefined, 0, {}, []]) {
        assert.equal(sanitizeImageUrl(bad), null);
    }
});

// ── sanitizeFileUrl ───────────────────────────────────────────────────────────

test('sanitizeFileUrl allows only http(s)', () => {
    assert.equal(sanitizeFileUrl('https://files.example/a.pdf'), 'https://files.example/a.pdf');
    assert.equal(sanitizeFileUrl('http://files.example/a.pdf'), 'http://files.example/a.pdf');
});

test('sanitizeFileUrl rejects data: URIs (unlike image variant)', () => {
    // File links never legitimately use data: — even data:image is refused here.
    assert.equal(sanitizeFileUrl('data:image/png;base64,iVBORw0KGgo='), null);
    assert.equal(sanitizeFileUrl('data:application/pdf;base64,AAAA'), null);
});

test('sanitizeFileUrl blocks dangerous schemes and bad input', () => {
    for (const bad of ['javascript:alert(1)', 'ftp://x.example/a', 'file:///etc/passwd', '', null, undefined, 99]) {
        assert.equal(sanitizeFileUrl(bad), null);
    }
});
