/**
 * The handoff request must carry the address, or the server gate sees nothing.
 *
 * `HandoffForm` refuses to submit an undeliverable address, and
 * `/chat/validate-email` backs that with a real vendor verdict. But the bot key
 * is embedded in every customer's page, so until the server saw the address on
 * the request that actually queues a visitor, that check was advice rather than
 * a rule: anyone replaying this request walked past it.
 *
 * The server treats the field as optional and fails open on everything except
 * an unambiguously bad address, so an older widget build cached on a customer's
 * page keeps working exactly as before. That only holds while the CURRENT build
 * actually sends it, which is what this pins.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

async function captureHandoffBody(formData) {
    const calls = [];
    global.fetch = (url, options) => {
        calls.push({ url: String(url), body: JSON.parse(options.body) });
        return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ suggested_action: 'route' }),
        });
    };
    // `getHeaders` reads the bot key off `window`, and `getApiUrl` runs at
    // import time, so both have to exist before the module is loaded.
    global.window = { OYECHATS_BOT_KEY: 'bot-test', location: { origin: 'https://example.com' } };
    global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

    const { requestHandoff } = await import('./api.js');
    await requestHandoff('session-1', formData);

    return calls.find((c) => c.url.includes('/operators/handoff'));
}

test('the address the visitor typed reaches the server', async () => {
    const call = await captureHandoffBody({ name: 'Priya', email: 'priya@example.com' });

    assert.equal(call.body.email, 'priya@example.com');
});

test('an absent address is sent as null, not undefined', async () => {
    // `undefined` disappears through JSON.stringify, so the field would be
    // missing rather than explicitly empty. Both are accepted, but a caller
    // reading the payload should not have to tell those apart.
    const call = await captureHandoffBody({ name: 'Priya' });

    assert.equal(call.body.email, null);
    assert.ok('email' in call.body);
});

test('the session and reason still travel with it', async () => {
    const call = await captureHandoffBody({ name: 'Priya', email: 'p@example.com', reason: 'pricing' });

    assert.equal(call.body.session_id, 'session-1');
    assert.equal(call.body.reason, 'pricing');
});
