import test from 'node:test';
import assert from 'node:assert/strict';
import { stripEmoji } from './stripEmoji.js';

test('keeps digits, # and * in brand names', () => {
    assert.equal(stripEmoji('Welcome to 3M #1'), 'Welcome to 3M #1');
    assert.equal(stripEmoji('Sale *terms apply* 2026'), 'Sale *terms apply* 2026');
});

test('removes pictographic emoji and tidies the gap', () => {
    assert.equal(stripEmoji('Hi there 👋'), 'Hi there');
    assert.equal(stripEmoji('👋 Hello 🎉 world'), 'Hello world');
});

test('removes keycap and flag sequences without eating their text', () => {
    assert.equal(stripEmoji('Step 1️⃣ done'), 'Step 1 done');
    assert.equal(stripEmoji('Support 🇮🇳 India'), 'Support India');
});

test('passes through empty and non-string input untouched', () => {
    assert.equal(stripEmoji(''), '');
    assert.equal(stripEmoji(null), null);
    assert.equal(stripEmoji(undefined), undefined);
});
