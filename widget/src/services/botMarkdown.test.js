/**
 * Tests for the bot markdown normaliser.
 *
 * Run with: `node --test src/services/botMarkdown.test.js`
 * (Node 18+ has a built-in test runner, no vitest/jest dep needed.)
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatBotMarkdown } from './botMarkdown.js';

// ── The regression: bolded run-on list items ────────────────────────────────
// The LLM emitted two categories glued onto one line with a bold label after
// the inline dash: "...launcher- **Advanced**: ...". The split lookahead used
// to require [A-Z] immediately after "- ", so the leading "**" made it skip the
// boundary and both items rendered as one bullet ("launcher- **Advanced**").

test('splits a bolded two-item run-on list into separate bullets', () => {
    const input =
        '- **Experience**: display name, colors, avatar, launcher- **Advanced**: system prompt, qualification, relevance';
    assert.equal(
        formatBotMarkdown(input),
        '- **Experience**: display name, colors, avatar, launcher\n' +
        '- **Advanced**: system prompt, qualification, relevance',
    );
});

test('splits a bolded three-item run-on list', () => {
    const input = '- **Sales**: pipeline- **Support**: tickets- **Billing**: invoices';
    assert.equal(
        formatBotMarkdown(input),
        '- **Sales**: pipeline\n- **Support**: tickets\n- **Billing**: invoices',
    );
});

test('splits a run-on list whose labels use single-asterisk emphasis', () => {
    const input = '- *One* thing- *Two* things';
    assert.equal(formatBotMarkdown(input), '- *One* thing\n- *Two* things');
});

// ── Existing behaviour must still hold (guard against the fix over-reaching) ──

test('still splits an unbolded run-on list (pre-existing behaviour)', () => {
    const input = '- provenance- Continuous visibility- Pre-configured actions';
    assert.equal(
        formatBotMarkdown(input),
        '- provenance\n- Continuous visibility\n- Pre-configured actions',
    );
});

test('does not split intra-word hyphens (dash followed by lowercase)', () => {
    const input = '- Our stack is state-of-the-art and Multi-region ready';
    assert.equal(formatBotMarkdown(input), input);
});

test('does not split a hyphenated compound like key-based', () => {
    const input = '- Uses key-based auth and role-based access';
    assert.equal(formatBotMarkdown(input), input);
});

// ── Paragraph (non-list) inline bullets ─────────────────────────────────────

test('splits inline bullets inside a paragraph into intro + list', () => {
    const input = 'Here are the areas:- **Sales**- **Support**';
    assert.equal(
        formatBotMarkdown(input),
        'Here are the areas:\n\n- **Sales**\n- **Support**',
    );
});

// ── Untouched adjacent behaviour ────────────────────────────────────────────

test('puts a trailing follow-up question on its own paragraph', () => {
    const input = 'We offer SEO and PPC. Which area interests you?';
    assert.equal(
        formatBotMarkdown(input),
        'We offer SEO and PPC.\n\nWhich area interests you?',
    );
});

test('splits a follow-up glued directly to a sentence with no space (period+opener)', () => {
    const input = 'The migration path is designed to be fast.What matters most for your rollout?';
    assert.equal(
        formatBotMarkdown(input),
        'The migration path is designed to be fast.\n\nWhat matters most for your rollout?',
    );
});

test('does not split a period that is not a glued follow-up (Node.js, no trailing ?)', () => {
    assert.equal(formatBotMarkdown('It runs on Node.js today.'), 'It runs on Node.js today.');
});

test('does not split a glued opener inside a URL', () => {
    const input = 'See https://example.com/v2.Whatever?ref=1 for details.';
    assert.equal(formatBotMarkdown(input), 'See https://example.com/v2.Whatever?ref=1 for details.');
});

test('normalises em-dashes to a comma cadence', () => {
    assert.equal(
        formatBotMarkdown('We offer SEO, including audits'),
        'We offer SEO, including audits',
    );
});

test('breaks a question sentence onto its own paragraph, otherwise leaves prose intact', () => {
    const input = 'Thanks for reaching out. How can I help today?';
    assert.equal(formatBotMarkdown(input), 'Thanks for reaching out.\n\nHow can I help today?');
});

test('passes through empty and nullish input', () => {
    assert.equal(formatBotMarkdown(''), '');
    assert.equal(formatBotMarkdown(null), null);
    assert.equal(formatBotMarkdown(undefined), undefined);
});
