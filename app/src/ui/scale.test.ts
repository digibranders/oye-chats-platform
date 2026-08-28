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
 * ## It reads the whole app, not just `src/ui`
 *
 * It used to glob `./**` — `src/ui` and nothing else — so roughly 40,000 lines
 * in `features/`, `superadmin/`, `shell/`, `onboarding/` and `pages/` were
 * unguarded by the one test that exists to guard them. A `text-3xl`, a rung the
 * system does not have, shipped straight through it. The design system is not
 * the directory; it is the rules, and the rules apply wherever a class string is
 * written.
 *
 * Read through Vite's own glob rather than `node:fs`, so the design system's
 * tests need no Node types and the app's tsconfig stays honest about running in
 * a browser.
 */

const MODULES = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * Comments are not class strings.
 *
 * Every rule below hunts for a pattern that these files also *discuss* — the
 * ban on `disabled:opacity-` is documented in a comment that has to name it,
 * and the note on why `--color-chart-1` moved has to print the hex it moved
 * from. Scanning raw source made the guardrails unwritable: the only way to
 * explain a rule was to break it.
 *
 * String literals are kept, which is where every class string lives, and a `//`
 * inside one (`https://…`) is not treated as a comment because the scanner is
 * already inside the string when it reaches it.
 */
function stripComments(source: string): string {
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'tick';
  let mode: Mode = 'code';
  let out = '';
  let index = 0;

  while (index < source.length) {
    const pair = source.slice(index, index + 2);
    const char = source[index];

    if (mode === 'code') {
      if (pair === '/*') {
        mode = 'block';
        index += 2;
        continue;
      }
      if (pair === '//') {
        mode = 'line';
        index += 2;
        continue;
      }
      if (char === "'") mode = 'single';
      else if (char === '"') mode = 'double';
      else if (char === '`') mode = 'tick';
      out += char;
      index += 1;
      continue;
    }

    if (mode === 'block') {
      if (pair === '*/') {
        mode = 'code';
        index += 2;
      } else {
        // Newlines are kept so a reported line number still means something.
        out += char === '\n' ? '\n' : ' ';
        index += 1;
      }
      continue;
    }

    if (mode === 'line') {
      if (char === '\n') {
        mode = 'code';
        out += '\n';
      }
      index += 1;
      continue;
    }

    out += char;
    if (char === '\\') {
      out += source[index + 1] ?? '';
      index += 2;
      continue;
    }
    if (
      (mode === 'single' && char === "'") ||
      (mode === 'double' && char === '"') ||
      (mode === 'tick' && char === '`')
    ) {
      mode = 'code';
    }
    index += 1;
  }

  return out;
}

interface SourceFile {
  /** Path relative to `src/`, e.g. `ui/primitives/Badge.tsx`. */
  name: string;
  /** Comment-stripped source — what the rules scan. */
  source: string;
}

/**
 * Vite normalises a glob key against the importing file, so `src/ui`'s own
 * modules come back as `./layout/Card.tsx` while everything else is
 * `../features/…`. Both are rewritten to a path relative to `src/`, so a
 * failure names a file somebody can open.
 */
const FILES: SourceFile[] = Object.entries(MODULES)
  .filter(([name]) => !/\.test\.tsx?$/.test(name))
  .map(([name, source]) => ({
    name: name.startsWith('./') ? `ui/${name.slice(2)}` : name.replace(/^\.\.\//, ''),
    source: stripComments(source as string),
  }));

const UI = FILES.filter((file) => file.name.startsWith('ui/'));
const SHELL = FILES.filter((file) => file.name.startsWith('shell/'));

/** Every rung declared in `tokens.css`, plus the prose rung. */
const SCALE = ['2xs', 'xs', 'sm', 'base', 'lg', 'xl', '2xl', 'prose'];

/**
 * The status hues, as they are written on paper.
 *
 * They have a rail-ground twin each — `--color-rail-success` and friends — and
 * the whole reason those exist is that these do not survive a near-black
 * ground: `--color-danger-fill` measures 2.94 on `--color-rail` and fails
 * SC 1.4.11 outright, and a track painted `--color-border` measured 1.14 and
 * could not be seen at all.
 */
const PAPER_STATUS = /\b(?:bg|text|border|ring|from|to|via)-(?:success|warning|danger|neutral|plan)(?:-fill|-tint)?\b/g;

/**
 * The two shell files that paint on ink and nothing else.
 *
 * The rest of `src/shell` is mixed on purpose — `AccountMenu` has a trigger on
 * the rail and a menu on paper, and `ImpersonationBanner` is a paper-ground bar
 * that is *correctly* `bg-danger-fill` — so those files are checked line by
 * line instead: a paper status token is an offence only where it shares a
 * class string with a rail token.
 */
const INK_GROUND = ['shell/Rail.tsx', 'shell/SetupProgress.tsx', 'shell/TrialCard.tsx'];

describe('design system guardrails', () => {
  it('reads the whole app, not just src/ui', () => {
    // If the glob ever stops matching, every assertion below passes vacuously.
    // The counts are floors, not fixtures: `ui/` alone was 60-odd files, and the
    // point of this pass was that the other four hundred were unguarded.
    expect(UI.length).toBeGreaterThan(40);
    expect(FILES.length).toBeGreaterThan(200);
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

  /**
   * Inside `src/ui` a hex can only be a colour decision, and every colour
   * decision belongs in `tokens.css` — that is how the system this replaces
   * ended up with 143 of them.
   *
   * Outside it, a hex is very often *data*: the colour a customer picked for
   * their own widget, the value the contrast checker is scoring, Google's brand
   * blue on a federated sign-in button. Those are values passing through the
   * app, not decisions about how it looks, and banning them would only teach
   * people to route a string through a variable to get past the test.
   *
   * What is banned everywhere is the class-string form — `bg-[#2b54c8]` — which
   * is a colour decision wherever it is written.
   */
  it('declares no raw hex inside src/ui', () => {
    const offenders = UI.filter(({ source }) => /#[0-9a-fA-F]{3,8}\b/.test(source)).map(
      (file) => file.name,
    );
    expect(offenders).toEqual([]);
  });

  it('smuggles no hex into a utility class', () => {
    const offenders: string[] = [];
    for (const { name, source } of FILES) {
      for (const match of source.matchAll(/[\w-]+-\[[^\]]*#[0-9a-fA-F]{3,8}[^\]]*\]/g)) {
        offenders.push(`${name}: ${match[0]}`);
      }
    }
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

  /**
   * `disabled:opacity-*` is the banned text-opacity pattern applied one level
   * up. It takes `--color-text-inverse` on ink from 17.89 to about 4.2 and
   * `--color-danger` on white from 7.19 to about 2.6, and it compounds: a
   * disabled checkbox dimmed by its box *and* by its label wrapper rendered at
   * 0.36 effective opacity. `DISABLED_CONTROL` and `DISABLED_FILLED` state the
   * same thing in tokens, at a value somebody chose.
   */
  it('states disabled in tokens, never in opacity', () => {
    const offenders: string[] = [];
    for (const { name, source } of FILES) {
      for (const match of source.matchAll(/\bdisabled:opacity-[\w.[\]]+/g)) {
        offenders.push(`${name}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Every stacking value comes off the `--z-*` ladder in `tokens.css`.
   *
   * The system this replaces put the mobile scrim and the top bar both on
   * `z-20`, with the bar later in the DOM, so the bar painted above its own
   * scrim and stayed clickable. A raw `z-[40]` is that bug waiting to happen
   * again: the number is chosen against whatever the author could see on screen
   * that day, and nothing records what it was chosen against.
   *
   * `z-<number>` — the plain utility — stays legal for a value that is local to
   * one component's own children and never meets another layer, like the pinned
   * cell in `DataTable` sitting one above its siblings. What is banned is the
   * arbitrary-value form, which is how a page-level rung gets invented inline.
   */
  it('takes every stacking rung from the ladder', () => {
    const offenders: string[] = [];
    for (const { name, source } of FILES) {
      for (const match of source.matchAll(/\bz-\[\s*\d/g)) {
        offenders.push(`${name}: ${match[0].trim()}…]`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Line-height comes from the type rung, inside the design system.
   *
   * Each `--text-*` token ships with its own `--line-height`, chosen against
   * that size. A `leading-*` utility overrides it with a ratio picked by eye —
   * `leading-snug` on `text-xs` is 12/16.8 against the scale's 12/18, and
   * `leading-relaxed` on the same rung is 12/19.5 — so the same rung rendered at
   * three leadings across six components and no card's rows lined up with
   * another's. Change the rung, or change the token.
   *
   * `leading-none` is the one exception, and only because it is not a choice of
   * line-height: it is the reset a fixed-height inline chip needs in order to
   * have no leading at all, and `Badge` documents the 1px tilt that appears
   * without it.
   */
  it('takes line-height from the type scale inside src/ui', () => {
    const offenders: string[] = [];
    for (const { name, source } of UI) {
      for (const match of source.matchAll(/\bleading-(?!none\b)[\w.[\]-]+/g)) {
        offenders.push(`${name}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The rail is ink, and paper tokens do not survive it.
   *
   * DESIGN.md §2.2 argues this and the token file ships `--color-rail-success`,
   * `-warning`, `-danger` and `-track` for it, because six shell components
   * reached for the paper token anyway — the health dots painted
   * `--color-danger-fill` at 2.94 on the rail.
   */
  it('paints no paper status token on the ink ground', () => {
    const offenders: string[] = [];

    for (const { name, source } of SHELL) {
      const wholeFile = INK_GROUND.includes(name);
      for (const [index, line] of source.split('\n').entries()) {
        const found = line.match(PAPER_STATUS);
        if (!found) continue;
        // Outside the two pure-ink files, only a line that is *also* painting
        // rail chrome is on the ink ground.
        if (!wholeFile && !/\b(?:bg|text|border|ring)-rail(?:-[\w-]+)?\b/.test(line)) continue;
        offenders.push(`${name}:${index + 1}: ${found.join(' ')}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
