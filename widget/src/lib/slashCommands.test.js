/**
 * Tests for the visitor-facing slash-command parser (slashCommands.js).
 *
 * The parser governs whether Enter intercepts execution vs. sends a message,
 * which command the `/` popover shows, and how autocomplete splices text. All
 * pure string logic, but with subtle edge cases (mid-sentence slashes, URLs,
 * caret math) that are easy to regress.
 *
 * Run with: `node --test src/lib/slashCommands.test.js`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SLASH_COMMANDS,
    matchSlashCommand,
    findActiveSlashToken,
    filterSlashCommands,
    autocompleteSlashCommand,
} from './slashCommands.js';

// ── matchSlashCommand: exact whole-input match only ───────────────────────────

test('matchSlashCommand matches an exact /<name>, case-insensitively', () => {
    assert.equal(matchSlashCommand('/human')?.name, 'human');
    assert.equal(matchSlashCommand('/HUMAN')?.name, 'human');
    assert.equal(matchSlashCommand('  /new  ')?.name, 'new'); // trimmed
    assert.equal(matchSlashCommand('/clear')?.name, 'clear');
});

test('matchSlashCommand refuses mid-sentence slashes so text is never dropped', () => {
    // "hello /human" pressing Enter must SEND, not execute. Surrounding text
    // would otherwise be silently discarded.
    assert.equal(matchSlashCommand('hello /human'), null);
    assert.equal(matchSlashCommand('/human now'), null);
    assert.equal(matchSlashCommand('and/or'), null);
});

test('matchSlashCommand returns null for unknown commands and non-strings', () => {
    assert.equal(matchSlashCommand('/nope'), null);
    assert.equal(matchSlashCommand('/'), null);
    assert.equal(matchSlashCommand(''), null);
    assert.equal(matchSlashCommand(undefined), null);
    assert.equal(matchSlashCommand(null), null);
});

// ── findActiveSlashToken: locate the last orphan slash token ───────────────────

test('findActiveSlashToken finds a leading slash token', () => {
    assert.deepEqual(findActiveSlashToken('/hu'), { start: 0, end: 3, query: 'hu' });
    assert.deepEqual(findActiveSlashToken('/'), { start: 0, end: 1, query: '' });
});

test('findActiveSlashToken finds a token after whitespace, using the LAST one', () => {
    const t = findActiveSlashToken('talk to /cl');
    assert.deepEqual(t, { start: 8, end: 11, query: 'cl' });
    // Two tokens: the later one wins.
    const t2 = findActiveSlashToken('/new then /hu');
    assert.equal(t2.query, 'hu');
    assert.equal(t2.start, 10);
});

test('findActiveSlashToken ignores slashes inside URLs and words', () => {
    // Leading-whitespace guard: https:// and and/or must not open the popover.
    assert.equal(findActiveSlashToken('see https://x.example'), null);
    assert.equal(findActiveSlashToken('and/or maybe'), null);
    assert.equal(findActiveSlashToken('plain text'), null);
    assert.equal(findActiveSlashToken(''), null);
    assert.equal(findActiveSlashToken(null), null);
});

// ── filterSlashCommands: registry filtering by active token ───────────────────

test('filterSlashCommands returns the full list for a bare slash', () => {
    assert.equal(filterSlashCommands('/').length, SLASH_COMMANDS.length);
});

test('filterSlashCommands narrows by prefix', () => {
    const names = filterSlashCommands('/n').map((c) => c.name);
    assert.deepEqual(names, ['new']);
    assert.deepEqual(filterSlashCommands('/h').map((c) => c.name), ['human']);
    assert.deepEqual(filterSlashCommands('/xyz'), []); // no prefix match
});

test('filterSlashCommands returns empty when there is no slash token', () => {
    assert.deepEqual(filterSlashCommands('hello'), []);
    assert.deepEqual(filterSlashCommands(''), []);
});

// ── autocompleteSlashCommand: splice /<name> at the active token ───────────────

test('autocompleteSlashCommand replaces the active token and reports the caret', () => {
    const human = SLASH_COMMANDS.find((c) => c.name === 'human');
    // Replace a partial leading token.
    assert.deepEqual(autocompleteSlashCommand('/hu', human), { value: '/human', caret: 6 });
    // Preserve surrounding text, replace only the token.
    const res = autocompleteSlashCommand('please /cl', SLASH_COMMANDS.find((c) => c.name === 'clear'));
    assert.deepEqual(res, { value: 'please /clear', caret: 13 });
});

test('autocompleteSlashCommand returns null when there is no token to replace', () => {
    const human = SLASH_COMMANDS.find((c) => c.name === 'human');
    assert.equal(autocompleteSlashCommand('hello', human), null);
    assert.equal(autocompleteSlashCommand('https://x.example', human), null);
});

// ── isAvailable predicates: fresh-chat gating ─────────────────────────────────

test('isAvailable hides /new and /clear on a fresh transcript, /human always shows', () => {
    const byName = Object.fromEntries(SLASH_COMMANDS.map((c) => [c.name, c]));
    // Fresh chat: no user messages yet.
    assert.equal(byName.new.isAvailable({ userMessageCount: 0 }), false);
    assert.equal(byName.clear.isAvailable({ userMessageCount: 0 }), false);
    assert.equal(byName.human.isAvailable({ userMessageCount: 0 }), true);
    // After the visitor has said something.
    assert.equal(byName.new.isAvailable({ userMessageCount: 1 }), true);
    assert.equal(byName.clear.isAvailable({ userMessageCount: 3 }), true);
    // Missing context defaults to hidden for the gated commands.
    assert.equal(byName.new.isAvailable(undefined), false);
    assert.equal(byName.human.isAvailable(undefined), true);
});
