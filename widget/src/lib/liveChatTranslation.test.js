import test from 'node:test';
import assert from 'node:assert/strict';

import { baseLanguage, directionFor, displayTextFor } from './liveChatTranslation.js';

// ── The reconnect case this module exists for ────────────────────────────────

test('reconnect: an operator reply renders in the visitor language, not the stored original', () => {
    // The DB row is the operator's English original (canonical, never
    // rewritten). The visitor saw Hindi live. On reconnect the widget must
    // still show Hindi, or the thread turns bilingual mid-conversation.
    const row = {
        content: 'Our Enterprise plan starts at 5000 rupees.',
        translations: { hi: { content: 'हमारा एंटरप्राइज़ प्लान 5000 रुपये से शुरू होता है।', status: 'ok' } },
    };
    assert.equal(displayTextFor(row, 'hi-IN'), 'हमारा एंटरप्राइज़ प्लान 5000 रुपये से शुरू होता है।');
});

test('the visitor own messages are unaffected', () => {
    const row = { content: 'मुझे pricing चाहिए', translations: { en: { content: 'I need pricing', status: 'ok' } } };
    // A Hindi visitor reads their own Hindi message, never the English
    // translation that was made for the operator.
    assert.equal(displayTextFor(row, 'hi-IN'), 'मुझे pricing चाहिए');
});

// ── Fallbacks: every one of these must yield the original ────────────────────

test('falls back to the original when no translation exists', () => {
    assert.equal(displayTextFor({ content: 'Hello' }, 'hi-IN'), 'Hello');
    assert.equal(displayTextFor({ content: 'Hello', translations: {} }, 'hi-IN'), 'Hello');
    assert.equal(displayTextFor({ content: 'Hello', translations: null }, 'hi-IN'), 'Hello');
});

test('a failed translation falls back to the original', () => {
    // `status: failed` rows are recorded on purpose (they stop a pointless
    // retry) and carry no content.
    const row = { content: 'Hello', translations: { hi: { status: 'failed' } } };
    assert.equal(displayTextFor(row, 'hi'), 'Hello');
});

test('an empty translated string falls back to the original', () => {
    // Never render an empty bubble over a non-empty original.
    const row = { content: 'Hello', translations: { hi: { content: '', status: 'ok' } } };
    assert.equal(displayTextFor(row, 'hi'), 'Hello');
});

test('a missing session language falls back to the original', () => {
    const row = { content: 'Hello', translations: { hi: { content: 'नमस्ते', status: 'ok' } } };
    for (const lang of [null, undefined, '', '   ']) {
        assert.equal(displayTextFor(row, lang), 'Hello');
    }
});

test('a malformed message never throws', () => {
    assert.equal(displayTextFor(null, 'hi'), '');
    assert.equal(displayTextFor({}, 'hi'), '');
    assert.equal(displayTextFor({ content: 42 }, 'hi'), '');
});

// ── Locale handling ──────────────────────────────────────────────────────────

test('locale tags resolve to their base language', () => {
    const row = { content: 'Hello', translations: { hi: { content: 'नमस्ते', status: 'ok' } } };
    for (const tag of ['hi', 'hi-IN', 'hi_IN', 'HI-in', '  hi-IN  ']) {
        assert.equal(displayTextFor(row, tag), 'नमस्ते', `failed for ${tag}`);
    }
});

test('baseLanguage normalises the way the server does', () => {
    assert.equal(baseLanguage('hi-IN'), 'hi');
    assert.equal(baseLanguage('zh-Hans-CN'), 'zh');
    assert.equal(baseLanguage('EN_us'), 'en');
    assert.equal(baseLanguage(null), null);
    assert.equal(baseLanguage(''), null);
    assert.equal(baseLanguage(123), null);
});

// ── RTL ──────────────────────────────────────────────────────────────────────

test('RTL languages are recognised from a locale or a bare code', () => {
    for (const rtl of ['ar', 'ar-SA', 'he-IL', 'fa', 'ur-PK']) {
        assert.equal(directionFor(rtl), 'rtl', `${rtl} should be rtl`);
    }
    for (const ltr of ['en', 'hi-IN', 'fr-FR', 'zh-Hans-CN', null, '']) {
        assert.equal(directionFor(ltr), 'ltr', `${ltr} should be ltr`);
    }
});

// ── UTF-8 integrity ──────────────────────────────────────────────────────────

test('multibyte text and emoji survive unchanged', () => {
    const samples = ['नमस्ते दुनिया', 'مرحبا بالعالم', '你好世界', 'Καλημέρα', '🙏 धन्यवाद 🎉'];
    for (const text of samples) {
        const row = { content: 'x', translations: { hi: { content: text, status: 'ok' } } };
        assert.equal(displayTextFor(row, 'hi'), text);
    }
});
