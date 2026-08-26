#!/usr/bin/env node
/**
 * Add the i18n import and the `const { t } = useTranslation();` line to every
 * function that actually calls `t(...)`.
 *
 * Doing this by eye is where the mistakes were: several files render their copy
 * from an INNER component rather than the exported one, so a hook placed in the
 * obvious function type-checks in isolation and then throws "Cannot find name
 * 't'" or, worse, silently sits in a component that renders nothing. The AST
 * knows which function encloses each call; this asks it.
 *
 * Two placements, chosen per file:
 *   - React components (a function whose body contains JSX, name starting
 *     uppercase): the hook, so the component re-renders on a locale change.
 *   - Plain modules (hooks files, helpers, non-component functions): the calls
 *     are rewritten to the module-level `translateNow`, which is stable and
 *     resolves at call time. A React hook cannot be called there at all.
 *
 * Usage: node scripts/i18n-wire-hooks.mjs --dir features/inbox [--apply]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');
const args = process.argv.slice(2);
const DIR = args[args.indexOf('--dir') + 1];
const APPLY = args.includes('--apply');
if (!DIR) {
  console.error('usage: --dir <relative dir> [--apply]');
  process.exit(2);
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const relToI18n = (file) => {
  const rel = path.relative(path.dirname(file), path.join(SRC, 'i18n')).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
};

let changed = 0;
const notes = [];

for (const file of walk(path.join(SRC, DIR))) {
  let source = fs.readFileSync(file, 'utf8');
  if (!/\bt\(\s*['"`]/.test(source)) continue;
  if (source.includes('useTranslation') || source.includes('translateNow')) continue;

  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // Which functions contain a t() call, and do they render JSX?
  const targets = [];
  const visit = (node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      let callsT = false;
      let hasJsx = false;
      const inner = (n) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 't') callsT = true;
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) hasJsx = true;
        ts.forEachChild(n, inner);
      };
      ts.forEachChild(node, inner);
      if (callsT) {
        // An arrow function or function expression has no `name` of its own:
        // `const Panel = () => ...` carries it on the variable declaration.
        // Reading only node.name misclassified every arrow component in the
        // codebase as module scope, which would have put `translateNow` in a
        // component and quietly stopped it re-rendering on a locale change.
        let name = node.name?.getText(sf) ?? '';
        if (!name && node.parent && ts.isVariableDeclaration(node.parent)) {
          name = node.parent.name.getText(sf);
        }
        const isComponent = hasJsx && /^[A-Z]/.test(name);
        targets.push({ node, isComponent, name });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (targets.length === 0) continue;

  // Innermost COMPONENT per call site.
  //
  // The nesting filter has to run over components only. An event handler or a
  // `.map` callback inside JSX is itself a function that calls t(), and being
  // the innermost match it displaced the component that should own the hook,
  // leaving the file looking like module scope. The hook belongs to the
  // component; inner closures just capture it.
  const componentTargets = targets.filter((x) => x.isComponent);
  const componentOwners = componentTargets.filter(
    (a) =>
      !componentTargets.some((b) => b !== a && b.node.pos >= a.node.pos && b.node.end <= a.node.end),
  );

  const rel = relToI18n(file);

  if (componentOwners.length === 0) {
    // Not a component: a React hook is illegal here.
    source = source.replace(/\bt\(\s*(['"`])/g, 'translateNow($1');
    const lastImport = [...source.matchAll(/^import .*?;$/gms)].pop();
    const insertAt = lastImport ? lastImport.index + lastImport[0].length : 0;
    source =
      source.slice(0, insertAt) +
      `\nimport { t as translateNow } from '${rel}/i18n';` +
      source.slice(insertAt);
    notes.push(`${path.relative(SRC, file)}: module scope -> translateNow`);
  } else {
    // Insert the hook into each owning component, deepest first so offsets hold.
    const inserts = componentOwners
      .map((o) => {
        const body = o.node.body;
        if (!body || !ts.isBlock(body)) return null;
        return { pos: body.getStart(sf) + 1, name: o.name };
      })
      .filter(Boolean)
      .sort((a, b) => b.pos - a.pos);

    for (const ins of inserts) {
      source = source.slice(0, ins.pos) + '\n  const { t } = useTranslation();' + source.slice(ins.pos);
    }
    const lastImport = [...source.matchAll(/^import .*?;$/gms)].pop();
    const insertAt = lastImport ? lastImport.index + lastImport[0].length : 0;
    source =
      source.slice(0, insertAt) +
      `\nimport { useTranslation } from '${rel}/useTranslation';` +
      source.slice(insertAt);
    notes.push(`${path.relative(SRC, file)}: hook into ${inserts.map((i) => i.name).join(', ')}`);
  }

  if (APPLY) fs.writeFileSync(file, source);
  changed += 1;
}

console.log(`${APPLY ? 'WIRED' : 'WOULD WIRE'}: ${changed} files`);
for (const n of notes) console.log('  ' + n);
