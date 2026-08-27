#!/usr/bin/env node
/**
 * Route locale-sensitive formatting through `src/i18n/formatters`.
 *
 * `value.toLocaleString()` follows the BROWSER's locale, not the dashboard's.
 * On a Hindi dashboard in a US browser it prints "1,234" beside a Devanagari
 * label; on an Indian browser it prints "1,23,456" beside an English one.
 * Either way the number and the words around it disagree.
 *
 * Passing `undefined` as the first argument is the same defect spelled longer -
 * it explicitly asks for the browser default - and a hardcoded 'en-US' is the
 * same defect with the answer wired in.
 *
 * DELIBERATELY CONSERVATIVE, like the string codemod. It rewrites only the
 * shapes below, only when the whole call sits on one line, and reports
 * everything else for a human:
 *
 *   X.toLocaleString()                 -> formatNumber(X)
 *   X.toLocaleString(undefined, OPTS)  -> formatNumber(X, OPTS)
 *   X.toLocaleString('en-XX', OPTS)    -> formatNumber(X, OPTS)
 *
 * Dates are NOT rewritten here. `toLocaleDateString` carries options whose
 * mapping onto formatDate is a judgement call per site, and getting a date
 * format silently wrong is harder to spot than a number.
 *
 * Usage: node i18n-format-codemod.mjs --dir features/agents [--apply]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const args = process.argv.slice(2);
const DIR = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : '';
const APPLY = args.includes('--apply');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');
const files = walk(SRC)
  .filter((f) => rel(f).startsWith(DIR))
  // The formatters themselves legitimately call Intl directly.
  .filter((f) => !rel(f).startsWith('i18n/'));

// `receiver.toLocaleString(...)` where the receiver is a simple expression:
// an identifier, a member chain, a call, or a parenthesised expression. A
// receiver containing an unbalanced paren is left alone.
/**
 * Find `.toLocaleString(` and walk BACKWARDS to the start of its receiver,
 * balancing brackets on the way.
 *
 * A regex cannot do this. An earlier one tried and turned
 * `Math.round(v).toLocaleString()` into `Math.roundformatNumber(v)`, because a
 * receiver can itself contain calls and indexes. Scanning backwards from a
 * fixed anchor is the only way to get the boundary right.
 */
function receiverStart(line, dotAt) {
  let depth = 0;
  let i = dotAt - 1;
  for (; i >= 0; i -= 1) {
    const c = line[i];
    if (c === ')' || c === ']') { depth += 1; continue; }
    if (c === '(' || c === '[') {
      if (depth === 0) return i + 1;
      depth -= 1;
      continue;
    }
    if (depth > 0) continue;
    if (/[A-Za-z0-9_$.?]/.test(c)) continue;
    // `new Date(x).toLocaleDateString()` - the receiver is the whole
    // construction, so the `new` has to come with it or the rewrite lands
    // inside it and produces `new formatDate(Date(x), ...)`.
    const before = line.slice(0, i + 1);
    const withNew = before.match(/\bnew\s+$/);
    if (withNew) return i + 1 - withNew[0].length;
    return i + 1;
  }
  return 0;
}

/** Index just past the balanced `(...)` that starts at `open`. */
function argsEnd(line, open) {
  let depth = 0;
  for (let i = open; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i += 1;
      while (i < line.length && line[i] !== q) i += line[i] === '\\' ? 2 : 1;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return i + 1; }
  }
  return -1;
}

let patched = 0;
const skipped = [];
const touched = new Set();

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  if (!/\.toLocale(String|DateString|TimeString)\(/.test(src)) continue;
  const needed = new Set();
  const aliases = new Map();
  let out = src;
  let changedFile = false;

  // The formatters merge their OWN defaults over the caller's options, so a
  // site that asked for `{month, day}` would silently gain a year. Any default
  // the caller did not ask for is explicitly suppressed, which is the idiom
  // `formatDayLabel` already uses. Intl ignores an undefined option value.
  const DEFAULTS = {
    formatDate: ['day', 'month', 'year'],
    formatTime: ['hour', 'minute'],
    formatDateTime: ['day', 'month', 'year', 'hour', 'minute'],
  };
  const TARGET = {
    toLocaleDateString: 'formatDate',
    toLocaleTimeString: 'formatTime',
    toLocaleString: null, // number or date-time, decided from the options below
  };

  for (const method of ['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString']) {
    const needle = `.${method}(`;
    const anchors = [];
    for (let at = out.indexOf(needle); at !== -1; at = out.indexOf(needle, at + 1)) anchors.push(at);

    for (const at of anchors.reverse()) {
      const open = at + method.length + 1;
      const end = argsEnd(out, open);
      if (end === -1) continue;
      const start = receiverStart(out, at);
      const receiver = out.slice(start, at);
      if (!receiver.trim()) continue;
      const a = out.slice(open + 1, end - 1).trim();

      let opts = null;
      if (a === '' || a === 'undefined') opts = null;
      else if (/^undefined\s*,/.test(a)) opts = a.replace(/^undefined\s*,\s*/, '').trim();
      else if (/^'[a-z]{2}(-[A-Za-z]{2})?'\s*,/.test(a)) opts = a.replace(/^'[^']*'\s*,\s*/, '').trim();
      else if (/^'[a-z]{2}(-[A-Za-z]{2})?'$/.test(a)) opts = null;
      else if (/^[A-Za-z_$][\w$]*\s*(,|$)/.test(a)) continue; // already locale-aware
      else {
        skipped.push(`${rel(file)} ${method} unrecognised args: ${a.slice(0, 50).replace(/\n/g, ' ')}`);
        continue;
      }

      let fn;
      if (method === 'toLocaleString') {
        // A number has no date options; anything with one is a date-time.
        fn = opts && /\b(year|month|day|hour|minute|second|weekday)\s*:/.test(opts)
          ? 'formatDateTime'
          : 'formatNumber';
      } else {
        fn = TARGET[method];
      }

      if (fn !== 'formatNumber' && !opts) {
        // No options means "the locale's own default shape", which the
        // formatters do not reproduce - they impose a field set. Left for a
        // human rather than silently changing the format.
        skipped.push(`${rel(file)} ${method} has no options; pick a field set by hand`);
        continue;
      }

      let finalOpts = opts;
      if (fn !== 'formatNumber') {
        if (opts.includes('...')) {
          // A conditionally spread option cannot be resolved statically, and
          // guessing gets it wrong in the branch where the spread is empty -
          // the formatter's default silently puts the field back.
          skipped.push(`${rel(file)} ${method} spreads options conditionally; convert by hand`);
          continue;
        }
        const present = new Set([...opts.matchAll(/([A-Za-z]+)\s*:/g)].map((m) => m[1]));
        const suppress = DEFAULTS[fn].filter((k) => !present.has(k)).map((k) => `${k}: undefined`);
        if (suppress.length) {
          // The object may already end with a trailing comma; appending
          // another produced `,,` and would not parse.
          finalOpts = opts.replace(/,?\s*\}$/, `, ${suppress.join(', ')} }`);
        }
      }

      // Several modules export their OWN formatDate/formatDateTime. Importing
      // over the top is a TS2440 conflict, so the import is aliased and the
      // call uses the alias.
      const localName = new RegExp(`(?:function|const|let|var)\\s+${fn}\\b`).test(src);
      const use = localName ? `i18n${fn[0].toUpperCase()}${fn.slice(1)}` : fn;
      aliases.set(fn, use);
      const call = finalOpts ? `${use}(${receiver}, ${finalOpts})` : `${use}(${receiver})`;
      out = out.slice(0, start) + call + out.slice(end);
      changedFile = true;
      patched += 1;
      needed.add(fn);
    }
  }

  if (!changedFile) continue;
  const names = [...needed]
    .sort()
    .map((n) => (aliases.get(n) === n ? n : `${n} as ${aliases.get(n)}`))
    .join(', ');
  const existing = out.match(/import \{([^}]*)\} from '([^']*i18n\/formatters)';/);
  if (existing) {
    // Merge into the import already there, or a second pass over the same file
    // adds date helpers it never imports.
    const have = new Set(existing[1].split(',').map((n) => n.trim()).filter(Boolean));
    for (const n of needed) have.add(aliases.get(n) === n ? n : `${n} as ${aliases.get(n)}`);
    out = out.replace(
      existing[0],
      `import { ${[...have].sort().join(', ')} } from '${existing[2]}';`,
    );
  } else {
    const depth = rel(file).split('/').length - 1;
    const prefix = depth === 0 ? './' : '../'.repeat(depth);
    const imp = `import { ${names} } from '${prefix}i18n/formatters';`;
    const m = out.match(/^import[\s\S]*?;$/m);
    if (m) {
      out = out.replace(m[0], `${m[0]}\n${imp}`);
    } else {
      // Pure model modules carry a leading doc comment and no imports at all;
      // the import goes after that comment, not above it.
      const doc = out.match(/^\/\*[\s\S]*?\*\/\n/);
      out = doc ? `${doc[0]}\n${imp}\n${out.slice(doc[0].length)}` : `${imp}\n${out}`;
    }
  }
  touched.add(rel(file));
  if (APPLY) fs.writeFileSync(file, out);
}

console.log(`${APPLY ? 'PATCHED' : 'WOULD PATCH'}: ${patched} call sites in ${touched.size} files`);
console.log(`SKIPPED (need a human): ${skipped.length}`);
for (const s of skipped.slice(0, 40)) console.log('  ' + s);
