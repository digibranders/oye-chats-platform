#!/usr/bin/env node
/**
 * Merge a namespace of key/English pairs into a dictionary file.
 *
 * MERGES, never replaces. The extractor can only see keys written as
 * `t('k') || 'English'`; keys built from a variable at runtime are invisible to
 * it, and overwriting a namespace with only what it found silently deletes
 * them. Existing values win, so re-running is idempotent and never clobbers a
 * translation that has been reviewed.
 *
 * Usage: node scripts/i18n-write-ns.mjs <dict file> <ns> <pairs.json> [--force]
 */
import fs from 'node:fs';

const [file, ns, jsonPath, ...rest] = process.argv.slice(2);
if (!file || !ns || !jsonPath) {
  console.error('usage: i18n-write-ns.mjs <dict file> <ns> <pairs.json> [--force]');
  process.exit(2);
}
// --force lets an English correction land on top of a stale value; without it
// an existing entry is left exactly as it is.
const FORCE = rest.includes('--force');

const flat = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

/** Keys arrive dotted ("table.range"); the dictionary is nested. */
function nest(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') { out[k] = nest(v); continue; }
    const parts = k.split('.');
    let cur = out;
    for (const p of parts.slice(0, -1)) {
      if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = v;
  }
  return out;
}

/** Parse the existing block back out of the file so nothing in it is lost. */
function parseBlock(src, start) {
  let depth = 0;
  let i = src.indexOf('{', start);
  const open = i;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length && src[i] !== quote) i += src[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) break; }
  }
  return { body: src.slice(open, i + 1), end: i + 1 };
}

/**
 * Read the existing block back into an object.
 *
 * Parsed by evaluating the literal rather than scanning lines: the dictionary
 * mixes one-per-line entries with single-line nested objects, and a line-based
 * reader silently DROPS the inline ones - which means a merge deletes real
 * keys. This is our own generated source, never user input.
 */
function readExisting(body) {
  try {
    return Function(`"use strict"; return (${body});`)();
  } catch (err) {
    console.error(`could not parse the existing ${ns} block: ${err.message}`);
    process.exit(1);
  }
}

function merge(existing, incoming) {
  const out = { ...existing };
  let added = 0;
  let changed = 0;
  for (const [k, v] of Object.entries(incoming)) {
    if (v && typeof v === 'object') {
      const sub = merge(typeof out[k] === 'object' && out[k] !== null ? out[k] : {}, v);
      out[k] = sub.value; added += sub.added; changed += sub.changed;
      continue;
    }
    if (!(k in out)) { out[k] = v; added += 1; }
    else if (FORCE && out[k] !== v) { out[k] = v; changed += 1; }
  }
  return { value: out, added, changed };
}

const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
// Some keys are not identifiers - the canned-response namespace keys entries by
// their English label, spaces included - so they have to be written quoted or
// the file will not parse.
const propKey = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : q(k));
function render(obj, indent) {
  const pad = ' '.repeat(indent);
  return Object.keys(obj)
    .sort()
    .map((k) =>
      typeof obj[k] === 'string'
        ? `${pad}${propKey(k)}: ${q(obj[k])},`
        : `${pad}${propKey(k)}: {\n${render(obj[k], indent + 2)}\n${pad}},`,
    )
    .join('\n');
}

let src = fs.readFileSync(file, 'utf8');
const start = src.indexOf(`\n  ${ns}: {`);
let existing = {};
let head = src;
let tail = '';
if (start !== -1) {
  const { body, end } = parseBlock(src, start);
  existing = readExisting(body);
  head = src.slice(0, start);
  tail = src.slice(end).replace(/^,/, '');
} else {
  const anchor = src.lastIndexOf('\n} as const;');
  head = src.slice(0, anchor);
  tail = src.slice(anchor);
}
const { value, added, changed } = merge(existing, nest(flat));
const block = `\n  ${ns}: {\n${render(value, 4)}\n  },`;
fs.writeFileSync(file, head + block + tail);
console.log(`${file}: ${ns} -> ${Object.keys(value).length} top-level keys (+${added} added, ${changed} updated)`);
