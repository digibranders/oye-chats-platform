/**
 * Tests for the streaming sentinel stripper.
 *
 * Run with: `node --test src/services/sentinelStripper.test.js`
 * (Node 18+ has a built-in test runner — no vitest/jest dep needed.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSentinelStripper, stripAllSentinels, STREAM_SENTINELS } from './sentinelStripper.js';

// ── stripAllSentinels ────────────────────────────────────────────────────────

test('stripAllSentinels removes LEAVE_MESSAGE_CARD', () => {
    assert.equal(
        stripAllSentinels('Hello [LEAVE_MESSAGE_CARD] world'),
        'Hello  world',
    );
});

test('stripAllSentinels removes MEETING_CARD', () => {
    assert.equal(
        stripAllSentinels('Book here [MEETING_CARD]'),
        'Book here ',
    );
});

test('stripAllSentinels leaves normal text untouched', () => {
    assert.equal(stripAllSentinels('No sentinels here.'), 'No sentinels here.');
});

test('stripAllSentinels removes multiple occurrences', () => {
    assert.equal(
        stripAllSentinels('[LEAVE_MESSAGE_CARD] and [LEAVE_MESSAGE_CARD]'),
        ' and ',
    );
});

test('stripAllSentinels handles empty / null', () => {
    assert.equal(stripAllSentinels(''), '');
    assert.equal(stripAllSentinels(null), '');
    assert.equal(stripAllSentinels(undefined), '');
});

// ── createSentinelStripper — happy paths ────────────────────────────────────

test('stripper releases normal text without buffering', () => {
    const s = createSentinelStripper();
    assert.equal(s.push('Hello '), 'Hello ');
    assert.equal(s.push('world'), 'world');
    assert.equal(s.flush(), '');
});

test('stripper removes a sentinel that arrives in one chunk', () => {
    const s = createSentinelStripper();
    assert.equal(s.push('Here you go [LEAVE_MESSAGE_CARD]'), 'Here you go ');
    assert.equal(s.flush(), '');
});

test('stripper removes a sentinel split across two chunks', () => {
    const s = createSentinelStripper();
    const a = s.push('Tap here [LEAVE_ME');
    const b = s.push('SSAGE_CARD] bye');
    assert.equal(a + b + s.flush(), 'Tap here  bye');
});

test('stripper removes a sentinel split across three chunks', () => {
    const s = createSentinelStripper();
    const a = s.push('Before[LEAVE');
    const b = s.push('_MESSAGE');
    const c = s.push('_CARD]After');
    assert.equal(a + b + c + s.flush(), 'BeforeAfter');
});

test('stripper handles MEETING_CARD split', () => {
    const s = createSentinelStripper();
    const a = s.push('Great — [MEET');
    const b = s.push('ING_CARD]');
    assert.equal(a + b + s.flush(), 'Great — ');
});

// ── createSentinelStripper — edge cases ────────────────────────────────────

test('stripper releases text with a lone [ that never becomes a sentinel', () => {
    const s = createSentinelStripper();
    // "[LEAVE lunch" starts like [LEAVE_MESSAGE_CARD] but diverges —
    // the stripper should eventually release it (on the following push
    // or on flush).
    const a = s.push('You can [LEAVE');
    const b = s.push(' lunch early');
    assert.equal(a + b + s.flush(), 'You can [LEAVE lunch early');
});

test('stripper handles a single [ at stream end (flush releases it)', () => {
    const s = createSentinelStripper();
    assert.equal(s.push('cost is $5 ['), 'cost is $5 ');
    assert.equal(s.flush(), '[');
});

test('stripper does not lose characters when pending overlaps sentinel prefix', () => {
    const s = createSentinelStripper();
    // The "[LEA" tail could be the start of [LEAVE_MESSAGE_CARD].
    // Next chunk "D more" makes it clear it was not — release.
    const a = s.push('Say [LEA');
    const b = s.push('D more');
    assert.equal(a + b + s.flush(), 'Say [LEAD more');
});

test('stripper flush at end of incomplete sentinel releases literal text', () => {
    const s = createSentinelStripper();
    s.push('end with [LEAVE_ME');
    // If the stream ends mid-sentinel, flush releases whatever was held —
    // better to show a partial "[LEAVE_ME" than swallow genuine output.
    assert.equal(s.flush(), '[LEAVE_ME');
});

test('stripper handles multiple sentinels back-to-back', () => {
    const s = createSentinelStripper();
    assert.equal(
        s.push('[MEETING_CARD][LEAVE_MESSAGE_CARD]done'),
        'done',
    );
    assert.equal(s.flush(), '');
});

test('stripper is per-instance (no shared state)', () => {
    const a = createSentinelStripper();
    const b = createSentinelStripper();
    // `a` emits 'A' immediately (safe prefix released) and holds back
    // '[LEAVE_ME' (a sentinel-prefix candidate).
    assert.equal(a.push('A[LEAVE_ME'), 'A');
    // `b` should be completely unaware of `a`'s pending state.
    assert.equal(b.push('plain'), 'plain');
    // Completing the sentinel on `a` — the held prefix + completion get
    // stripped cleanly, leaving nothing to emit.
    assert.equal(a.push('SSAGE_CARD]'), '');
    assert.equal(a.flush(), '');
});

test('stripper handles empty / falsy push', () => {
    const s = createSentinelStripper();
    assert.equal(s.push(''), '');
    assert.equal(s.push(null), '');
    assert.equal(s.push(undefined), '');
    assert.equal(s.flush(), '');
});

// ── No trailing-char latency regression ─────────────────────────────────────

test('stripper does NOT buffer trailing chars that cannot be a sentinel prefix', () => {
    // Regression guard for the old bug where every chunk held back
    // MAX_SENTINEL_LEN-1 chars even when none of them could start a
    // sentinel. Without `[`, hold should be 0.
    const s = createSentinelStripper();
    const chunk = 'Our pricing is $49 per seat per month. No hidden fees.';
    assert.equal(s.push(chunk), chunk);
    assert.equal(s.flush(), '');
});

test('sentinel list is frozen (API stability)', () => {
    assert.ok(Array.isArray(STREAM_SENTINELS));
    assert.ok(Object.isFrozen(STREAM_SENTINELS));
    assert.ok(STREAM_SENTINELS.includes('[LEAVE_MESSAGE_CARD]'));
    assert.ok(STREAM_SENTINELS.includes('[MEETING_CARD]'));
});
