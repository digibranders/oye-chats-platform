import { describe, expect, it } from 'vitest';
import { firstName } from './home-data';

/**
 * The header salutation ("Good afternoon, Gaurav 👋") addresses the HUMAN.
 * It used to render `currentWorkspaceName` - i.e. `company_name` - so the
 * prod account below was greeted as "Good afternoon, Fynix 👋".
 */
describe('firstName (header salutation)', () => {
  it('greets the person, never the workspace', () => {
    // Client 18: name "Gaurav", company_name "Fynix".
    expect(firstName('Gaurav')).toBe('Gaurav');
    expect(firstName('Gaurav')).not.toBe('Fynix');
  });

  it('uses only the first name of a full name', () => {
    expect(firstName('Gaurav Sharma')).toBe('Gaurav');
    expect(firstName('Ada Lovelace King')).toBe('Ada');
  });

  it('leaves a single-word name intact', () => {
    // A mononym is a real name - splitting on whitespace must not break it.
    expect(firstName('Prince')).toBe('Prince');
  });

  it('tolerates stray whitespace', () => {
    expect(firstName('  Gaurav   Sharma  ')).toBe('Gaurav');
  });

  it('yields no label when there is no usable name', () => {
    // Falling back to the workspace name would be worse than no name at all,
    // so every unusable input collapses to '' → a plain "Good afternoon 👋".
    expect(firstName(null)).toBe('');
    expect(firstName(undefined)).toBe('');
    expect(firstName('')).toBe('');
    expect(firstName('   ')).toBe('');
  });
});
