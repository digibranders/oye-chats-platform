import { describe, expect, it } from 'vitest';

/**
 * The design system's own guardrail.
 *
 * Tailwind emits nothing for a size it does not know, so a component reaching
 * for `text-md` — which is not in our scale and is not a Tailwind default
 * either — renders at the inherited body size and looks almost right. That is
 * exactly how a scale rots: not because anyone decided to add a rung, but
 * because a class name nobody noticed did nothing. Two dialog titles and every
 * section heading shipped that way before this test existed.
 *
 * The same applies to raw hex, which is how the system this replaces ended up
 * with 143 hardcoded colours; to arbitrary font sizes, which is how it ended up
 * with 1,274 of them across nineteen distinct values; and to opacity modifiers
 * on text tokens, which is how its most-used text colour ended up at 2.56:1.
 *
 * Read through Vite's own glob rather than `node:fs`, so the design system's
 * tests need no Node types and the app's tsconfig stays honest about running in
 * a browser.
 */

const MODULES = import.meta.glob('./**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true });

const FILES = Object.entries(MODULES)
  .filter(([name]) => !/\.test\.tsx?$/.test(name))
  .map(([name, source]) => ({ name, source: source as string }));

/** Every rung declared in `tokens.css`, plus the prose rung. */
const SCALE = ['2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl', 'prose'];

describe('design system guardrails', () => {
  it('reads its own source', () => {
    // If the glob ever stops matching, every assertion below passes vacuously.
    expect(FILES.length).toBeGreaterThan(20);
  });

  it('uses no font size outside the declared scale', () => {
    const offenders: string[] = [];
    for (const { name, source } of FILES) {
      for (const match of source.matchAll(/\btext-(\w[\w.]*)\b/g)) {
        const rung = match[1];
        // Colour utilities share the `text-` prefix; only sizes are in scope.
        const looksLikeSize = /^\d/.test(rung) || SCALE.includes(rung) || rung === 'md';
        if (looksLikeSize && !SCALE.includes(rung)) offenders.push(`${name}: text-${rung}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares no raw hex outside the token file', () => {
    const offenders = FILES.filter(({ source }) => /#[0-9a-fA-F]{3,8}\b/.test(source)).map((f) => f.name);
    expect(offenders).toEqual([]);
  });

  it('uses no arbitrary font size', () => {
    const offenders: string[] = [];
    for (const { name, source } of FILES) {
      for (const match of source.matchAll(/text-\[[^\]]+\]/g)) offenders.push(`${name}: ${match[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('never dims a text token with an opacity modifier', () => {
    const offenders: string[] = [];
    for (const { name, source } of FILES) {
      for (const match of source.matchAll(
        /text-(text-\w+|success|warning|danger|neutral|plan|accent-\d+)\/\d+/g,
      )) {
        offenders.push(`${name}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
