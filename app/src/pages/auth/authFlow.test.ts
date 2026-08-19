import { afterEach, describe, expect, it } from 'vitest';
import {
  digitsOnly,
  errorMessage,
  isEmailTakenError,
  maskEmail,
  otherDoor,
  passwordChecks,
  passwordMeetsRules,
  passwordScore,
  postAuthDestination,
  readPreferredDoor,
  rememberDoor,
  safeRelativePath,
} from './authFlow';

afterEach(() => {
  localStorage.clear();
});

describe('safeRelativePath', () => {
  it('keeps a same-origin path', () => {
    expect(safeRelativePath('/invite/abc?x=1')).toBe('/invite/abc?x=1');
  });

  it.each([
    ['protocol-relative', '//evil.example/steal'],
    ['absolute', 'https://evil.example'],
    ['scheme-only', 'javascript:alert(1)'],
    ['bare', 'dashboard'],
    ['empty', ''],
    ['missing', null],
  ])('rejects a %s target', (_label, value) => {
    expect(safeRelativePath(value)).toBe('');
  });
});

describe('maskEmail', () => {
  it('shows two characters and the domain', () => {
    expect(maskEmail('gaurav@fynix.digital')).toBe('ga***@fynix.digital');
  });

  it('does not over-reveal a one-character local part', () => {
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
  });

  it('leaves a value that is not an address alone', () => {
    expect(maskEmail('not-an-address')).toBe('not-an-address');
  });
});

describe('password rules', () => {
  it.each([
    ['too short', 'ab1', false],
    ['no number', 'passwordy', false],
    ['no letter', '12345678', false],
    ['acceptable', 'password1', true],
  ])('%s', (_label, value, expected) => {
    expect(passwordMeetsRules(value)).toBe(expected);
  });

  it('reports every rule, not just the first failure', () => {
    // The whole point of showing the list up front: a user who is short by two
    // characters should not also be told about the digit one attempt later.
    expect(passwordChecks('abcdefgh')).toEqual([
      { id: 'length', label: 'At least 8 characters', met: true },
      { id: 'letter', label: 'One letter', met: true },
      { id: 'number', label: 'One number', met: false },
    ]);
  });

  it('scores by rules satisfied', () => {
    expect(passwordScore('')).toBe(0);
    expect(passwordScore('abcdefgh')).toBe(2);
    expect(passwordScore('abcdefg1')).toBe(3);
  });
});

describe('digitsOnly', () => {
  it('strips everything that is not a digit and caps the length', () => {
    expect(digitsOnly('1 2-3 4_5 6 7')).toBe('123456');
  });

  it('survives a pasted code with surrounding prose', () => {
    expect(digitsOnly('Your code is 048213.')).toBe('048213');
  });
});

describe('the sign-in door', () => {
  it('defaults to the customer endpoint', () => {
    expect(readPreferredDoor()).toBe('client');
  });

  it('remembers the door that last worked on this device', () => {
    rememberDoor('operator');
    expect(readPreferredDoor()).toBe('operator');
    rememberDoor('client');
    expect(readPreferredDoor()).toBe('client');
  });

  it('names the other one', () => {
    expect(otherDoor('client')).toBe('operator');
    expect(otherDoor('operator')).toBe('client');
  });
});

describe('postAuthDestination', () => {
  it('lets a deep link win over every default', () => {
    expect(
      postAuthDestination({ next: '/invite/tok', affiliateToken: 'aff', door: 'client' }),
    ).toBe('/invite/tok');
  });

  it('routes a partner invite through its own landing page', () => {
    expect(postAuthDestination({ next: '', affiliateToken: 'a b', door: 'client' })).toBe(
      '/affiliate-invite?token=a%20b',
    );
  });

  it('never sends an operator to the affiliate flow — they have no such surface', () => {
    expect(postAuthDestination({ next: '', affiliateToken: 'aff', door: 'operator' })).toBe(
      '/inbox',
    );
  });

  it('sends a customer home and an operator to the inbox', () => {
    expect(postAuthDestination({ next: '', door: 'client' })).toBe('/');
    expect(postAuthDestination({ next: '', door: 'operator' })).toBe('/inbox');
  });
});

describe('isEmailTakenError', () => {
  it('recognises the 409 contract', () => {
    expect(isEmailTakenError(Object.assign(new Error('nope'), { status: 409 }))).toBe(true);
  });

  it('recognises the older prose form', () => {
    expect(isEmailTakenError(new Error('Email already registered'))).toBe(true);
  });

  it('does not swallow an unrelated failure', () => {
    expect(isEmailTakenError(Object.assign(new Error('Too many requests'), { status: 429 }))).toBe(
      false,
    );
    expect(isEmailTakenError(null)).toBe(false);
  });
});

describe('errorMessage', () => {
  it("prefers the server's own wording", () => {
    expect(errorMessage(new Error('Code has expired.'), 'fallback')).toBe('Code has expired.');
  });

  it('falls back when there is nothing to show', () => {
    expect(errorMessage({}, 'Please try again.')).toBe('Please try again.');
  });
});
