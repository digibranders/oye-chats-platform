#!/usr/bin/env node
/**
 * Dumps every (key, English, Arabic) triple to a plain-text file for the
 * Arabic dictionary's review pass — see docs/i18n/*-admin-arabic-*.md's
 * "Review pass one" and "Review pass two" steps.
 *
 * Usage: node scripts/i18n-ar-review-dump.mjs > /path/to/review.txt
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

function loadDict(file) {
  const raw = fs.readFileSync(path.join(SRC, 'i18n', 'locales', file), 'utf8');
  const body = raw.slice(raw.indexOf('{'), raw.lastIndexOf('} as const;') + '} as const;'.length);
  return Function(`"use strict"; return (${body.slice(0, -'as const;'.length)})`)();
}

function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[p] = v;
    else Object.assign(out, flatten(v, p));
  }
  return out;
}

const en = flatten(loadDict('en.ts'));
const ar = flatten(loadDict('ar.ts'));

const keys = Object.keys(en);
for (const key of keys) {
  console.log(`### ${key}`);
  console.log(`EN: ${en[key]}`);
  console.log(`AR: ${ar[key] ?? '(missing)'}`);
  console.log('');
}
console.error(`(dumped ${keys.length} keys to stdout)`);
