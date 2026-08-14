import { describe, expect, it } from 'vitest';
import { resolveWebsitePrefill } from './websitePrefill';

describe('resolveWebsitePrefill', () => {
  it("prefers the agent's own website when it is set", () => {
    expect(resolveWebsitePrefill('https://agent.example', 'https://account.example')).toBe(
      'https://agent.example',
    );
  });

  it('falls back to the account website when the agent has none', () => {
    expect(resolveWebsitePrefill(undefined, 'https://www.fynix.digital')).toBe(
      'https://www.fynix.digital',
    );
    expect(resolveWebsitePrefill(null, 'https://www.fynix.digital')).toBe(
      'https://www.fynix.digital',
    );
    expect(resolveWebsitePrefill('   ', 'https://www.fynix.digital')).toBe(
      'https://www.fynix.digital',
    );
  });

  it('returns an empty string - never "null"/"undefined" - when neither is set', () => {
    expect(resolveWebsitePrefill(undefined, undefined)).toBe('');
    expect(resolveWebsitePrefill(null, null)).toBe('');
    expect(resolveWebsitePrefill('', '')).toBe('');
    expect(resolveWebsitePrefill('  ', '  ')).toBe('');
  });

  it('preserves the stored value verbatim so submit-time normalisation still owns the scheme', () => {
    expect(resolveWebsitePrefill(null, 'fynix.digital')).toBe('fynix.digital');
    expect(resolveWebsitePrefill(null, ' https://www.fynix.digital ')).toBe(
      'https://www.fynix.digital',
    );
  });
});
