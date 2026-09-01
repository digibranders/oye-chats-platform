#!/usr/bin/env node
/**
 * Fails if an em dash or en dash appears in copy a customer will read.
 *
 * A dash used as sentence punctuation is the clearest tell of machine-written
 * text, and this console had 47 of them in `locales/en.ts` alone. The
 * marketing site already fails its build on the same rule
 * (`scripts/verify-html.mjs`, check W-1); the console produces just as much
 * customer-facing copy and had no equivalent, so the two drifted.
 *
 * What is checked: string literals in `src/`, which is where UI copy lives —
 * both the locale files and the `t('key') || 'English fallback'` literals that
 * ship whenever a key is missing.
 *
 * What is not: comments and JSDoc, which are written for the people editing
 * this repo rather than the people using the product, and `src/dev`, which is
 * the design-system gallery at `/dev/ui` — developer documentation that no
 * customer can reach.
 *
 * Two literals are allowed through, and both are notation rather than prose:
 * the standalone placeholder that marks a figure as absent, and a code paired
 * with its full name in a select ("INR — Indian Rupee").
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const DASH = /[—–]/;

/** The absent-figure placeholder: notation, not a sentence. */
const PLACEHOLDER = /^['"`]\s*[—–]\s*['"`]$/;
/** A code beside its full name, e.g. "INR — Indian Rupee". */
const CODE_LABEL = /^['"`][A-Z]{2,4} — [A-Z][A-Za-z ]+['"`]$/;

/** Quoted literals on one line. Good enough: copy is not written across lines. */
const LITERAL = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.)*`/g;

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // The `/dev/ui` gallery documents the design system for the people
    // building it. Its prose is not product copy.
    if (entry.isDirectory()) {
      if (entry.name === 'dev') continue;
      found.push(...sourceFiles(full));
    }
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

const offenders = [];
for (const file of sourceFiles(SRC)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  let inBlockComment = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      return;
    }
    // `{/* … */}` as well as `/* … */`: a JSX comment's continuation lines
    // start with whatever the author indented to, not with a `*`.
    const opensBlock = trimmed.startsWith('/*') || trimmed.startsWith('{/*');
    if (opensBlock) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      return;
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    if (!DASH.test(line)) return;
    for (const literal of line.match(LITERAL) ?? []) {
      if (!DASH.test(literal)) continue;
      if (PLACEHOLDER.test(literal) || CODE_LABEL.test(literal)) continue;
      offenders.push(`  src/${relative(SRC, file)}:${index + 1}  ${literal.slice(0, 100)}`);
    }
  });
}

if (offenders.length > 0) {
  console.error(
    `\nFound ${offenders.length} em dash or en dash in customer-facing copy:\n` +
      offenders.join('\n') +
      '\n\nRewrite the sentence rather than swapping the punctuation. A full stop or\n' +
      'semicolon between two clauses, a colon before an explanation, commas or\n' +
      'brackets around an aside, a comma before a tacked-on qualifier.\n' +
      'Number ranges take "to". If a sentence needs a dash to hold together, split it.\n',
  );
  process.exit(1);
}

console.log('app/src: no em dashes in customer-facing copy.');
