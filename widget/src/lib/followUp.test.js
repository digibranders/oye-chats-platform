import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTrailingFollowUp } from './followUp.js';

test('splits a trailing follow-up question off the answer', () => {
    const { body, followUp } = splitTrailingFollowUp(
        'CleanStart hardens container images.\n\nWhat matters most for you right now?'
    );
    assert.equal(body, 'CleanStart hardens container images.');
    assert.equal(followUp, 'What matters most for you right now?');
});

test('a reply that does not end in a question is left whole', () => {
    const text = 'CleanStart hardens container images.\n\nIt also signs provenance.';
    const { body, followUp } = splitTrailingFollowUp(text);
    assert.equal(body, text);
    assert.equal(followUp, '');
});

test('a reply with no paragraph break is left whole', () => {
    const text = 'What matters most for you right now?';
    const { body, followUp } = splitTrailingFollowUp(text);
    assert.equal(body, text);
    assert.equal(followUp, '');
});

test('a multi-line final paragraph is answer text, not a probe', () => {
    const text = 'Intro.\n\nWe cover:\nimages and libraries. Which one?';
    const { body, followUp } = splitTrailingFollowUp(text);
    assert.equal(body, text);
    assert.equal(followUp, '');
});

test('a long final paragraph is answer text even when it ends in a question', () => {
    const long = 'A'.repeat(170) + '?';
    const { body, followUp } = splitTrailingFollowUp('Intro.\n\n' + long);
    assert.equal(followUp, '');
    assert.equal(body, 'Intro.\n\n' + long);
});

test('a list item is structure, never the follow-up', () => {
    for (const marker of ['- ', '* ', '+ ', '> ', '# ', '1. ', '2) ']) {
        const text = `Intro.\n\n${marker}Is this one?`;
        const { followUp } = splitTrailingFollowUp(text);
        assert.equal(followUp, '', `marker ${JSON.stringify(marker)} must not split`);
    }
});

test('keeps only the LAST paragraph when several are present', () => {
    const { body, followUp } = splitTrailingFollowUp(
        'One.\n\nTwo.\n\nWhich would you like to explore first?'
    );
    assert.equal(body, 'One.\n\nTwo.');
    assert.equal(followUp, 'Which would you like to explore first?');
});

test('trailing whitespace does not defeat the split', () => {
    const { followUp } = splitTrailingFollowUp('Answer.\n\nWhat is your timeline?   \n\n  ');
    assert.equal(followUp, 'What is your timeline?');
});

test('empty and nullish input are safe', () => {
    for (const value of ['', null, undefined]) {
        const { body, followUp } = splitTrailingFollowUp(value);
        assert.equal(followUp, '');
        assert.equal(body, value);
    }
});

test('a bolded question still splits (markdown is preserved verbatim)', () => {
    const { body, followUp } = splitTrailingFollowUp(
        'We support **Helm Charts**.\n\nWhat are you looking to cover **first**?'
    );
    assert.equal(body, 'We support **Helm Charts**.');
    assert.equal(followUp, 'What are you looking to cover **first**?');
});
