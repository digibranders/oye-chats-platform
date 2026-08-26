/**
 * Every key the app ASKS for must exist in the English dictionary.
 *
 * This is the system's only silent failure mode, and until now nothing checked
 * it. `i18n-orphans` walks dictionary -> source and finds keys nothing uses.
 * `dictionary-parity` walks en -> hi and finds translations that are missing.
 * Neither walks source -> dictionary, so a hand-written
 * `t('agents.newThing') || 'New thing'` renders perfectly in English, is
 * reported "localized" by the inventory, and renders English to every Hindi
 * user forever. Four `<Trans>` keys shipped in exactly that state.
 */

import { describe, expect, it } from 'vitest';

import en from './locales/en';

type Nested = { [key: string]: string | Nested };

function flatten(obj: Nested, prefix = ''): Set<string> {
  const out = new Set<string>();
  for (const [key, value] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.add(p);
    else for (const k of flatten(value, p)) out.add(k);
  }
  return out;
}

const KEYS = flatten(en as unknown as Nested);
const NAMESPACES = new Set([...KEYS].map((k) => k.split('.')[0]));

// Read through Vite's own glob rather than node:fs, so the test needs no
// node type definitions and no tsconfig change.
const MODULES = import.meta.glob('../**/*.{ts,tsx,js,jsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const sources = Object.entries(MODULES)
  .filter(([file]) => !file.includes('/locales/') && !file.includes('.test.'))
  .map(([file, text]) => ({ file, text }));

/** Literal keys: t('a.b'), translateNow("a.b"), <Trans k="a.b" /> or k={ternary}. */
function literalKeys(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(?:\bt|\btranslateNow)\(\s*['"]([A-Za-z0-9_.]+)['"]/g)) {
    found.push(m[1] as string);
  }
  for (const m of text.matchAll(/\bk="([A-Za-z0-9_.]+)"/g)) found.push(m[1] as string);
  // `k={cond ? 'a.b' : 'a.c'}` resolves to two keys. Both must exist, and both
  // were missing on the four Trans elements that shipped untranslatable.
  for (const m of text.matchAll(/\bk=\{([^}]*)\}/g)) {
    for (const q of (m[1] as string).matchAll(/['"]([A-Za-z0-9_.]+)['"]/g)) {
      found.push(q[1] as string);
    }
  }
  return found;
}

describe('every key used in source exists in en.ts', () => {
  it('has no key referenced by the app but missing from the dictionary', () => {
    const missing: string[] = [];
    for (const { file, text } of sources) {
      for (const key of literalKeys(text)) {
        // Only keys in a real namespace: a dotted string elsewhere in the code
        // is not necessarily a dictionary key.
        if (!NAMESPACES.has(key.split('.')[0] as string)) continue;
        if (!KEYS.has(key)) missing.push(`${file}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
