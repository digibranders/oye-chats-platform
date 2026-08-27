import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_MODES, VALID_TRANSITIONS, isInvalidTransition, nextChatMode } from './chatModeMachine.js';

// ── The bug this file exists for ─────────────────────────────────────────────

test('a late operator accept rescues a visitor already shown the offline form', () => {
    // The queue timeout (20s by default) pushes the visitor to `unavailable`
    // and renders the "Leave a message" form. An operator accepting a moment
    // later makes the server send `status: connected`. Before the fix this
    // transition was refused, so the visitor watched "<operator> joined the
    // chat" appear above an offline form with no composer to reply in.
    assert.equal(nextChatMode('unavailable', 'live'), 'live');
});

test('an accept landing during the availability re-check is not dropped', () => {
    // Same race, narrower window: `connecting` is the ~10s state after a
    // handoff submission, and a fast accept can land inside it.
    assert.equal(nextChatMode('connecting', 'live'), 'live');
});

test('every non-terminal mode can reach live', () => {
    // `status: connected` is server truth - the session is already `live` in
    // the database with an operator assigned. No client state may refuse it.
    for (const mode of CHAT_MODES) {
        if (mode === 'live') continue;
        assert.equal(nextChatMode(mode, 'live'), 'live', `${mode} → live must be allowed`);
    }
});

// ── Everything that must NOT have changed ────────────────────────────────────

test('the normal handoff path still works end to end', () => {
    let mode = 'bot';
    mode = nextChatMode(mode, 'connecting');
    assert.equal(mode, 'connecting');
    mode = nextChatMode(mode, 'waiting');
    assert.equal(mode, 'waiting');
    mode = nextChatMode(mode, 'live');
    assert.equal(mode, 'live');
    mode = nextChatMode(mode, 'bot'); // visitor ends the chat
    assert.equal(mode, 'bot');
});

test('the queue-timeout path still works', () => {
    let mode = nextChatMode('bot', 'connecting');
    mode = nextChatMode(mode, 'waiting');
    mode = nextChatMode(mode, 'unavailable');
    assert.equal(mode, 'unavailable');
    // And the offline form can still return the visitor to the AI.
    assert.equal(nextChatMode(mode, 'bot'), 'bot');
});

test('the leave-message CTA still drops straight from bot to the offline form', () => {
    assert.equal(nextChatMode('bot', 'unavailable'), 'unavailable');
});

test('the operator connect-request flow still promotes bot straight to live', () => {
    assert.equal(nextChatMode('bot', 'live'), 'live');
});

test('genuinely invalid transitions are still refused', () => {
    // A live chat must not silently rewind into the queue, and the offline
    // form must not jump to `connecting` or `waiting` on its own.
    assert.equal(nextChatMode('live', 'waiting'), 'live');
    assert.equal(nextChatMode('live', 'connecting'), 'live');
    assert.equal(nextChatMode('unavailable', 'waiting'), 'unavailable');
    assert.equal(nextChatMode('unavailable', 'connecting'), 'unavailable');
    assert.equal(nextChatMode('waiting', 'connecting'), 'waiting');
});

// ── Guard behaviour ──────────────────────────────────────────────────────────

test('a self-transition is a no-op, not an invalid transition', () => {
    // A reconnect replaying `status: connected` must not log a warning.
    for (const mode of CHAT_MODES) {
        assert.equal(nextChatMode(mode, mode), mode);
        assert.equal(isInvalidTransition(mode, mode), false, `${mode} → ${mode} should be silent`);
    }
});

test('isInvalidTransition agrees with nextChatMode', () => {
    for (const from of CHAT_MODES) {
        for (const to of CHAT_MODES) {
            const applied = nextChatMode(from, to);
            if (isInvalidTransition(from, to)) {
                assert.equal(applied, from, `${from} → ${to} refused, so mode must not change`);
            } else {
                assert.equal(applied, to, `${from} → ${to} allowed, so mode must change`);
            }
        }
    }
});

test('an unknown mode never throws and never changes state', () => {
    assert.equal(nextChatMode('bogus', 'live'), 'bogus');
    assert.equal(nextChatMode('bot', 'bogus'), 'bot');
    assert.equal(isInvalidTransition('bogus', 'live'), true);
});

// ── Table integrity ──────────────────────────────────────────────────────────

test('every target in the table is a real mode', () => {
    for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
        for (const to of targets) {
            assert.ok(CHAT_MODES.includes(to), `${from} → ${to} names a mode that does not exist`);
        }
        assert.ok(!targets.includes(from), `${from} lists itself; self-transitions are handled separately`);
        assert.equal(new Set(targets).size, targets.length, `${from} has duplicate targets`);
    }
});

test('every mode can get back to bot, so no state is a dead end', () => {
    for (const mode of CHAT_MODES) {
        if (mode === 'bot') continue;
        assert.ok(VALID_TRANSITIONS[mode].includes('bot'), `${mode} cannot return to the AI chat`);
    }
});
