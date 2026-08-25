#!/usr/bin/env node
/**
 * JSX-aware localization inventory for the admin dashboard.
 *
 * Grep is not sufficient here and has already undercounted this feature by 20x
 * once: it cannot see multi-line JSX text nodes, cannot tell a `className` from
 * a `placeholder`, and cannot distinguish a rendered sentence from an object
 * key that happens to read like English. This walks the real TypeScript AST
 * instead, so every hit is classified by the syntactic position it occupies.
 *
 * Usage:
 *   node scripts/i18n-inventory.mjs                 # summary
 *   node scripts/i18n-inventory.mjs --json          # machine-readable
 *   node scripts/i18n-inventory.mjs --dir features/inbox
 *   node scripts/i18n-inventory.mjs --list bare     # every unlocalized hit
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

/** Attributes whose string value is rendered to, or announced at, the user. */
const LOCALIZABLE_ATTRS = new Set([
  'placeholder',
  'title',
  'alt',
  'label',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'aria-description',
]);

/** Attributes that are markup/behaviour, never copy. */
const NEVER_LOCALIZABLE_ATTRS = new Set([
  'className', 'class', 'id', 'key', 'href', 'src', 'to', 'type', 'name', 'role',
  'd', 'viewBox', 'fill', 'stroke', 'xmlns', 'style', 'width', 'height', 'value',
  'htmlFor', 'target', 'rel', 'method', 'action', 'accept', 'autoComplete',
  'data-testid', 'aria-labelledby', 'aria-describedby', 'aria-controls',
  'aria-hidden', 'aria-live', 'aria-current', 'aria-expanded', 'aria-haspopup',
  'transform', 'points', 'cx', 'cy', 'r', 'x', 'y', 'x1', 'x2', 'y1', 'y2',
  'offset', 'stopColor', 'gradientUnits', 'patternUnits', 'clipPath', 'mask',
]);

/** Directories deferred by the Phase 7 plan. Counted, never scheduled. */
const DEFERRED_DIRS = [
  'features/workspace',
  'features/launch-studio',
  'features/agents/advanced',
  'features/system',
  'features/affiliate',
  'features/feedback',
  'context/upgradeIntents',
];

/** Phase assignment, first match wins. */
const PHASE_MAP = [
  ['features/agents/advanced', 'deferred'],
  ['features/workspace', 'deferred'],
  ['features/launch-studio', 'deferred'],
  ['features/affiliate', 'deferred'],
  ['features/feedback', 'deferred'],
  ['features/system', 'deferred'],
  ['shell', '7B'],
  ['features/settings', '7B'],
  ['design-system', '7B'],
  ['features/home', '7C'],
  ['features/inbox', '7C'],
  ['features/leads', '7C'],
  ['features/analytics', '7C'],
  ['features/agents', '7E'],
  ['pages', '7F'],
];

const CLASSES = {
  UI_TEXT: 'localizable UI text',
  A11Y: 'accessibility text',
  DYNAMIC: 'dynamic data',
  INTERNAL: 'internal developer text',
  CODE: 'code/identifier',
  SVG: 'SVG/data',
  DEFERRED: 'deferred scope',
  CUSTOMER: 'customer-authored content',
  UNCERTAIN: 'uncertain/manual review',
};

/** Locale-sensitive formatting calls, tracked separately for 7D. */
const FORMAT_CALLS = new Set([
  'toLocaleDateString', 'toLocaleTimeString', 'toLocaleString',
]);
const INTL_CTORS = new Set([
  'DateTimeFormat', 'NumberFormat', 'RelativeTimeFormat', 'ListFormat', 'PluralRules',
]);

function walkFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__snapshots__') continue;
      walkFiles(full, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      if (/\.(test|spec)\.[tj]sx?$/.test(entry.name)) continue;
      if (/\.d\.ts$/.test(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

const rel = (f) => path.relative(SRC, f).split(path.sep).join('/');

function phaseFor(relPath) {
  for (const [prefix, phase] of PHASE_MAP) {
    if (relPath.startsWith(prefix)) return phase;
  }
  return 'other';
}

function isDeferred(relPath) {
  return DEFERRED_DIRS.some((d) => relPath.startsWith(d));
}

/** Sentence-shaped: at least two words, starts like prose, not a token. */
function isSentenceShaped(text) {
  const t = text.trim();
  if (t.length < 3) return false;
  if (!/[A-Za-z]{2,}(\s| )+[A-Za-z]/.test(t)) return false;
  if (!/^[A-Z‘“"'(]/.test(t) && !/^[A-Z]/.test(t)) return false;
  // Tailwind-ish class soup and other machine tokens.
  if (/^[a-z-]+(\s+[a-z0-9:[\]/.#()-]+)+$/.test(t)) return false;
  if (/\b(flex|grid|rounded|border|text-|bg-|px-|py-|w-\d|h-\d)\b/.test(t)) return false;
  return true;
}

/** A single word that is still clearly UI copy (button labels etc.). */
function isSingleWordLabel(text) {
  const t = text.trim();
  return /^[A-Z][a-z]{2,}$/.test(t) && !/^(True|False|Null|Undefined)$/.test(t);
}

function classify({ relPath, kind, text, ctx }) {
  if (isDeferred(relPath)) return CLASSES.DEFERRED;
  if (kind === 'jsx-text') return CLASSES.UI_TEXT;
  if (kind === 'attr') return LOCALIZABLE_ATTRS.has(ctx.attr) && /^aria-|^title$|^alt$/.test(ctx.attr)
    ? CLASSES.A11Y
    : CLASSES.UI_TEXT;
  if (kind === 'literal') {
    if (ctx.inConsole || ctx.inThrow) return CLASSES.INTERNAL;
    if (ctx.inImport) return CLASSES.CODE;
    if (ctx.isPropertyKey) return CLASSES.CODE;
    if (isSentenceShaped(text)) return CLASSES.UI_TEXT;
    return CLASSES.UNCERTAIN;
  }
  return CLASSES.UNCERTAIN;
}

function scanFile(file) {
  const relPath = rel(file);
  const source = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits = [];
  const formatSites = [];
  let tCalls = 0;

  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node) => {
    // --- t() usage, so we can measure localization coverage per file ---
    if (ts.isCallExpression(node)) {
      const ex = node.expression;
      if (ts.isIdentifier(ex) && ex.text === 't') tCalls += 1;

      // --- 7D: locale-sensitive formatting call sites ---
      if (ts.isPropertyAccessExpression(ex) && FORMAT_CALLS.has(ex.name.text)) {
        const hasLocaleArg = node.arguments.length > 0;
        formatSites.push({
          file: relPath,
          line: lineOf(node),
          call: ex.name.text,
          hasLocaleArg,
          text: node.getText(sf).slice(0, 120),
        });
      }
    }
    if (ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const pa = node.expression;
      if (ts.isIdentifier(pa.expression) && pa.expression.text === 'Intl' && INTL_CTORS.has(pa.name.text)) {
        formatSites.push({
          file: relPath,
          line: lineOf(node),
          call: `Intl.${pa.name.text}`,
          hasLocaleArg: node.arguments && node.arguments.length > 0,
          text: node.getText(sf).slice(0, 120),
        });
      }
    }

    // --- JSX text nodes (incl. multi-line) ---
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, ' ').trim();
      if (text && /[A-Za-z]/.test(text) && (isSentenceShaped(text) || isSingleWordLabel(text))) {
        hits.push({ file: relPath, line: lineOf(node), kind: 'jsx-text', text, attr: null });
      }
    }

    // --- JSX attributes ---
    if (ts.isJsxAttribute(node) && node.initializer) {
      const attr = node.name.getText(sf);
      if (!NEVER_LOCALIZABLE_ATTRS.has(attr)) {
        let value = null;
        if (ts.isStringLiteral(node.initializer)) value = node.initializer.text;
        else if (
          ts.isJsxExpression(node.initializer) &&
          node.initializer.expression &&
          ts.isStringLiteral(node.initializer.expression)
        ) {
          value = node.initializer.expression.text;
        }
        if (value && LOCALIZABLE_ATTRS.has(attr) && /[A-Za-z]{2}/.test(value)) {
          hits.push({ file: relPath, line: lineOf(node), kind: 'attr', text: value, attr });
        }
      }
    }

    // --- standalone string / template literals that render as copy ---
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      const inImport =
        (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) ||
        (ts.isCallExpression(parent) && parent.expression.getText(sf) === 'require');
      const isPropertyKey =
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isElementAccessExpression(parent) && parent.argumentExpression === node);
      const isJsxAttrValue = ts.isJsxAttribute(parent);
      let inConsole = false;
      let inThrow = false;
      for (let p = parent; p; p = p.parent) {
        if (ts.isCallExpression(p) && /^console\./.test(p.expression.getText(sf))) { inConsole = true; break; }
        if (ts.isThrowStatement(p)) { inThrow = true; break; }
        if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p)) break;
      }
      if (!inImport && !isJsxAttrValue && !isPropertyKey && (isSentenceShaped(node.text))) {
        hits.push({
          file: relPath,
          line: lineOf(node),
          kind: 'literal',
          text: node.text,
          attr: null,
          inConsole,
          inThrow,
        });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const h of hits) {
    h.class = classify({
      relPath,
      kind: h.kind,
      text: h.text,
      ctx: { attr: h.attr, inConsole: h.inConsole, inThrow: h.inThrow, inImport: false, isPropertyKey: false },
    });
    h.phase = phaseFor(relPath);
  }
  return { relPath, hits, formatSites, tCalls };
}

// ── main ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const dirFilter = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null;
const listMode = args.includes('--list') ? args[args.indexOf('--list') + 1] : null;

let files = walkFiles(SRC);
if (dirFilter) files = files.filter((f) => rel(f).startsWith(dirFilter));

const results = files.map(scanFile);
const allHits = results.flatMap((r) => r.hits);
const allFormat = results.flatMap((r) => r.formatSites);

const byPhase = {};
const byDir = {};
const byClass = {};
for (const h of allHits) {
  const dir = h.file.split('/').slice(0, 2).join('/');
  byPhase[h.phase] = (byPhase[h.phase] || 0) + 1;
  byDir[dir] = (byDir[dir] || 0) + 1;
  byClass[h.class] = (byClass[h.class] || 0) + 1;
}
const filesWithStrings = new Set(
  allHits.filter((h) => h.class === CLASSES.UI_TEXT || h.class === CLASSES.A11Y).map((h) => h.file),
).size;

const payload = {
  head: 'current working tree',
  scannedFiles: files.length,
  totalHits: allHits.length,
  filesWithLocalizableStrings: filesWithStrings,
  byClass,
  byPhase,
  byDir,
  formatSites: allFormat.length,
  formatSitesWithoutLocale: allFormat.filter((f) => !f.hasLocaleArg).length,
  tCallsTotal: results.reduce((a, r) => a + r.tCalls, 0),
};

if (wantJson) {
  console.log(JSON.stringify({ ...payload, hits: allHits, format: allFormat }, null, 2));
} else if (listMode === 'bare') {
  for (const h of allHits.filter((x) => x.class === CLASSES.UI_TEXT || x.class === CLASSES.A11Y)) {
    console.log(`${h.file}:${h.line} [${h.phase}] (${h.kind}${h.attr ? ':' + h.attr : ''}) ${JSON.stringify(h.text).slice(0, 100)}`);
  }
} else if (listMode === 'format') {
  for (const f of allFormat) {
    console.log(`${f.file}:${f.line} ${f.call} locale=${f.hasLocaleArg ? 'yes' : 'NO'} :: ${f.text}`);
  }
} else {
  console.log('=== ADMIN i18n INVENTORY (AST-based, current tree) ===');
  console.log(`scanned files                 ${payload.scannedFiles}`);
  console.log(`total hits                    ${payload.totalHits}`);
  console.log(`files with localizable copy   ${payload.filesWithLocalizableStrings}`);
  console.log(`existing t() call sites       ${payload.tCallsTotal}`);
  console.log('\n-- by classification --');
  for (const [k, v] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(5)}  ${k}`);
  }
  console.log('\n-- by phase --');
  for (const [k, v] of Object.entries(byPhase).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(5)}  ${k}`);
  }
  console.log('\n-- by directory --');
  for (const [k, v] of Object.entries(byDir).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(5)}  ${k}`);
  }
  console.log('\n-- 7D formatting --');
  console.log(`  ${payload.formatSites} locale-sensitive call sites, ${payload.formatSitesWithoutLocale} pass NO locale`);
}
