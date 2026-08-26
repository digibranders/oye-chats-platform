#!/usr/bin/env node
/**
 * Dictionary keys nothing in the source asks for.
 *
 * The dictionary is merged, never replaced, so a key outlives the call site
 * that introduced it. Orphans are not a runtime failure - they are dead weight
 * in a lazily-loaded bundle and, worse, a translator's time spent on a string
 * no user will ever see.
 *
 * Keys reached through a template literal (`t(`agents.status.${health}`)`) have
 * no literal call site by design, so a PREFIX that appears in one counts as a
 * reference for everything beneath it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name) && !full.includes(`${path.sep}locales${path.sep}`)) out.push(full);
  }
  return out;
}

const sources = walk(SRC).map((f) => fs.readFileSync(f, 'utf8')).join('\n');

// Any key-SHAPED string literal counts as a reference, not only one sitting
// inside a `t(...)` call. Keys travel as data here - `labelKey: 'nav.agents'`
// on a nav item, `titleKey` on a nudge variant, `const quotaKey = ...` chosen
// by a branch - and a `t(`-anchored scan reports every one of those as dead.
const literal = new Set();
for (const m of sources.matchAll(/['"`]([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9_]+)+)['"`]/g)) {
  literal.add(m[1]);
}

// Dynamic prefixes: t(`agents.status.${x}`) -> "agents.status."
const prefixes = [];
for (const m of sources.matchAll(/(?:\bt|translateNow)\(\s*`([A-Za-z0-9_.]*?)\$\{/g)) {
  if (m[1]) prefixes.push(m[1]);
}

const en = fs.readFileSync(path.join(SRC, 'i18n', 'locales', 'en.ts'), 'utf8');
const body = en.slice(en.indexOf('{'), en.lastIndexOf('} as const;') + 1);
const dict = Function(`"use strict"; return (${body});`)();

const flat = [];
(function collect(obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') flat.push(key);
    else collect(v, key);
  }
})(dict, '');

const orphans = flat.filter(
  (k) => !literal.has(k) && !prefixes.some((p) => k.startsWith(p)),
);

console.log(`dictionary keys: ${flat.length}`);
console.log(`referenced literally: ${flat.length - orphans.length}`);
console.log(`ORPHANS: ${orphans.length}`);
for (const o of orphans) console.log('  ' + o);
process.exitCode = orphans.length > 0 && process.argv.includes('--strict') ? 1 : 0;
