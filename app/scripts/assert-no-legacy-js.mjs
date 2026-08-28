#!/usr/bin/env node
/**
 * Fails if any `.js` or `.jsx` file appears under `app/src`.
 *
 * `allowJs: false` in tsconfig means a stray `.js` is not a type error, it is
 * simply invisible: the file builds via Vite, ships to production, and the
 * compiler never looks at it. That is exactly how the strangler-fig migration
 * accumulated 16 unchecked modules behind hand-written `.d.ts` shims. This
 * turns the invisible case into a failing build.
 *
 * Build-time config (`vite.config.js`, `eslint.config.js`, `plugins/`) and the
 * Node i18n tooling in `scripts/` are deliberately out of scope: they are not
 * application source and never reach the browser.
 */
import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/** Every `.js`/`.jsx` path under `dir`, recursively. */
function findLegacyFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findLegacyFiles(full));
    else if (/\.jsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

const offenders = findLegacyFiles(SRC);

if (offenders.length > 0) {
  console.error(
    `\napp/src must be TypeScript only, found ${offenders.length} JavaScript file(s):\n` +
      offenders.map((f) => `  src/${relative(SRC, f)}`).join('\n') +
      '\n\nRename to .ts/.tsx. tsconfig sets allowJs:false, so these compile to\n' +
      'nothing and ship entirely unchecked.\n',
  );
  process.exit(1);
}

console.log('app/src: TypeScript only, no legacy JavaScript.');
