/**
 * Tests for the per-address email verdict memo (emailVerdictCache.js).
 *
 * Regression coverage for the validation hole this replaced: the forms used
 * to gate on a mode flag ('valid' | 'invalid' | ...) that described whichever
 * address was checked LAST, so a second address typed after a first one
 * passed reached a human without ever being checked. The gate now resolves by
 * address, and this memo is what keeps that from costing an extra request.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailVerdictCache } from './emailVerdictCache.js';

test('the same address is fetched once and reuses the verdict', async () => {
    const cache = createEmailVerdictCache();
    let calls = 0;
    const fetcher = () => {
        calls += 1;
        return Promise.resolve({ verdict: { valid: false, reason: 'nope' } });
    };

    const first = await cache.resolve('bad@example.com', fetcher);
    const second = await cache.resolve('bad@example.com', fetcher);

    assert.equal(calls, 1);
    assert.deepEqual(first, { valid: false, reason: 'nope' });
    assert.deepEqual(second, { valid: false, reason: 'nope' });
});

test('a different address never inherits the previous verdict', async () => {
    const cache = createEmailVerdictCache();
    const verdicts = {
        'good@example.com': { valid: true },
        'bad@example.com': { valid: false, reason: 'nope' },
    };
    const asked = [];
    const fetcher = (key) => () => {
        asked.push(key);
        return Promise.resolve({ verdict: verdicts[key] });
    };

    assert.deepEqual(await cache.resolve('good@example.com', fetcher('good@example.com')), { valid: true });
    assert.deepEqual(
        await cache.resolve('bad@example.com', fetcher('bad@example.com')),
        { valid: false, reason: 'nope' },
    );
    assert.deepEqual(asked, ['good@example.com', 'bad@example.com']);
});

test('concurrent checks for one address share a single fetch', async () => {
    const cache = createEmailVerdictCache();
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fetcher = () => {
        calls += 1;
        return gate.then(() => ({ verdict: { valid: true } }));
    };

    const blurCheck = cache.resolve('a@example.com', fetcher);
    const submitCheck = cache.resolve('a@example.com', fetcher);
    release();

    assert.deepEqual(await blurCheck, { valid: true });
    assert.deepEqual(await submitCheck, { valid: true });
    assert.equal(calls, 1);
});

test('a fail-open answer is not retained, so the next attempt retries', async () => {
    const cache = createEmailVerdictCache();
    let calls = 0;
    const fetcher = () => {
        calls += 1;
        return calls === 1
            ? Promise.resolve({ verdict: { valid: true }, cacheable: false })
            : Promise.resolve({ verdict: { valid: false, reason: 'nope' } });
    };

    assert.deepEqual(await cache.resolve('x@example.com', fetcher), { valid: true });
    assert.deepEqual(await cache.resolve('x@example.com', fetcher), { valid: false, reason: 'nope' });
    assert.equal(calls, 2);
});

test('the cache evicts its oldest entry instead of growing without bound', async () => {
    const cache = createEmailVerdictCache(2);
    const fetcher = () => Promise.resolve({ verdict: { valid: true } });

    await cache.resolve('one@example.com', fetcher);
    await cache.resolve('two@example.com', fetcher);
    await cache.resolve('three@example.com', fetcher);

    assert.equal(cache.size(), 2);
});

test('an explicitly unverified answer is not retained', async () => {
    // The server marks its own fail-open paths (vendor budget spent, Reoon
    // unreachable) with unverified:true. That describes our state, not the
    // address, so holding it would freeze the address as unchecked for the
    // whole visit.
    const cache = createEmailVerdictCache();
    let calls = 0;
    const fetcher = () => {
        calls += 1;
        return calls === 1
            ? Promise.resolve({ verdict: { valid: true, unverified: true }, cacheable: false })
            : Promise.resolve({ verdict: { valid: false, reason: 'nope' } });
    };

    assert.equal((await cache.resolve('y@example.com', fetcher)).unverified, true);
    assert.deepEqual(await cache.resolve('y@example.com', fetcher), { valid: false, reason: 'nope' });
    assert.equal(calls, 2);
});
