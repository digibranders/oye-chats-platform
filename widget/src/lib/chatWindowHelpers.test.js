/**
 * These helpers spent their life inside ChatWindow.jsx, where nothing could
 * reach them: the widget has no DOM test harness, so anything declared in a
 * component file is untestable by construction. Two of them were wrong in ways
 * a single assertion would have caught.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    FALLBACK_PATTERNS,
    getInitials,
    HANDOFF_INVITATION_TAIL_RE,
    isBotFallback,
    isSystemMessage,
    looksLikeEmail,
    relativeTimeLabel,
    resolveEscape,
    sanitizeMarkdown,
    SYSTEM_MSG,
    TRAILING_QUESTION_TAIL_RE,
} from './chatWindowHelpers.js';

test('isBotFallback: recognises the phrasings that trigger a human offer', () => {
    assert.ok(isBotFallback("I don't have that specific information."));
    assert.ok(isBotFallback("I'm not sure about that, sorry."));
    assert.ok(isBotFallback("I couldn't find any specific information on that."));
    assert.ok(isBotFallback('That is not contained in the documents I have.'));
});

test('isBotFallback: a real answer is not a fallback', () => {
    assert.equal(isBotFallback('We open at nine and close at five.'), false);
    assert.equal(isBotFallback('Our pricing starts at 449 a month.'), false);
});

test('isBotFallback: empty and missing input do not throw', () => {
    assert.equal(isBotFallback(''), false);
    assert.equal(isBotFallback(undefined), false);
    assert.equal(isBotFallback(null), false);
});

test('FALLBACK_PATTERNS is the regex that actually ran', () => {
    // Two copies existed. The exported one was dead; the live one inside
    // checkBotFallback required "specific" in two alternatives. Keeping the
    // live one means this narrower case stays a non-match, which is the
    // pre-existing behaviour and not something to widen by accident.
    assert.equal(FALLBACK_PATTERNS.test("I couldn't find information on that"), false);
    assert.ok(FALLBACK_PATTERNS.test("I couldn't find specific information on that"));
});

test('sanitizeMarkdown: strips the token a cut-off stream leaves behind', () => {
    assert.equal(sanitizeMarkdown('Here is **important'), 'Here is **important'.replace(/\*{1,2}$/, '').trim());
    assert.equal(sanitizeMarkdown('Here is the answer**'), 'Here is the answer');
    assert.equal(sanitizeMarkdown('emphasis_'), 'emphasis');
    assert.equal(sanitizeMarkdown('code`'), 'code');
});

test('sanitizeMarkdown: leaves a complete message alone', () => {
    assert.equal(sanitizeMarkdown('**Bold** and done.'), '**Bold** and done.');
    assert.equal(sanitizeMarkdown(''), '');
});

test('getInitials: two words, one word, and none', () => {
    assert.equal(getInitials('Ada Lovelace'), 'AL');
    assert.equal(getInitials('Prince'), 'P');
    assert.equal(getInitials(''), '?');
    assert.equal(getInitials(undefined), '?');
    assert.equal(getInitials('   '), '?');
});

test('getInitials: a name outside the Latin alphabet still yields initials', () => {
    // Array.from, not [0]: a surrogate pair sliced by index is a broken glyph.
    assert.equal(getInitials('日向 翔陽'), '日翔');
    assert.equal(getInitials('Ólafur Arnalds'), 'ÓA');
});

test('getInitials: only the first two words count', () => {
    assert.equal(getInitials('Jean Claude Van Damme'), 'JC');
});

test('looksLikeEmail', () => {
    assert.ok(looksLikeEmail('a@b.co'));
    assert.equal(looksLikeEmail('a@b'), false);
    assert.equal(looksLikeEmail('a b@c.com'), false);
    assert.equal(looksLikeEmail(''), false);
});

test('isSystemMessage matches on identity, not on rendered copy', () => {
    // The whole point of systemId: comparing m.text to an English string
    // silently stopped matching the moment the copy was translated.
    assert.ok(isSystemMessage({ type: 'system', systemId: 'connecting' }, SYSTEM_MSG.CONNECTING));
    assert.equal(isSystemMessage({ type: 'system', text: 'Connecting…' }, SYSTEM_MSG.CONNECTING), false);
    assert.equal(isSystemMessage({ type: 'bot', systemId: 'connecting' }, SYSTEM_MSG.CONNECTING), false);
});

test('HANDOFF_INVITATION_TAIL_RE peels only the trailing invitation', () => {
    const text = 'We offer three plans. Would you like me to connect you with the team?';
    assert.equal(text.replace(HANDOFF_INVITATION_TAIL_RE, ''), 'We offer three plans.');
});

test('HANDOFF_INVITATION_TAIL_RE leaves an answer with no invitation intact', () => {
    const text = 'We offer three plans.';
    assert.equal(text.replace(HANDOFF_INVITATION_TAIL_RE, ''), text);
});

test('TRAILING_QUESTION_TAIL_RE keeps earlier sentences', () => {
    const text = 'Our hours are nine to five. Want the pricing too?';
    assert.equal(text.replace(TRAILING_QUESTION_TAIL_RE, ''), 'Our hours are nine to five.');
});

test('relativeTimeLabel: each bucket', () => {
    const t = (key, params) => `${key}:${params?.count ?? ''}`;
    const now = 1_000_000_000_000;
    assert.equal(relativeTimeLabel(now - 30_000, t, now), 'header.time_just_now:');
    assert.equal(relativeTimeLabel(now - 5 * 60_000, t, now), 'header.time_minutes_ago:5');
    assert.equal(relativeTimeLabel(now - 3 * 3_600_000, t, now), 'header.time_hours_ago:3');
    assert.equal(relativeTimeLabel(now - 2 * 86_400_000, t, now), 'header.time_days_ago:2');
});

test('relativeTimeLabel: a missing or future timestamp renders nothing', () => {
    const t = () => 'x';
    assert.equal(relativeTimeLabel(0, t), '');
    assert.equal(relativeTimeLabel(undefined, t), '');
    assert.equal(relativeTimeLabel(NaN, t), '');
});

test('relativeTimeLabel falls back to English when the key is missing', () => {
    const t = () => null;
    const now = 1_000_000_000_000;
    assert.equal(relativeTimeLabel(now - 5 * 60_000, t, now), '5m ago');
    assert.equal(relativeTimeLabel(now - 30_000, t, now), 'Just now');
});

test('escape closes the conversations drawer before it closes the panel', () => {
    assert.equal(resolveEscape({ drawerOpen: true, overlayOpen: false }), 'drawer');
    assert.equal(resolveEscape({ drawerOpen: true, overlayOpen: true }), 'overlay');
});

test('escape is owned by a stacked overlay when one is open', () => {
    assert.equal(resolveEscape({ drawerOpen: false, overlayOpen: true }), 'overlay');
});

test('escape closes the panel only when nothing is stacked on it', () => {
    assert.equal(resolveEscape({ drawerOpen: false, overlayOpen: false }), 'panel');
});
