import { describe, expect, it } from 'vitest';
import { isMissingClientCredential } from './authFailure';

describe('isMissingClientCredential', () => {
  it('matches the strict dependency prose, hyphenated header and all', () => {
    expect(
      isMissingClientCredential(
        'Missing X-API-Key header. This endpoint requires account (admin) authentication.',
      ),
    ).toBe(true);
  });

  it('matches regardless of case', () => {
    expect(isMissingClientCredential('missing x-api-key header')).toBe(true);
    expect(isMissingClientCredential('Missing API key')).toBe(true);
  });

  it('matches a structured code', () => {
    expect(isMissingClientCredential({ error: 'missing_api_key' })).toBe(true);
    expect(isMissingClientCredential({ error: 'client_auth_required' })).toBe(true);
  });

  it('matches a structured detail carrying the prose under message', () => {
    expect(isMissingClientCredential({ message: 'Missing X-API-Key header.' })).toBe(true);
  });

  it('does not match a genuinely invalid credential', () => {
    expect(isMissingClientCredential('Invalid or expired token')).toBe(false);
    expect(isMissingClientCredential({ error: 'workspace_access_denied' })).toBe(false);
    expect(isMissingClientCredential(null)).toBe(false);
    expect(isMissingClientCredential(undefined)).toBe(false);
    expect(isMissingClientCredential([{ msg: 'field required' }])).toBe(false);
  });
});
