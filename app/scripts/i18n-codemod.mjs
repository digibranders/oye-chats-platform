#!/usr/bin/env node
/**
 * Apply the `t('key') || 'English'` idiom to the strings the inventory finds.
 *
 * The inventory already knows, from the AST, exactly which literals are
 * rendered copy and which are class names, ids or developer text. Re-deriving
 * that by hand for a thousand strings would be slow and would drift from the
 * guard that measures the work. This drives off the same analysis.
 *
 * DELIBERATELY CONSERVATIVE. It edits a line only when the exact text appears
 * on it exactly once and the surrounding syntax matches one of the three known
 * shapes. Anything ambiguous is reported and left alone for a human, because a
 * wrong edit here is a silent rendering bug, not a compile error.
 *
 * It does NOT add the import or the hook: which component owns a string is a
 * judgement call (several files render copy from an inner component, not the
 * exported one), and getting that wrong produces a runtime crash.
 *
 * Usage:
 *   node scripts/i18n-codemod.mjs --dir features/inbox --ns inbox --dry
 *   node scripts/i18n-codemod.mjs --dir features/inbox --ns inbox --apply
 *   node scripts/i18n-codemod.mjs --dir features/inbox --ns inbox --apply --fn translateNow
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const DIR = arg('--dir');
const NS = arg('--ns');
const FN = arg('--fn', 't');
const APPLY = args.includes('--apply');
if (!DIR || !NS) {
  console.error('usage: --dir <relative dir> --ns <dictionary namespace> [--apply] [--fn t|translateNow]');
  process.exit(2);
}

/**
 * JSX text is parsed with HTML entities; a JS string literal is not. Moving
 * `Loading&hellip;` from a text node into `t('k') || 'Loading&hellip;'` would
 * therefore render the six characters "&hellip;" to the user. Decode on the way
 * across so the fallback carries the character the entity stood for.
 */
const ENTITIES = {
  '&hellip;': '\u2026',
  '&mdash;': '\u2014',
  '&ndash;': '\u2013',
  '&rsquo;': '\u2019',
  '&lsquo;': '\u2018',
  '&rdquo;': '\u201d',
  '&ldquo;': '\u201c',
  '&nbsp;': '\u00a0',
  '&times;': '\u00d7',
  '&middot;': '\u00b7',
  '&bull;': '\u2022',
  '&deg;': '\u00b0',
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
};
function decodeEntities(text) {
  return text.replace(/&(?:hellip|mdash|ndash|rsquo|lsquo|rdquo|ldquo|nbsp|times|middot|bull|deg|quot|apos|amp);/g,
    (m) => ENTITIES[m] ?? m);
}

/** "Save changes" -> saveChanges ; "Couldn’t load." -> couldntLoad */
function keyFor(text) {
  const words = text
    .replace(/[’']/g, '')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 5);
  if (words.length === 0) return 'text';
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

/** Escape a string for a single-quoted JS literal. */
const jsQuote = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const raw = execFileSync(
  'node',
  [path.join(HERE, 'i18n-inventory.mjs'), '--json', '--dir', DIR],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
const { hits } = JSON.parse(raw);
const todo = hits.filter(
  (h) =>
    !h.localized &&
    // Exemptions are decisions with a reason recorded at the site; the codemod
    // must honour them or it silently translates the strings someone
    // deliberately kept English. It had already rewritten five sentences of the
    // install briefing that carries an @i18n-exempt-file: header.
    !h.exempt &&
    (h.class === 'localizable UI text' || h.class === 'accessibility text') &&
    // Module-scope literals are evaluated once at import, before any locale
    // exists. Wrapping one in t() either fails to compile (no `t` in scope) or,
    // with the module-level function, freezes English at import and survives
    // every language switch. Those tables need a key resolved at the RENDER
    // site instead, which is a judgement call about where they are consumed.
    h.inFunction !== false,
);

const byFile = new Map();
for (const h of todo) {
  if (!byFile.has(h.file)) byFile.set(h.file, []);
  byFile.get(h.file).push(h);
}

let patched = 0;
const skipped = [];
const usedKeys = new Map();

for (const [file, fileHits] of byFile) {
  const full = path.join(SRC, file);
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  // Descending so earlier line numbers stay valid as we edit.
  fileHits.sort((a, b) => b.line - a.line);

  for (const h of fileHits) {
    const i = h.line - 1;
    const line = lines[i];
    if (line === undefined) {
      skipped.push(`${file}:${h.line} line missing`);
      continue;
    }
    const text = h.text;
    // Only JSX text was entity-parsed by the compiler. A string literal or an
    // attribute value already holds its characters verbatim, so decoding one
    // would corrupt a legitimate "&amp;". The literal we WRITE is decoded; the
    // text we MATCH against the source line is not, because the source still
    // holds the entity.
    const decoded = h.kind === 'jsx-text' ? decodeEntities(text) : text;
    let key = `${NS}.${keyFor(decoded)}`;
    // Two different sentences can truncate to the same five words. Silently
    // overwriting gave two call sites one key and two different inline
    // English strings, so one of them renders the other's sentence.
    if (usedKeys.has(key) && usedKeys.get(key) !== decoded) {
      let n = 2;
      while (usedKeys.has(`${key}${n}`) && usedKeys.get(`${key}${n}`) !== decoded) n += 1;
      console.log(`  key collision: ${key} -> ${key}${n} (${JSON.stringify(decoded).slice(0, 50)})`);
      key = `${key}${n}`;
    }
    usedKeys.set(key, decoded);
    const call = `${FN}(${jsQuote(key)})`;
    // `a ?? t('k') || 'b'` is a TS5076 error: ?? cannot be mixed with || without
    // parentheses. Wrapping unconditionally on such lines is cheaper than
    // reasoning about precedence per site, and reads no worse.
    const needsParens = line.includes('??');
    const wrap = (expr) => (needsParens ? `(${expr})` : expr);

    let next = null;
    if (h.kind === 'attr') {
      const dq = `${h.attr}="${text}"`;
      const sq = `${h.attr}='${text}'`;
      if (line.split(dq).length === 2) next = line.replace(dq, `${h.attr}={${call} || ${jsQuote(text)}}`);
      else if (line.split(sq).length === 2) next = line.replace(sq, `${h.attr}={${call} || ${jsQuote(text)}}`);
    } else if (h.kind === 'literal') {
      const sq = `'${text}'`;
      const dq = `"${text}"`;
      if (line.split(sq).length === 2) next = line.replace(sq, wrap(`${call} || ${jsQuote(text)}`));
      else if (line.split(dq).length === 2) next = line.replace(dq, wrap(`${call} || ${jsQuote(text)}`));
    } else if (h.kind === 'jsx-text') {
      // Only single-line, unbraced JSX text. Multi-line nodes and anything
      // already inside an expression are left for a human.
      if (line.split(text).length === 2 && !line.includes('{') && !line.includes('}')) {
        next = line.replace(text, `{${call} || ${jsQuote(decoded)}}`);
      }
    }

    if (next === null || next === line) {
      skipped.push(`${file}:${h.line} (${h.kind}) ${JSON.stringify(text).slice(0, 60)}`);
      continue;
    }
    lines[i] = next;
    patched += 1;
  }
  if (APPLY) fs.writeFileSync(full, lines.join('\n'));
}

console.log(`${APPLY ? 'PATCHED' : 'WOULD PATCH'}: ${patched}`);
console.log(`SKIPPED (need a human): ${skipped.length}`);
for (const s of skipped.slice(0, 40)) console.log('  ' + s);

// Emit the English entries so the dictionary can be assembled from the same
// source of truth rather than retyped.
const out = {};
for (const [key, text] of usedKeys) {
  const leaf = key.slice(NS.length + 1);
  out[leaf] = text;
}
fs.writeFileSync(
  path.join(HERE, `..`, `.i18n-keys-${NS}.json`),
  JSON.stringify(out, null, 2),
);
console.log(`\nkeys written to .i18n-keys-${NS}.json (${Object.keys(out).length})`);
