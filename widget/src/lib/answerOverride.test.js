import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyAnswerOverride } from './answerOverride.js';

const ESCALATION =
    'Pricing for **SOC** at **Acme** is best confirmed by the team so you get an accurate figure. Want me to connect you with them now?';
const USER = { id: 1, sender: 'user', text: 'what is th picin for SOC' };
const STREAMED = {
    id: 2,
    sender: 'bot',
    text: 'SOC as a Service starts at \n\n' + ESCALATION,
    feedback: null,
    media_card: { type: 'download', url: 'https://acme.com/soc.pdf' },
};

test('the streamed bubble shows the text the server persisted, keeping what it carries', () => {
    const messages = [USER, STREAMED];

    const next = applyAnswerOverride(messages, 2, { answer_override: ESCALATION, message_id: 77 });

    assert.equal(next[0], USER);
    assert.deepEqual(next[1], { ...STREAMED, text: ESCALATION });
    assert.equal(messages[1].text, STREAMED.text, 'the input is not mutated');
});

test('the override is shown as the server sent it', () => {
    // The server persists the replacement with its sentinels already stripped
    // (tests/test_price_guard_pipeline.py pins that for every replacement).
    const text = 'Leave us a message and the team will reply.\n\nAnything else?';
    const next = applyAnswerOverride([STREAMED], 2, { answer_override: text });
    assert.equal(next[0].text, text);
});

test('a frame without a usable override returns the same list, so nothing re-renders', () => {
    const messages = [USER, STREAMED];
    for (const meta of [
        undefined,
        null,
        {},
        { answer_override: null },
        { answer_override: 42 },
        { answer_override: '' },
        { answer_override: '   \n' },
    ]) {
        assert.equal(applyAnswerOverride(messages, 2, meta), messages, JSON.stringify(meta));
    }
});

test('no other message is touched when no message has the id', () => {
    const messages = [USER, STREAMED];
    assert.deepEqual(applyAnswerOverride(messages, 99, { answer_override: ESCALATION }), messages);
});
