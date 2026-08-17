/**
 * `getEmbedEnvironment` decides whether the copy-paste embed snippet points at
 * the locally served widget preview or the production CDN. A local API endpoint
 * must select the local widget (the two have to be able to talk to each other);
 * everything else — including a malformed URL — must fail safe to production.
 */
import { describe, expect, it } from 'vitest';

import { getEmbedEnvironment } from './embedEnvironment.js';

describe('getEmbedEnvironment', () => {
  it('selects development for a localhost API endpoint', () => {
    expect(getEmbedEnvironment('http://localhost:8000')).toBe('development');
  });

  it('selects development for a loopback API endpoint', () => {
    expect(getEmbedEnvironment('http://127.0.0.1:8000')).toBe('development');
  });

  it('selects production for a remote API endpoint', () => {
    expect(getEmbedEnvironment('https://api.oyechats.com')).toBe('production');
  });

  it('fails safe to production for a malformed URL', () => {
    expect(getEmbedEnvironment('not-a-url')).toBe('production');
    expect(getEmbedEnvironment('')).toBe('production');
  });
});
