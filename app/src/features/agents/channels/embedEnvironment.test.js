import assert from 'node:assert/strict';
import test from 'node:test';

import { getEmbedEnvironment } from './embedEnvironment.js';

test('selects development widget snippets for a localhost API endpoint', () => {
  assert.equal(getEmbedEnvironment('http://localhost:8000'), 'development');
});

test('selects development widget snippets for a loopback API endpoint', () => {
  assert.equal(getEmbedEnvironment('http://127.0.0.1:8000'), 'development');
});

test('selects production widget snippets for a remote API endpoint', () => {
  assert.equal(getEmbedEnvironment('https://api.oyechats.com'), 'production');
});
