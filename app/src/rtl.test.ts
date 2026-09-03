/**
 * RTL regression guard.
 *
 * The authoritative scanner is `scripts/rtl-physical-classes.mjs`, run
 * directly in CI and locally as `node scripts/rtl-physical-classes.mjs`. This
 * test re-implements its matching rules against Vite's own `import.meta.glob`
 * read of every source file, rather than shelling out to the script, because
 * `src/` is 100% TypeScript under a strict `tsc` that has no ambient `node:`
 * types configured (see `../CLAUDE.md`'s TypeScript gate) — a `node:fs` /
 * `node:child_process` import here would fail `tsc --noEmit` even though it
 * runs fine under Vitest's own Node process. Keeping the two independent also
 * means this test exercises the RULES, not the CLI wrapper.
 *
 * If you change the matching rules, change them in BOTH places. They are
 * deliberately kept short for exactly that reason.
 *
 * See the script's own header comment for the full convention this enforces:
 * a physical-direction Tailwind class or CSS property must either become its
 * logical (`ms-`/`me-`/`text-start`/...) equivalent, or carry an `rtl-ok:`
 * marker explaining why mirroring would be wrong there.
 */
import { describe, expect, it } from 'vitest';

const UTILITY_PREFIXES = [
  'ml',
  'mr',
  'pl',
  'pr',
  'left',
  'right',
  'inset-x',
  'rounded-tl',
  'rounded-tr',
  'rounded-bl',
  'rounded-br',
  'rounded-l',
  'rounded-r',
  'border-l',
  'border-r',
  'translate-x',
  '-translate-x',
  'space-x',
  'divide-x',
  'scroll-pl',
  'scroll-pr',
];

// rtl-ok: this list names the physical utilities the guard looks FOR - it is
// pattern data, not a physical class applied to an element.
const UTILITY_EXACT = ['text-left', 'text-right', 'origin-left', 'origin-right', 'float-left', 'float-right'];

const PREFIX_RE = new RegExp(
  `\\b(${UTILITY_PREFIXES.map((p) => p.replace('-', '\\-')).join('|')})-[\\w./\\[\\]%:-]+`,
  'g',
);
const EXACT_RE = new RegExp(`\\b(${UTILITY_EXACT.join('|')})\\b`, 'g');
const CSS_PROPERTY_RE =
  /\b(margin-left|margin-right|padding-left|padding-right|marginLeft|marginRight|paddingLeft|paddingRight)\s*[:(]/g;
const CSS_SIDE_RE = /(?<![\w-])(left|right)\s*:/g;
const RTL_OK_RE = /rtl-ok:\s*\S/;
const PROSE_WORDS = new Set(['to', 'aligned', 'aligns', 'align', 'hand', 'handed', 'side', 'leaning']);

function looksLikeProse(token: string): boolean {
  return token.split('-').some((seg) => PROSE_WORDS.has(seg.replace(/[^a-z]/gi, '').toLowerCase()));
}

function classifyLine(line: string, inBlock: boolean): { isComment: boolean; inBlock: boolean } {
  const t = line.trim();
  if (inBlock) return { isComment: true, inBlock: !t.includes('*/') };
  if (t === '') return { isComment: true, inBlock: false };
  if (t.startsWith('//')) return { isComment: true, inBlock: false };
  const opensBlock = t.startsWith('/*') || t.startsWith('{/*');
  if (opensBlock) return { isComment: true, inBlock: !t.includes('*/') };
  return { isComment: false, inBlock: false };
}

function collectMatches(line: string, isCssFile: boolean): string[] {
  const found: string[] = [];
  for (const re of [PREFIX_RE, EXACT_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) found.push(m[0]);
  }
  if (
    isCssFile ||
    /style\s*=\s*\{\{/.test(line) ||
    /^\s*(left|right|margin-left|margin-right|padding-left|padding-right)\s*:/.test(line)
  ) {
    for (const re of [CSS_PROPERTY_RE, CSS_SIDE_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line))) found.push(m[1] ?? m[0]);
    }
  }
  return found;
}

interface Offender {
  file: string;
  line: number;
  matches: string[];
  text: string;
}

function findOffenders(files: Record<string, string>): Offender[] {
  const offenders: Offender[] = [];

  for (const [file, content] of Object.entries(files)) {
    const isCssFile = file.endsWith('.css');
    const lines = content.split('\n');

    let inBlock = false;
    const commentLine = lines.map((line) => {
      const { isComment, inBlock: next } = classifyLine(line, inBlock);
      inBlock = next;
      return isComment;
    });

    function markedByBlockAbove(i: number): boolean {
      let j = i - 1;
      while (j >= 0 && commentLine[j]) {
        if (RTL_OK_RE.test(lines[j])) return true;
        j -= 1;
      }
      return false;
    }

    lines.forEach((line, i) => {
      if (commentLine[i]) return;
      const matches = collectMatches(line, isCssFile);
      if (matches.length === 0) return;

      const realMatches = [...new Set(matches)].filter((tok) => !looksLikeProse(tok));
      if (realMatches.length === 0) return;

      const markedHere = RTL_OK_RE.test(line);
      if (markedHere || markedByBlockAbove(i)) return;

      offenders.push({ file, line: i + 1, matches: realMatches, text: line.trim() });
    });
  }

  return offenders;
}

// Every source file this test itself needs scanned - the same tree
// `scripts/rtl-physical-classes.mjs` walks. `?raw` reads file content as a
// plain string; `eager: true` resolves the glob at collection time rather
// than returning loader functions, since a synchronous list is all this
// needs.
const files = import.meta.glob('./**/*.{ts,tsx,css}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

describe('rtl physical-direction classes', () => {
  it('has no unmarked left/right Tailwind classes or CSS properties', () => {
    const offenders = findOffenders(files);
    const report = offenders.map((o) => `${o.file}:${o.line}  [${o.matches.join(', ')}]  ${o.text}`);
    expect(report).toEqual([]);
  });
});
