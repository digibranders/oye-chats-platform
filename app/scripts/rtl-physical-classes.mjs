#!/usr/bin/env node
/**
 * Inventories every physical-direction Tailwind utility (and physical inline
 * style) in `app/src`, so the RTL conversion has a checklist and, once done,
 * a regression guard.
 *
 * A "physical" utility hardcodes left or right regardless of reading
 * direction (`ml-2`, `text-right`, `rounded-tl-lg`). Tailwind v4's logical
 * utilities (`ms-`, `me-`, `text-start`, `rounded-ss-`, ...) resolve against
 * `dir` instead, which is what lets one bundle serve both English and
 * Arabic. `justify-self-start` / `justify-self-end` are already logical and
 * are never flagged.
 *
 * A line is exempt when it, or the comment block immediately above it,
 * carries an `rtl-ok:` marker explaining why mirroring would be *wrong*
 * there (a centered spinner, a numeric chart axis). "The comment block
 * immediately above" is every contiguous comment/blank line walking
 * upward — so a multi-line `//` run or a `/* ... *\/` block only needs the
 * marker text somewhere inside it, not on the exact adjacent line. The
 * marker is intentionally not just `rtl-ok` - the reason is the point, and
 * an empty one is rejected.
 *
 * Usage:
 *   node scripts/rtl-physical-classes.mjs            human-readable report
 *   node scripts/rtl-physical-classes.mjs --json      machine-readable, for the vitest guard
 *
 * Exit code is non-zero whenever there is at least one UNMARKED offender.
 * Marked (rtl-ok) offenders are reported but never fail the run - they are
 * the accepted, reviewed exceptions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

const SOURCE_EXT = /\.(tsx?|jsx?|css)$/;

/**
 * Tailwind utility prefixes that hardcode a physical side. Matched with a
 * leading `\b` so `html-` never matches inside `ml-` and so on.
 */
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

/** Standalone utilities with no variable suffix. */
const UTILITY_EXACT = [
  'text-left',
  'text-right',
  'origin-left',
  'origin-right',
  'float-left',
  'float-right',
];

const PREFIX_RE = new RegExp(
  `\\b(${UTILITY_PREFIXES.map((p) => p.replace('-', '\\-')).join('|')})-[\\w./\\[\\]%:-]+`,
  'g',
);
const EXACT_RE = new RegExp(`\\b(${UTILITY_EXACT.join('|')})\\b`, 'g');

/** Physical CSS properties, for inline `style={{...}}` and plain `.css` files. */
const CSS_PROPERTY_RE =
  /\b(margin-left|margin-right|padding-left|padding-right|marginLeft|marginRight|paddingLeft|paddingRight)\s*[:(]/g;
/** Bare `left:` / `right:` declarations (CSS or inline style objects only - guarded by caller). */
const CSS_SIDE_RE = /(?<![\w-])(left|right)\s*:/g;

const RTL_OK_RE = /rtl-ok:\s*\S/;

/**
 * English words that turn a prefix match into prose rather than a class
 * ("right-to-left", "left-aligned.", "right-hand side"). No real Tailwind
 * utility suffix is one of these, so any match containing one as a
 * hyphen-separated segment - punctuation stripped - is discarded.
 */
const PROSE_WORDS = new Set(['to', 'aligned', 'aligns', 'align', 'hand', 'handed', 'side', 'leaning']);

function looksLikeProse(token) {
  return token
    .split('-')
    .some((seg) => PROSE_WORDS.has(seg.replace(/[^a-z]/gi, '').toLowerCase()));
}

/**
 * Whether `line` is entirely comment (or blank), given the block-comment
 * state carried in from previous lines. Returns the updated state alongside
 * so the caller can thread it across a whole file in one pass.
 */
function classifyLine(line, inBlock) {
  const t = line.trim();
  if (inBlock) {
    return { isComment: true, inBlock: !t.includes('*/') };
  }
  if (t === '') return { isComment: true, inBlock: false };
  if (t.startsWith('//')) return { isComment: true, inBlock: false };
  const opensBlock = t.startsWith('/*') || t.startsWith('{/*');
  if (opensBlock) return { isComment: true, inBlock: !t.includes('*/') };
  return { isComment: false, inBlock: false };
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(full);
  }
  return out;
}

function collectMatches(line, isCssFile) {
  const found = [];
  for (const re of [PREFIX_RE, EXACT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) found.push(m[0]);
  }
  // CSS properties only make sense inside a `style={{ }}` object or a .css
  // file - scanning JSX class strings for `left:` would flag object-literal
  // colons that have nothing to do with direction.
  if (isCssFile || /style\s*=\s*\{\{/.test(line) || /^\s*(left|right|margin-left|margin-right|padding-left|padding-right)\s*:/.test(line)) {
    for (const re of [CSS_PROPERTY_RE, CSS_SIDE_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) found.push(m[1] ?? m[0]);
    }
  }
  return found;
}

const files = walk(SRC);
const offenders = [];
const exceptions = [];

for (const file of files) {
  const rel = path.relative(SRC, file);
  const isCssFile = file.endsWith('.css');
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  // One classification pass per line, in order, so block-comment state
  // threads correctly top to bottom.
  let inBlock = false;
  const commentLine = lines.map((line) => {
    const { isComment, inBlock: next } = classifyLine(line, inBlock);
    inBlock = next;
    return isComment;
  });

  /** Does the contiguous comment run ending at `lines[i - 1]` carry the marker? */
  function markedByBlockAbove(i) {
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
    const record = { file: `src/${rel}`, line: i + 1, matches: realMatches, text: line.trim() };

    if (markedHere || markedByBlockAbove(i)) exceptions.push(record);
    else offenders.push(record);
  });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ offenders, exceptions }, null, 2));
} else {
  console.log(`rtl-physical-classes: scanned ${files.length} files under src/`);
  console.log(`  unmarked physical-direction usages: ${offenders.length}`);
  console.log(`  marked (rtl-ok) exceptions: ${exceptions.length}`);
  if (offenders.length > 0) {
    console.log('\nUnmarked offenders:');
    for (const o of offenders) {
      console.log(`  ${o.file}:${o.line}  [${o.matches.join(', ')}]  ${o.text.slice(0, 100)}`);
    }
  }
}

process.exitCode = offenders.length > 0 && !process.argv.includes('--allow-unmarked') ? 1 : 0;
