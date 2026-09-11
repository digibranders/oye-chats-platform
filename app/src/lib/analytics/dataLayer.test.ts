import { afterEach, describe, expect, it } from 'vitest';
import { pushDataLayerEvent } from './dataLayer';

describe('pushDataLayerEvent', () => {
  afterEach(() => {
    delete window.dataLayer;
  });

  it('creates the queue when the head bootstrap has not run', () => {
    delete window.dataLayer;

    pushDataLayerEvent({ event: 'registration_success', method: 'email' });

    expect(window.dataLayer).toEqual([{ event: 'registration_success', method: 'email' }]);
  });

  it('appends to the existing queue rather than replacing it', () => {
    // GTM wraps `push` on the array it found at load. Assigning a new array
    // would detach every later event from the container.
    const queue: unknown[] = [{ event: 'gtm.js' }];
    window.dataLayer = queue;

    pushDataLayerEvent({ event: 'registration_success', method: 'google' });

    expect(window.dataLayer).toBe(queue);
    expect(queue).toEqual([{ event: 'gtm.js' }, { event: 'registration_success', method: 'google' }]);
  });

  it('never throws into the caller when an extension has replaced the queue', () => {
    // Some blockers swap `dataLayer` for a stub with no `push`. A signup must
    // still navigate on.
    window.dataLayer = {} as unknown as unknown[];

    expect(() => pushDataLayerEvent({ event: 'registration_success', method: 'email' })).not.toThrow();
  });
});
