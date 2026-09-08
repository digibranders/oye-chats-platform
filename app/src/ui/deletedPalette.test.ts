/**
 * `tokens.css` deletes Tailwind's default palette. Utilities from it compile
 * to nothing, silently.
 *
 * `@theme { --color-*: initial }` drops all 22 default ramps AND bare `white`
 * and `black`, on purpose: without it `bg-violet-600` would still compile and
 * the old brand violet could walk back in under a utility class.
 *
 * The cost is that `bg-white` and `text-white` are not errors. They are simply
 * absent from the built stylesheet, so the element renders with a transparent
 * ground and inherited near-black text, and nothing says so. This has now
 * shipped twice: the impersonation banner, "the one bar that must never be
 * missed", rendered as a transparent strip with near-black text; and the lobby
 * card's overdue state lost the white button meant to make it readable on
 * solid red.
 *
 * A className assertion in a component test cannot catch it -- jsdom applies no
 * stylesheet, so `toContain('text-white')` passes on a class that does nothing.
 * This reads the source instead.
 */
import { describe, expect, it } from 'vitest';

/** Tailwind's default ramps, every one of which `--color-*: initial` removes. */
const DELETED_RAMPS = [
  'slate', 'gray', 'zinc', 'neutral', 'stone', 'red', 'orange', 'amber', 'yellow',
  'lime', 'green', 'emerald', 'teal', 'cyan', 'sky', 'blue', 'indigo', 'violet',
  'purple', 'fuchsia', 'pink', 'rose',
].join('|');

const PROPS = '(?:bg|text|border|ring|outline|divide|fill|stroke|from|via|to|shadow|accent|caret|decoration|placeholder)';

/**
 * `bg-white`, `hover:text-white/70`, `border-rose-600`.
 *
 * A numbered stop is required for the ramps because the theme defines its own
 * `neutral-tint` and `accent-500`; only `neutral-600` and friends are gone.
 */
const DEAD_COLOUR = new RegExp(
  String.raw`(?:^|[\s"'\`{(])((?:[a-z-]+:)*${PROPS}-(?:white|black|(?:${DELETED_RAMPS})-\d{2,3})(?:\/\d+)?)(?=[\s"'\`})])`,
  'g',
);

// Vite's own glob, the same mechanism `src/rtl.test.ts` uses for its
// source-level scan. `?raw` gives the file as a string and `eager` resolves at
// collection time, which is all a synchronous scan needs. Reading through Vite
// rather than `node:fs` also keeps this typed under `vite/client`, the only
// types this tsconfig loads.
const SOURCES = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('the deleted default palette', () => {
  it('is not referenced anywhere in the console', () => {
    const offenders: string[] = [];

    for (const [file, source] of Object.entries(SOURCES)) {
      if (/\.test\.tsx?$/.test(file)) continue;
      source.split('\n').forEach((line: string, i: number) => {
        // Comments do not compile, and several of them name these utilities
        // precisely in order to explain why they must not be used.
        if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)) return;
        for (const [, utility] of line.matchAll(DEAD_COLOUR)) {
          offenders.push(`${file.replace('../', '')}:${i + 1} ${utility}`);
        }
      });
    }

    expect(offenders, 'these compile to nothing; use a token from tokens.css').toEqual([]);
  });

  it('can still fail, so it is worth having', () => {
    const planted = 'className="bg-white hover:text-white/70 border-rose-600 text-neutral-500"';
    const found = [...planted.matchAll(DEAD_COLOUR)].map(([, u]) => u);

    expect(found).toEqual(['bg-white', 'hover:text-white/70', 'border-rose-600', 'text-neutral-500']);
  });

  it('leaves the theme’s own names alone', () => {
    const real = 'className="bg-danger-fill text-text-inverse border-accent-500 bg-neutral-tint text-warning"';

    expect([...real.matchAll(DEAD_COLOUR)]).toEqual([]);
  });
});
