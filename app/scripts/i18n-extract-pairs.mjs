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
import ts from 'typescript';
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
    // .jsx/.js too: 88 legacy files are mid-migration and the pre-auth screens
    // are among them. A .tsx-only glob silently extracted nothing for them.
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.test\.(tsx?|jsx?)$/.test(e.name)) out.push(full);
  }
  return out;
}

const files = dirs.flatMap((d) => {
  const full = path.join(SRC, d);
  return fs.statSync(full).isDirectory() ? walk(full) : [full];
});

const esc = ns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// t('ns.key') || 'English'  /  ... || "English"  /  ... || `English`
// Opening of a call; the params object and the fallback are then read by
// balance-matching, because `\{[^}]*\}` cannot span a NESTED params object and
// silently dropped every call that had one.
const CALL_OPEN = new RegExp(`(?:\\bt|\\btranslateNow)\\(\\s*'(${esc}\\.[A-Za-z0-9_.]+)'`, 'g');

/** Index just past the balanced `{...}` (or `(...)`) starting at `i`. */
function matchBrace(src, i, open = '{', close = '}') {
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    const c = src[j];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      j += 1;
      while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) { depth -= 1; if (depth === 0) return j + 1; }
  }
  return -1;
}

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

const pairs = new Map();
const conflicts = [];
// Every key ever SEEN, whether or not an English fallback was recovered. The
// difference between this and `pairs` is the completeness check below.
const seen = new Set();

/** One recording path, so <Trans> gets the same conflict check as t(). */
function record(key, text) {
  if (pairs.has(key) && pairs.get(key) !== text) {
    conflicts.push(`${key}\n    A: ${pairs.get(key)}\n    B: ${text}`);
  }
  pairs.set(key, text);
}
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(CALL_OPEN)) {
    const key = m[1];
    seen.add(key);
    let i = m.index + m[0].length;
    let paramsSrc = null;
    // optional `, { ... }`
    const comma = src.slice(i).match(/^\s*,\s*/);
    if (comma) {
      const braceAt = i + comma[0].length;
      if (src[braceAt] === '{') {
        const end = matchBrace(src, braceAt);
        if (end === -1) continue;
        paramsSrc = src.slice(braceAt, end);
        i = end;
      }
    }
    const close = src.slice(i).match(/^\s*\)/);
    if (!close) continue;
    i += close[0].length;
    const or = src.slice(i).match(/^\s*\|\|\s*/);
    if (!or) continue; // a call with no inline fallback carries no English
    i += or[0].length;
    const quote = src[i];
    if (quote !== "'" && quote !== '"' && quote !== '`') continue;
    let j = i + 1;
    while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
    const raw = src
      .slice(i + 1, j)
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\`/g, '`')
      .replace(/\\\\/g, '\\');
    record(key, canonicalise(raw, paramsSrc));
  }

  // <Trans k="..." fallback="..." /> read from the AST, not by scanning
  // forward: the old scan took the first `fallback=` ANYWHERE after the `k=`,
  // so a Trans whose fallback was braced stole the NEXT element's sentence,
  // and `fallback` before `k` never matched at all.
  if (/<Trans[\s>]/.test(src)) {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      const opening = ts.isJsxSelfClosingElement(node)
        ? node
        : ts.isJsxElement(node)
          ? node.openingElement
          : null;
      if (opening && opening.tagName.getText(sf) === 'Trans') {
        let key = null;
        let fallback = null;
        for (const attr of opening.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || !attr.initializer) continue;
          const name = attr.name.getText(sf);
          const init = attr.initializer;
          const literal = ts.isStringLiteral(init)
            ? init.text
            : ts.isJsxExpression(init) &&
                init.expression &&
                (ts.isStringLiteral(init.expression) ||
                  ts.isNoSubstitutionTemplateLiteral(init.expression))
              ? init.expression.text
              : null;
          if (name === 'k' && literal !== null) key = literal;
          if (name === 'fallback' && literal !== null) fallback = literal;
        }
        // A ternary `k=` resolves to two keys and cannot be read statically;
        // it is reported by the completeness check below rather than guessed.
        if (key !== null && key.startsWith(`${ns}.`)) {
          seen.add(key);
          if (fallback !== null) record(key, fallback);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
}

// Every key the scan SAW must have produced an English pair. A key that was
// seen and dropped is the worst outcome: it never reaches en.ts, never reaches
// a translator, and renders English forever with every guard green. The old
// regex dropped any call whose params held a nested object, silently and with
// exit 0.
const dropped = [...seen].filter((k) => !pairs.has(k));
if (dropped.length) {
  console.error(`KEYS SEEN BUT NOT EXTRACTED (${dropped.length}):`);
  for (const k of dropped) console.error(`  ${k}`);
  console.error('\n  Each needs an inline `|| \'English\'` fallback the scanner can read.');
  process.exit(1);
}

// A fallback that still holds `${...}` after canonicalisation is one the
// params could not explain - usually a template literal spanning lines, where
// the expression is not a plain identifier the params map back to. Emitting it
// writes unparseable text into the dictionary, so refuse and name the key.
const unresolved = [...pairs].filter(([, text]) => text.includes('${'));
if (unresolved.length) {
  console.error(`UNRESOLVED PLACEHOLDERS (${unresolved.length}):`);
  for (const [key, text] of unresolved) {
    console.error(`  ${key}\n    ${text.replace(/\n/g, ' ').slice(0, 120)}`);
  }
  console.error('\n  Give the call a plain identifier for each param, or precompute the value.');
  process.exit(1);
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
