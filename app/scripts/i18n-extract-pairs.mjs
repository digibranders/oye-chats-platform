#!/usr/bin/env node
/**
 * Read back the `t('ns.key') || 'English'` pairs the source actually renders.
 *
 * The dictionary must say exactly what the fallback says, and the fallback is
 * the thing that ships. Retyping the English into en.ts by hand is how the two
 * drift; this reads it from the source of truth instead.
 *
 * Usage: node scripts/i18n-extract-pairs.mjs <ns> <dir> [<dir>...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const [ns, ...dirs] = process.argv.slice(2);
if (!ns || dirs.length === 0) {
  console.error('usage: i18n-extract-pairs.mjs <ns> <dir> [<dir>...]');
  process.exit(2);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

const files = dirs.flatMap((d) => {
  const full = path.join(SRC, d);
  return fs.statSync(full).isDirectory() ? walk(full) : [full];
});

const esc = ns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// t('ns.key') || 'English'  /  ... || "English"  /  ... || `English`
const CALL = new RegExp(
  `(?:t|translateNow)\\(\\s*'(${esc}\\.[A-Za-z0-9_.]+)'\\s*(?:,\\s*(\\{[^}]*\\})\\s*)?\\)\\s*\\|\\|\\s*(['"\`])((?:\\\\.|(?!\\3)[\\s\\S])*?)\\3`,
  'g',
);

/**
 * A parameterised call's fallback is a template literal, so its English reads
 * `Created ${createdDate}` - the local variable name, which differs per call
 * site and is not the placeholder the dictionary uses. Map each `${expr}` back
 * through the call's own params object (`{ date: createdDate }`) to recover the
 * canonical `Created {date}`. Doing it from the params rather than by hand is
 * what keeps en.ts placeholders identical to what the call actually passes,
 * which is exactly what the parity test asserts.
 */
function canonicalise(text, paramsSrc) {
  if (!text.includes('${')) return text;
  const byExpr = new Map();
  if (paramsSrc) {
    for (const m of paramsSrc.matchAll(/([A-Za-z0-9_]+)\s*:\s*([^,}]+)/g)) {
      byExpr.set(m[2].trim(), m[1]);
    }
    // Shorthand: `{ plan, quota }` names the placeholder and the expression at
    // once, so `${plan}` is already `{plan}`.
    for (const m of paramsSrc.matchAll(/(?:^\{|,)\s*([A-Za-z0-9_]+)\s*(?=[,}])/g)) {
      byExpr.set(m[1], m[1]);
    }
  }
  return text.replace(/\$\{([^}]+)\}/g, (whole, expr) => {
    const name = byExpr.get(expr.trim());
    return name ? `{${name}}` : whole;
  });
}
// <Trans k="ns.key" fallback="English" />, either attribute order
const TRANS_K = new RegExp(`k="(${esc}\\.[A-Za-z0-9_.]+)"`, 'g');

const pairs = new Map();
const conflicts = [];
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(CALL)) {
    const key = m[1];
    const raw = m[4].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`').replace(/\\\\/g, '\\');
    const text = canonicalise(raw, m[2]);
    if (pairs.has(key) && pairs.get(key) !== text) {
      conflicts.push(`${key}\n    A: ${pairs.get(key)}\n    B: ${text}`);
    }
    pairs.set(key, text);
  }
  for (const m of src.matchAll(TRANS_K)) {
    const key = m[1];
    const after = src.slice(m.index);
    const fb = after.match(/fallback="([^"]*)"/);
    if (fb) pairs.set(key, fb[1]);
  }
}

if (conflicts.length) {
  // Two call sites disagreeing on the English for one key is a real bug: one of
  // them will silently render the other's sentence once the key resolves.
  console.error(`CONFLICTING FALLBACKS (${conflicts.length}):`);
  for (const c of conflicts) console.error('  ' + c);
  process.exit(1);
}

const out = {};
for (const [key, text] of [...pairs].sort(([a], [b]) => a.localeCompare(b))) {
  out[key.slice(ns.length + 1)] = text;
}
console.log(JSON.stringify(out, null, 2));
