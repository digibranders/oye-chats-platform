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
import ar from './locales/ar';

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
const flatAr = flatten(ar as unknown as Nested);

const DICTIONARIES: [string, Record<string, string>][] = [
  ['hi', flatHi],
  ['ar', flatAr],
];

describe('dictionary parity', () => {
  it('English is non-empty and is the canonical source', () => {
    expect(Object.keys(flatEn).length).toBeGreaterThan(0);
  });

  // A dictionary value is substituted into a JS expression, never parsed as
  // JSX, so "&hellip;" renders as those eight characters rather than an
  // ellipsis. The codemod used to carry entities across when it lifted JSX text
  // into a string literal; this is the guard that stops one coming back.
  const ENTITY = /&(?:[a-zA-Z][a-zA-Z0-9]{1,10}|#\d{1,6}|#x[0-9a-fA-F]{1,6});/;

  it('English has no HTML entities in any value', () => {
    const offenders = Object.entries(flatEn)
      .filter(([, value]) => ENTITY.test(value))
      .map(([key, value]) => `${key}: ${value}`);
    expect(offenders).toEqual([]);
  });

  it.each(DICTIONARIES)('%s has no HTML entities in any value', (_name, dict) => {
    const offenders = Object.entries(dict)
      .filter(([, value]) => ENTITY.test(value))
      .map(([key, value]) => `${key}: ${value}`);
    expect(offenders).toEqual([]);
  });

  // A value with no Devanagari at all is almost always an untranslated
  // placeholder that slipped through - `inbox.greeting` shipped as the literal
  // English word "greeting". Product names, plan tiers and code samples are
  // legitimately Latin, so only values with LETTERS and no Devanagari and no
  // uppercase (a proper noun) are flagged.
  it('hi has no value left in lowercase Latin prose', () => {
    const offenders = Object.entries(flatHi)
      .filter(([, v]) => /[a-z]{3}/.test(v) && !/[\u0900-\u097F]/.test(v) && !/[A-Z0-9@.:/{]/.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(offenders).toEqual([]);
  });

  // The Arabic mirror of the Hindi check above, over the Arabic script range
  // (\u0600-\u06FF, U+0600-U+06FF) rather than Devanagari.
  it('ar has no value left in lowercase Latin prose', () => {
    const offenders = Object.entries(flatAr)
      .filter(([, v]) => /[a-z]{3}/.test(v) && !/[\u0600-\u06FF]/.test(v) && !/[A-Z0-9@.:/{]/.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(offenders).toEqual([]);
  });

  // Punctuation the Arabic rollout explicitly bans: em/en dashes (the console-
  // wide rule `assert-no-em-dashes.mjs` already enforces for English, mirrored
  // here for Arabic since that script only scans .tsx source, not the .ts
  // dictionaries), and a Latin comma sitting directly against Arabic script
  // where an Arabic comma (\u060C) belongs. A Latin comma next to Latin/digits
  // (a number's thousands separator, a code sample) is not flagged - only one
  // immediately followed by an Arabic letter is unambiguously a mistake.
  it('ar uses Arabic punctuation, never an em/en dash or a stray Latin comma', () => {
    const DASH = /[\u2013\u2014]/;
    const LATIN_COMMA_BEFORE_ARABIC = /,\s*[\u0600-\u06FF]/;
    const offenders = Object.entries(flatAr)
      .filter(([, v]) => DASH.test(v) || LATIN_COMMA_BEFORE_ARABIC.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(offenders).toEqual([]);
  });

  it('ar uses Latin digits, never Arabic-Indic digits', () => {
    // ar-AE was chosen specifically for Western digits (see formatters.test.ts);
    // a dictionary string that hand-typed an Arabic-Indic digit would silently
    // contradict every number the formatters render right next to it.
    const ARABIC_INDIC_DIGIT = /[\u0660-\u0669]/;
    const offenders = Object.entries(flatAr)
      .filter(([, v]) => ARABIC_INDIC_DIGIT.test(v))
      .map(([k, v]) => `${k}: ${v}`);
    expect(offenders).toEqual([]);
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
    // Compared BY KEY. The previous version compared `Object.values(dict)[i]`
    // against `Object.values(flatEn)[i]`, which only lined up because both
    // files happen to render in the same sorted order; any hand edit that
    // reordered one file made this silently stop measuring anything.
    const shared = Object.keys(dict).filter((k) => k in flatEn);
    const identical = shared.filter((k) => dict[k] === flatEn[k]);
    expect(identical.length / shared.length).toBeLessThan(0.5);
  });
});
