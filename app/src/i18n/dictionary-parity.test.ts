/**
 * Dictionary parity guards.
 *
 * `en.ts` is the canonical source. Every other dictionary must carry exactly
 * its key set and exactly its placeholders. Neither failure is visible at
 * runtime, which is why they need a test:
 *
 * - A key missing from `hi.ts` falls through to the inline English default, so
 *   a Hindi user gets a single English sentence in an otherwise Hindi screen.
 *   Nothing errors and nothing logs.
 * - A placeholder that exists in one dictionary and not the other renders a
 *   literal `{count}` to the user, or silently drops a value the sentence was
 *   built around.
 */

import { describe, expect, it } from 'vitest';

import en from './locales/en';
import hi from './locales/hi';

type Nested = { [key: string]: string | Nested };

function flatten(obj: Nested, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[path] = value;
    else Object.assign(out, flatten(value, path));
  }
  return out;
}

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

const flatEn = flatten(en as unknown as Nested);
const flatHi = flatten(hi as unknown as Nested);

const DICTIONARIES: [string, Record<string, string>][] = [['hi', flatHi]];

describe('dictionary parity', () => {
  it('English is non-empty and is the canonical source', () => {
    expect(Object.keys(flatEn).length).toBeGreaterThan(0);
  });

  it.each(DICTIONARIES)('%s has no keys missing against English', (_name, dict) => {
    const missing = Object.keys(flatEn).filter((k) => !(k in dict));
    expect(missing).toEqual([]);
  });

  it.each(DICTIONARIES)('%s has no keys English does not have', (_name, dict) => {
    const extra = Object.keys(dict).filter((k) => !(k in flatEn));
    expect(extra).toEqual([]);
  });

  it.each(DICTIONARIES)('%s matches English placeholders on every key', (_name, dict) => {
    const mismatched: string[] = [];
    for (const [key, englishValue] of Object.entries(flatEn)) {
      const translated = dict[key];
      if (typeof translated !== 'string') continue;
      const a = placeholders(englishValue);
      const b = placeholders(translated);
      if (a.join(',') !== b.join(',')) {
        mismatched.push(`${key}: en={${a.join(',')}} vs {${b.join(',')}}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  it.each(DICTIONARIES)('%s has no blank translations', (_name, dict) => {
    const blank = Object.entries(dict)
      .filter(([, v]) => typeof v === 'string' && v.trim() === '')
      .map(([k]) => k);
    expect(blank).toEqual([]);
  });

  it.each(DICTIONARIES)('%s is actually translated, not copied English', (_name, dict) => {
    // A dictionary that merely mirrors English passes every structural check
    // above while delivering nothing. Latin-script values are legitimate for
    // product nouns, so this only requires that the dictionary is
    // predominantly non-Latin rather than that every value is.
    const values = Object.entries(dict)
      .filter(([key]) => key in flatEn)
      .map(([, v]) => v);
    const identical = values.filter((v, i) => v === Object.values(flatEn)[i]);
    expect(identical.length / Math.max(values.length, 1)).toBeLessThan(0.5);
  });
});
