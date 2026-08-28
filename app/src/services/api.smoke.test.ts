import { describe, expect, it } from 'vitest';

/**
 * The API client must be evaluable.
 *
 * `export const httpClient = api` was once placed above the `axios.create` call
 * that defines `api` — a temporal dead zone reference, so the module threw
 * `ReferenceError: Cannot access 'api' before initialization` on evaluation and
 * took down every screen in the app, not just the one that wanted the export.
 * Importing the module at all is the test; nothing else in the suite does it
 * without mocking the whole thing away first.
 */
describe('services/api module evaluation', () => {
  it('evaluates, and exposes the shared axios instance', async () => {
    const module = await import('./api');
    expect(module.httpClient).toBeDefined();
    expect(typeof module.httpClient.get).toBe('function');
    expect(typeof module.getApiBaseUrl()).toBe('string');
  });
});
