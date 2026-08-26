#!/usr/bin/env node
/**
 * Delete dictionary keys by PATH, from every dictionary at once.
 *
 * Line-matching on the leaf name is not safe: `loading` exists in more than one
 * namespace, and deleting the wrong one is a silent English string on a Hindi
 * screen. This parses the namespace block, deletes the path, and re-renders
 * just that block, so the edit is scoped and the diff stays readable.
 *
 * Usage: node scripts/i18n-remove-keys.mjs <dotted.key> [<dotted.key>...]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCALES = path.resolve(HERE, '..', 'src', 'i18n', 'locales');
const keys = process.argv.slice(2);
if (keys.length === 0) {
  console.error('usage: i18n-remove-keys.mjs <dotted.key> [...]');
  process.exit(2);
}

const byNs = new Map();
for (const key of keys) {
  const [ns, ...rest] = key.split('.');
  if (rest.length === 0) {
    console.error(`refusing to delete a whole namespace: ${key}`);
    process.exit(1);
  }
  if (!byNs.has(ns)) byNs.set(ns, []);
  byNs.get(ns).push(rest.join('.'));
}

for (const file of fs.readdirSync(LOCALES).filter((f) => /\.ts$/.test(f))) {
  const full = path.join(LOCALES, file);
  for (const [ns, paths] of byNs) {
    const src = fs.readFileSync(full, 'utf8');
    const start = src.indexOf(`\n  ${ns}: {`);
    if (start === -1) continue;

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
    const obj = Function(`"use strict"; return (${src.slice(open, i + 1)});`)();

    let removed = 0;
    for (const p of paths) {
      const parts = p.split('.');
      let cur = obj;
      for (const part of parts.slice(0, -1)) {
        if (typeof cur?.[part] !== 'object') { cur = null; break; }
        cur = cur[part];
      }
      const leaf = parts[parts.length - 1];
      // `leaf in cur` also sees the prototype chain, so `toString` and
      // `constructor` "existed" and triggered a needless rewrite of the block.
      if (cur && Object.prototype.hasOwnProperty.call(cur, leaf)) {
        delete cur[leaf];
        removed += 1;
      }
    }
    if (removed === 0) continue;

    fs.writeFileSync(full, src.slice(0, start) + src.slice(i + 1).replace(/^,/, ''));
    const tmp = path.join(HERE, `.remove-${ns}.json`);
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    // --nested: the object below is ALREADY the parsed dictionary. Without it
    // `nest()` re-splits every key on '.', and a canned-response key like
    // "Sent the info." becomes {'Sent the info': {'': ...}} - a silent
    // corruption of a key this delete was not asked to touch.
    execFileSync('node', [path.join(HERE, 'i18n-write-ns.mjs'), full, ns, tmp, '--nested'], {
      stdio: 'inherit',
    });
    fs.unlinkSync(tmp);
    console.log(`${file}: ${ns} -${removed}`);
  }
}
