import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryImport } from './lazyWithRetry.js';

// No real delays in tests: swap the backoff sleep for a no-op.
const noSleep = () => Promise.resolve();

test('resolves on first success without retrying', async () => {
  let calls = 0;
  const result = await retryImport(async () => { calls += 1; return { default: 'ok' }; }, { sleep: noSleep });
  assert.equal(result.default, 'ok');
  assert.equal(calls, 1);
});

test('recovers from a transient failure (self-heals a one-off chunk blip)', async () => {
  let calls = 0;
  const result = await retryImport(
    async () => {
      calls += 1;
      if (calls < 2) throw new TypeError('Failed to fetch dynamically imported module');
      return { default: 'recovered' };
    },
    { retries: 2, sleep: noSleep },
  );
  assert.equal(result.default, 'recovered');
  assert.equal(calls, 2);
});

test('rejects after exhausting retries on a permanently missing chunk', async () => {
  // This is the 2026-07-08 incident: a chunk that is genuinely 404 on the CDN.
  // retryImport must give up and reject (so the ErrorBoundary can catch it and
  // degrade), NOT hang or swallow the error.
  let calls = 0;
  await assert.rejects(
    () => retryImport(
      async () => { calls += 1; throw new TypeError('Failed to fetch dynamically imported module'); },
      { retries: 2, sleep: noSleep },
    ),
    /Failed to fetch dynamically imported module/,
  );
  // initial attempt + 2 retries
  assert.equal(calls, 3);
});
