import test from 'node:test';
import assert from 'node:assert/strict';

// `services/api.js` reads `window` at import time and nothing else at module
// scope, so it loads under plain node once a stub global exists. No test
// covered `sendMessageStream` before this file.
globalThis.window = globalThis.window || {};
globalThis.window.OYECHATS_BOT_KEY = 'bot-test';

const { sendMessageStream, isAbortError } = await import('./api.js');

// ── Fetch doubles ────────────────────────────────────────────────────────────

const streamOf = (chunks) => {
    const encoder = new TextEncoder();
    let i = 0;
    return {
        getReader: () => ({
            read: async () =>
                i < chunks.length
                    ? { done: false, value: encoder.encode(chunks[i++]) }
                    : { done: true, value: undefined },
            cancel: async () => {},
        }),
    };
};

const withFetch = async (impl, run) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    // The module logs failures through console.error; keep the test output clean.
    const originalError = console.error;
    console.error = () => {};
    try {
        return await run();
    } finally {
        globalThis.fetch = original;
        console.error = originalError;
    }
};

const collect = async (fetchImpl, extra = {}) => {
    const chunks = [];
    const errors = [];
    let threw = null;
    await withFetch(fetchImpl, async () => {
        try {
            await sendMessageStream('hello', 'sess-1', {
                onChunk: (text) => chunks.push(text),
                onError: (err) => errors.push(err),
                ...extra,
            });
        } catch (err) {
            threw = err;
        }
    });
    return { chunks, errors, threw };
};

// ── W1: one error, one message ───────────────────────────────────────────────

test('a handled stream error is flagged so the caller renders it once', async () => {
    // The bug: `onError` renders a friendly message, then the rethrow lands in
    // ChatWindow's outer catch which appends a second, generic bubble. Out of
    // credits showed "We're temporarily over capacity" immediately followed by
    // "I'm sorry, I couldn't generate a response." One failure, two
    // contradictory answers.
    const { errors, threw } = await collect(async () => ({ ok: false, status: 402 }));

    assert.equal(errors.length, 1, 'onError still fires — the caller owns the copy');
    assert.equal(errors[0].code, 'over_capacity');
    assert.ok(threw, 'the error still propagates so the caller unwinds');
    assert.equal(threw.handled, true, 'the outer catch must be able to see it was already rendered');
});

test('every reported status carries the handled flag', async () => {
    for (const status of [402, 429, 503, 500]) {
        const { threw } = await collect(async () => ({ ok: false, status }));
        assert.equal(threw.handled, true, `status ${status} was rethrown unflagged`);
    }
});

test('a mid-stream failure is flagged too, not just a bad response status', async () => {
    const { errors, threw } = await collect(async () => ({
        ok: true,
        body: {
            getReader: () => ({
                read: async () => { throw new Error('connection reset'); },
                cancel: async () => {},
            }),
        },
    }));

    assert.equal(errors.length, 1);
    assert.equal(threw.handled, true);
});

test('nothing is flagged when the caller passed no onError', async () => {
    // `handled` means "somebody already showed the visitor a message". With no
    // onError nobody did, so the caller's own catch must still render.
    let threw = null;
    await withFetch(async () => ({ ok: false, status: 402 }), async () => {
        try {
            await sendMessageStream('hello', 'sess-1', {});
        } catch (err) {
            threw = err;
        }
    });
    assert.ok(threw);
    assert.notEqual(threw.handled, true);
});

// ── W2: HTTP 429 ─────────────────────────────────────────────────────────────

test('429 gets its own visitor-facing message, not "Network response was not ok"', async () => {
    // The chat limiter is 30/minute. A visitor typing quickly used to fall
    // through to the generic branch and be told the bot was broken.
    const { errors } = await collect(async () => ({ ok: false, status: 429 }));

    assert.equal(errors.length, 1);
    const err = errors[0];
    assert.equal(err.status, 429);
    assert.equal(err.code, 'rate_limited');
    assert.notEqual(err.message, 'Network response was not ok');
    assert.match(err.message, /quickly/i);
});

test('429 keeps the shape 402 and 503 already had, so one handler covers all three', async () => {
    const codes = {};
    for (const status of [402, 429, 503]) {
        const { errors } = await collect(async () => ({ ok: false, status }));
        codes[status] = { status: errors[0].status, code: errors[0].code };
    }
    assert.deepEqual(codes, {
        402: { status: 402, code: 'over_capacity' },
        429: { status: 429, code: 'rate_limited' },
        503: { status: 503, code: 'maintenance' },
    });
});

test('an unmapped status still falls through to the generic error', async () => {
    const { errors } = await collect(async () => ({ ok: false, status: 500 }));
    assert.equal(errors[0].message, 'Network response was not ok');
    assert.equal(errors[0].status, undefined);
});

// ── W3: abort ────────────────────────────────────────────────────────────────

test('the caller\'s AbortSignal reaches fetch', async () => {
    // Without it, closing the widget left the request and the generation behind
    // it running — a backend concurrency slot held for up to 60s on behalf of a
    // visitor who had already gone.
    const controller = new AbortController();
    let seenSignal;
    await withFetch(async (_url, options) => {
        seenSignal = options.signal;
        return { ok: true, body: streamOf(['METADATA:{"session_id":"s"}\n', 'hi']) };
    }, () => sendMessageStream('hello', 'sess-1', { signal: controller.signal }));

    assert.equal(seenSignal, controller.signal);
});

test('an abort reports nothing to the visitor', async () => {
    // An abort is something we asked for. Reporting it would render "I couldn't
    // generate a response" over a widget the visitor just closed.
    const abortError = new Error('The user aborted a request.');
    abortError.name = 'AbortError';

    const { errors, threw } = await collect(async () => { throw abortError; });

    assert.equal(errors.length, 0, 'onError must not fire for a deliberate cancellation');
    assert.equal(threw, abortError, 'it still rethrows so the caller unwinds');
    assert.notEqual(threw.handled, true);
    assert.ok(isAbortError(threw));
});

test('isAbortError recognises abort rejections without misreading real failures', () => {
    // `AbortController` rejects with a DOMException whose name is 'AbortError'
    // in every browser the widget targets — the name is the contract.
    const domLike = new Error('aborted');
    domLike.name = 'AbortError';
    assert.ok(isAbortError(domLike));

    assert.equal(isAbortError(new Error('connection reset')), false);
    assert.equal(isAbortError({ name: 'TypeError' }), false);
    assert.equal(isAbortError(undefined), false);
    assert.equal(isAbortError(null), false);
});

test('omitting the signal keeps fetch options untouched', async () => {
    let options;
    await withFetch(async (_url, opts) => {
        options = opts;
        return { ok: true, body: streamOf(['METADATA:{"session_id":"s"}\n', 'hi']) };
    }, () => sendMessageStream('hello', 'sess-1', {}));

    assert.ok(!('signal' in options), 'no signal must not become signal: undefined');
});

// ── Guardrail: the happy path still streams ──────────────────────────────────

test('a normal stream still delivers its text and final metadata', async () => {
    const finals = [];
    const { chunks } = await collect(
        async () => ({
            ok: true,
            body: streamOf([
                'METADATA:{"session_id":"s"}\n',
                'Hello ',
                'there',
                '\nFINAL_METADATA:{"message_id":7}\n',
            ]),
        }),
        { onFinalMetadata: (meta) => finals.push(meta) },
    );

    assert.equal(chunks.join('').trim(), 'Hello there');
    assert.deepEqual(finals, [{ message_id: 7 }]);
});

// ── W1 (2026-09 audit): terminal frame split inside the marker ───────────────

test('a FINAL_METADATA frame split mid-marker still parses and never renders', async () => {
    // The bug: the partial-flush guard only recognised a COMPLETE marker, so a
    // read boundary inside the first 15 bytes (e.g. "FINAL_") emitted the
    // fragment as answer text and left the JSON behind it to be parsed as an
    // ordinary line. onFinalMetadata never fired: no message id, no feedback
    // buttons, no CTA, and raw JSON on screen.
    const terminal = 'FINAL_METADATA:{"message_id":7}\n';

    for (let split = 1; split < terminal.length; split++) {
        const finals = [];
        const { chunks } = await collect(
            async () => ({
                ok: true,
                body: streamOf([
                    'METADATA:{"session_id":"s"}\n',
                    'Hello ',
                    'there\n',
                    terminal.slice(0, split),
                    terminal.slice(split),
                ]),
            }),
            { onFinalMetadata: (meta) => finals.push(meta) },
        );

        const rendered = chunks.join('');
        assert.equal(rendered.trim(), 'Hello there', `split at ${split} rendered ${JSON.stringify(rendered)}`);
        assert.ok(!rendered.includes('FINAL'), `split at ${split} leaked the marker into the bubble`);
        assert.ok(!rendered.includes('message_id'), `split at ${split} leaked the metadata JSON`);
        assert.deepEqual(finals, [{ message_id: 7 }], `split at ${split} lost the final metadata`);
    }
});

test('text that merely looks like the start of a marker is still delivered', async () => {
    // The prefix hold must not swallow ordinary text: a stream ending on "M"
    // (or "META", part of a real sentence) has to reach the visitor.
    const finals = [];
    const { chunks } = await collect(
        async () => ({
            ok: true,
            body: streamOf([
                'METADATA:{"session_id":"s"}\n',
                'Ask about ',
                'META',
            ]),
        }),
        { onFinalMetadata: (meta) => finals.push(meta) },
    );

    assert.equal(chunks.join(''), 'Ask about META');
    assert.deepEqual(finals, []);
});
