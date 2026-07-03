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

// ── CTA marker (dynamic [CTA:dimension] sentinel) ──────────────────────────

test('stripAllSentinels removes [CTA:dimension]', () => {
    assert.equal(
        stripAllSentinels('What is your timeline? [CTA:timeline]'),
        'What is your timeline? ',
    );
});

test('stripAllSentinels removes multiple CTA markers and other sentinels', () => {
    assert.equal(
        stripAllSentinels('A [CTA:budget] B [LEAVE_MESSAGE_CARD] C [CTA:authority] D'),
        'A  B  C  D',
    );
});

test('stripper removes [CTA:timeline] arriving in one chunk', () => {
    const s = createSentinelStripper();
    assert.equal(s.push('Pick a timeframe [CTA:timeline]'), 'Pick a timeframe ');
    assert.equal(s.flush(), '');
});

test('stripper removes [CTA:dimension] split across chunks', () => {
    const s = createSentinelStripper();
    const a = s.push('Tell me your range [CTA:bud');
    const b = s.push('get]');
    assert.equal(a + b + s.flush(), 'Tell me your range ');
});

test('stripper holds back CTA prefix until closing bracket arrives', () => {
    const s = createSentinelStripper();
    // After "[CTA:" the body is open — must hold until the next chunk.
    const a = s.push('Pick a slot [CTA:');
    assert.equal(a, 'Pick a slot ');
    const b = s.push('timeline]');
    assert.equal(b, '');
    assert.equal(s.flush(), '');
});

test('stripper releases [CTA: literal when stream ends mid-marker', () => {
    const s = createSentinelStripper();
    s.push('aborted [CTA:tim');
    // Mid-marker abort — better to surface the partial than swallow real text.
    assert.equal(s.flush(), '[CTA:tim');
});

// ── Media card markers (dynamic [YOUTUBE_CARD:id] / [DOWNLOAD_CARD:url|name])

test('stripAllSentinels removes [YOUTUBE_CARD:id]', () => {
    assert.equal(
        stripAllSentinels('Here is a video overview. [YOUTUBE_CARD:dQw4w9WgXcQ]'),
        'Here is a video overview. ',
    );
});

test('stripAllSentinels removes [DOWNLOAD_CARD:url|name]', () => {
    assert.equal(
        stripAllSentinels(
            "Here's our brochure. [DOWNLOAD_CARD:https://example.com/brochure.pdf|brochure.pdf]",
        ),
        "Here's our brochure. ",
    );
});

test('stripAllSentinels removes YOUTUBE_CARD mixed with CTA and MEETING_CARD', () => {
    assert.equal(
        stripAllSentinels(
            'Sure. [YOUTUBE_CARD:abcDEF12345] [CTA:timeline] [MEETING_CARD]',
        ),
        'Sure.   ',
    );
});

test('stripper removes [YOUTUBE_CARD:id] arriving in one chunk', () => {
    const s = createSentinelStripper();
    assert.equal(
        s.push('Watch this: [YOUTUBE_CARD:abcDEF-_123]'),
        'Watch this: ',
    );
    assert.equal(s.flush(), '');
});

test('stripper removes [YOUTUBE_CARD:id] split across chunks', () => {
    const s = createSentinelStripper();
    const a = s.push('Watch this: [YOUTUBE_CARD:abc');
    const b = s.push('DEF-_123]');
    assert.equal(a + b + s.flush(), 'Watch this: ');
});

test('stripper holds YOUTUBE_CARD prefix until closing bracket arrives', () => {
    const s = createSentinelStripper();
    const a = s.push('Video: [YOUTUBE_CARD:');
    assert.equal(a, 'Video: ');
    const b = s.push('dQw4w9WgXcQ]');
    assert.equal(b, '');
    assert.equal(s.flush(), '');
});

test('stripper removes [DOWNLOAD_CARD:url|name] arriving in one chunk', () => {
    const s = createSentinelStripper();
    assert.equal(
        s.push('Grab this: [DOWNLOAD_CARD:https://example.com/x.pdf|x.pdf]'),
        'Grab this: ',
    );
    assert.equal(s.flush(), '');
});

test('stripper removes [DOWNLOAD_CARD:url|name] split across chunks', () => {
    const s = createSentinelStripper();
    const a = s.push('Grab this: [DOWNLOAD_CARD:https://example.com/x.p');
    const b = s.push('df|brochure.pdf]');
    assert.equal(a + b + s.flush(), 'Grab this: ');
});

test('stripper does not swallow real text after an aborted YOUTUBE_CARD prefix', () => {
    const s = createSentinelStripper();
    // Mid-marker abort — surface the partial so nothing legitimate is lost.
    s.push('aborted [YOUTUBE_CARD:xyz');
    assert.equal(s.flush(), '[YOUTUBE_CARD:xyz');
});

// ── LLM-invented placeholder brackets — general rule, no keyword blocklist

test('strips [YouTube card below] placeholder', () => {
    assert.equal(
        stripAllSentinels('Watch this. [YouTube card below] Which topic?'),
        'Watch this.  Which topic?',
    );
});

test('strips [Video preview here] placeholder', () => {
    assert.equal(
        stripAllSentinels('See our overview. [Video preview here] More info soon.'),
        'See our overview.  More info soon.',
    );
});

test('strips [Card: ...] placeholder', () => {
    assert.equal(
        stripAllSentinels('Overview text. [Card: episode video] Continue.'),
        'Overview text.  Continue.',
    );
});

test('strips novel placeholder that no keyword list would predict', () => {
    // Proves the rule is general: any [...] not followed by ( is stripped,
    // regardless of what phrasing the LLM invents tomorrow.
    assert.equal(
        stripAllSentinels('Sure. [See attached PDF below] Anything else?'),
        'Sure.  Anything else?',
    );
    assert.equal(
        stripAllSentinels('Note. [TBD] End.'),
        'Note.  End.',
    );
    assert.equal(
        stripAllSentinels('Note. [i just made this up] End.'),
        'Note.  End.',
    );
});

test('PRESERVES markdown links — [label](url) untouched', () => {
    // The general rule MUST keep real markdown links intact — the
    // negative lookahead (?!\() is the whole reason this works.
    const md = 'Read [our pricing page](https://example.com/pricing) for details.';
    assert.equal(stripAllSentinels(md), md);
});

test('PRESERVES real sentinels — they are stripped by their own patterns first', () => {
    // Real sentinels are stripped by their specific patterns EARLIER
    // in stripAllSentinels; by the time the general bracket sweep
    // runs, they're already gone. The general sweep must not
    // reintroduce a regression that damages a valid sentinel input.
    assert.equal(
        stripAllSentinels('Ok [YOUTUBE_CARD:dQw4w9WgXcQ]'),
        'Ok ',
    );
    assert.equal(
        stripAllSentinels('Ok [MEETING_CARD]'),
        'Ok ',
    );
    assert.equal(
        stripAllSentinels('Ok [CTA:timeline]'),
        'Ok ',
    );
});

test('does not fire on empty brackets', () => {
    // Regex requires 1-300 chars inside the brackets; empty [] is left
    // alone (unlikely from an LLM but cheap to guard against).
    assert.equal(stripAllSentinels('hello [] world'), 'hello [] world');
});

test('handles mixed placeholder + markdown link in one string', () => {
    const input = 'Watch this. [YouTube card below] See our [pricing](https://x.com) for details.';
    assert.equal(
        stripAllSentinels(input),
        'Watch this.  See our [pricing](https://x.com) for details.',
    );
});
