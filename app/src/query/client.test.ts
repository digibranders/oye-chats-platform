import { describe, expect, it } from 'vitest';

import { ApiError } from '../services/apiTypes';
import { queryClient } from './client';

/**
 * The retry rule, against the error shape the app actually throws.
 *
 * `buildApiError` turns every axios rejection into an `ApiError`, which carries
 * `status` directly and has no `response`. The predicate read
 * `error.response.status` only, so its client-error guard never fired once in
 * production: a 403 was re-sent twice on a 1s/2s backoff before the forbidden
 * state appeared.
 */
const retry = queryClient.getDefaultOptions().queries?.retry as (
  failureCount: number,
  error: unknown,
) => boolean;

describe('query retry policy', () => {
  it.each([401, 403, 404, 422])('never retries an ApiError %i', (status) => {
    expect(retry(0, new ApiError('nope', { status }))).toBe(false);
  });

  it('still never retries a raw axios rejection', () => {
    expect(retry(0, { response: { status: 403 } })).toBe(false);
  });

  it('retries a server error, then gives up', () => {
    const boom = new ApiError('boom', { status: 500 });
    expect(retry(0, boom)).toBe(true);
    expect(retry(1, boom)).toBe(true);
    expect(retry(2, boom)).toBe(false);
  });

  it('retries a network failure, which has no status at all', () => {
    expect(retry(0, new ApiError('offline'))).toBe(true);
  });
});
