import { describe, expect, it } from 'vitest';
import {
  errorCellText,
  errorFieldKeys,
  errorFieldLabel,
  errorLevelTone,
  isIsoInstant,
} from './errorTable';

describe('errorFieldKeys', () => {
  it('leads with level and message whatever order the server wrote them', () => {
    expect(
      errorFieldKeys([{ count: 4, message: 'boom', level: 'error', last_seen: '2026-01-01T00:00Z' }]),
    ).toEqual(['level', 'message', 'count', 'last_seen']);
  });

  it('unions the keys across rows, so a field only some rows carry still gets a column', () => {
    expect(errorFieldKeys([{ level: 'error' }, { level: 'warning', culprit: 'worker.py' }])).toEqual([
      'level',
      'culprit',
    ]);
  });

  it('drops the ids the reader has no use for', () => {
    expect(errorFieldKeys([{ id: 1, short_id: 'OYE-2', message: 'boom' }])).toEqual(['message']);
  });

  it('keeps an unknown key in the order the server sent it, after the known ones', () => {
    expect(errorFieldKeys([{ environment: 'prod', level: 'error', release: '2.14.3' }])).toEqual([
      'level',
      'environment',
      'release',
    ]);
  });

  it('has no columns for an empty payload', () => {
    expect(errorFieldKeys([])).toEqual([]);
  });
});

describe('errorFieldLabel', () => {
  it('reads a snake_case key as a sentence', () => {
    expect(errorFieldLabel('last_seen')).toBe('Last seen');
  });

  it('reads a camelCase key the same way', () => {
    expect(errorFieldLabel('lastSeen')).toBe('Last seen');
  });
});

describe('errorCellText', () => {
  it('leaves an absent value absent, so the table prints its own em dash', () => {
    expect(errorCellText(null)).toBeNull();
    expect(errorCellText(undefined)).toBeNull();
    expect(errorCellText('')).toBeNull();
  });

  it('renders a boolean as a word', () => {
    expect(errorCellText(true)).toBe('Yes');
    expect(errorCellText(false)).toBe('No');
  });

  it('compacts a structured value rather than dropping it', () => {
    expect(errorCellText({ tag: 'db' })).toBe('{"tag":"db"}');
  });

  it('refuses a number that is not one', () => {
    expect(errorCellText(Number.NaN)).toBeNull();
  });
});

describe('isIsoInstant', () => {
  it('recognises the timestamps Sentry sends', () => {
    expect(isIsoInstant('2026-08-20T10:00:00Z')).toBe(true);
  });

  it('does not treat a plain sentence as a date', () => {
    expect(isIsoInstant('Razorpay webhook signature mismatch')).toBe(false);
  });
});

describe('errorLevelTone', () => {
  it('paints a fault red and a warning amber', () => {
    expect(errorLevelTone('error')).toBe('danger');
    expect(errorLevelTone('CRITICAL')).toBe('danger');
    expect(errorLevelTone('warning')).toBe('warning');
  });

  it('stays neutral for a level it does not know', () => {
    expect(errorLevelTone('info')).toBe('neutral');
    expect(errorLevelTone(undefined)).toBe('neutral');
  });
});
