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
      // The dictionaries ARE strings. Scanning them counts every translation
      // as untranslated copy, which is both meaningless and self-inflating.
      if (full.includes(`${path.sep}i18n${path.sep}locales${path.sep}`)) continue;
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
  const t = decodeForShape(text).trim();
  if (t.length < 3) return false;
  if (!/[A-Za-z]{2,}(\s| )+[A-Za-z]/.test(t)) return false;
  if (!/^[A-Z‘“"'(]/.test(t) && !/^[A-Z]/.test(t)) return false;
  // Tailwind-ish class soup and other machine tokens.
  if (/^[a-z-]+(\s+[a-z0-9:[\]/.#()-]+)+$/.test(t)) return false;
  if (/\b(flex|grid|rounded|border|text-|bg-|px-|py-|w-\d|h-\d)\b/.test(t)) return false;
  return true;
}

/**
 * Whether a literal is already served through `t()`.
 *
 * The `t('key') || 'English'` idiom deliberately KEEPS the English literal in
 * the source as the inline fallback, so counting raw literals cannot measure
 * remaining work: a fully localized file still contains every English string it
 * ever had. A literal therefore counts as localized when a `t(` call opens
 * shortly before it, which is exactly what that idiom produces. Same technique
 * the widget's own guard uses.
 */
/**
 * Inline exemption: `// i18n-exempt: reason` on the line, or the line above.
 *
 * Some English legitimately lives in a pure module that must not resolve a
 * locale itself -- presentation descriptors consumed by a component that
 * localizes them at render. A central allowlist keyed on text would be both too
 * broad (the same words elsewhere would be silently exempt) and too far from
 * the code to stay true. The marker carries its reason at the call site and is
 * greppable.
 */
function isExempt(sourceLines, lineIndex) {
  // The marker's reason often runs to a second or third comment line, so scan
  // a small window above rather than only the immediately preceding line.
  for (let i = lineIndex; i >= Math.max(0, lineIndex - 3); i -= 1) {
    if (/i18n-exempt:/.test(sourceLines[i] ?? '')) return true;
  }
  return false;
}

/**
 * File exemption: `i18n-exempt-file: reason` in the module's own header.
 *
 * A deliberately different marker from the declaration-level one, because it is
 * a much larger claim: the WHOLE module is not dashboard chrome. It exists for
 * modules whose English is not read by the operator at all - the install
 * briefing pasted into the user's coding agent carries markdown, code fences
 * and API instructions, and translating it would degrade what the agent acts
 * on. Only the header counts, so it cannot be smuggled in halfway down a file.
 */
function isFileExempt(source) {
  const header = source.split('\n').slice(0, 60).join('\n');
  return /i18n-exempt-file:/.test(header);
}

/**
 * Block exemption: the marker on a declaration covers everything inside it.
 *
 * A line window can exempt one literal but not a TABLE of them - the marker
 * sits above the opening brace and the entries are ten lines further down. The
 * alternative, repeating the marker on every entry, puts the reason in twelve
 * places and lets them drift apart. Anchoring on the declaration's own leading
 * comment keeps one reason for one decision, and it still reads as a range
 * rather than a blanket: only that declaration is covered.
 */
function isExemptBlock(node, ts, sf, source) {
  for (let cur = node; cur; cur = cur.parent) {
    if (
      !ts.isVariableStatement(cur) &&
      !ts.isFunctionDeclaration(cur) &&
      !ts.isPropertyDeclaration(cur) &&
      !ts.isMethodDeclaration(cur)
    ) {
      continue;
    }
    const ranges = ts.getLeadingCommentRanges(source, cur.getFullStart()) ?? [];
    for (const r of ranges) {
      if (source.slice(r.pos, r.end).includes('i18n-exempt:')) return true;
    }
  }
  return false;
}

const LOOKBEHIND = 220;
function isLocalized(source, start) {
  const preceding = source.slice(Math.max(0, start - LOOKBEHIND), start);
  // `translateNow` is the same function imported directly, used inside
  // callbacks where the hook's per-locale identity would break memoization.
  return /\b(?:t|translateNow)\(\s*['"`]/.test(preceding);
}

/**
 * Exactly the `t('key') || 'English'` idiom, checked on the AST.
 *
 * The textual lookbehind below cannot tell "this literal IS the fallback" from
 * "this literal happens to sit near a t() call", so a sibling object property
 * on the next line reads as localized when it is not. That false negative hid
 * three rendered labels in the re-crawl diff. A literal counts here only when
 * it is the right operand of a `||`/`??` whose left side actually calls t().
 */
function isTranslationFallback(node, ts) {
  let cur = node;
  while (cur.parent && ts.isBinaryExpression(cur.parent)) {
    const bin = cur.parent;
    const op = bin.operatorToken.kind;
    const isOr =
      op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken;
    if (isOr && bin.right === cur && callsTranslate(bin.left, ts)) return true;
    cur = bin;
  }
  return false;
}

function callsTranslate(node, ts) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      const name = n.expression.text;
      if (name === 't' || name === 'translateNow') { found = true; return; }
    }
    ts.forEachChild(n, walk);
  };
  walk(node);
  return found;
}

/**
 * `<Trans k="..." fallback="English" />` is the `t('k') || 'English'` idiom in
 * element form, for a sentence with an element inside it.
 *
 * Matched on the AST, not by looking backwards through the source: the
 * fallback is often a ternary, which puts the `k=` further back than any
 * fixed window reaches, and widening the window would exempt unrelated
 * literals that merely sit near a Trans.
 */
function isTransFallback(node, ts) {
  for (let cur = node; cur; cur = cur.parent) {
    if (ts.isJsxAttribute(cur)) {
      return cur.name.getText() === 'fallback';
    }
    if (ts.isJsxElement(cur) || ts.isJsxSelfClosingElement(cur) || ts.isBlock(cur)) return false;
  }
  return false;
}

/**
 * Whether a literal is the English fallback of a KEYED CONSTANT.
 *
 * Module-level tables (PRIMARY_NAV and friends) cannot call `t()` at all: they
 * are evaluated once at import, long before a locale exists. The pattern there
 * is a sibling `<name>Key` property that the consumer resolves at render time
 * -- `t(item.labelKey) || item.label`. The English stays in the table as the
 * fallback, exactly as it does at a call site, so flagging it would report
 * finished work as outstanding.
 */
/** Whether a node sits inside any function body (vs module top level). */
function isInFunction(node, ts) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isArrowFunction(p) ||
        ts.isMethodDeclaration(p) || ts.isConstructorDeclaration(p)) {
      return true;
    }
  }
  return false;
}

function isKeyedConstant(node, ts, source) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isObjectLiteralExpression(p)) {
      const names = p.properties.map((prop) => prop.name?.getText?.() ?? '');
      // Explicit sibling key: `{ label, labelKey }`.
      if (names.some((n) => /Key$/.test(n))) return true;
      // Id-keyed table: `{ id, label }` resolved at the render site with a
      // template key built from the id -- t(`ns.area.${option.id}`) || label.
      // Adding a `labelKey` to every row would restate the id for no gain, so
      // the presence of a template-literal t() call in the file is the signal.
      // `{ id, label }` rows, and `Record<Id, { label }>` tables where the
      // object KEY is the id and there is no `id` property to match on.
      if (names.includes('label') && /\b(?:t|translateNow)\(\s*`/.test(source)) return true;
      // `Record<Status, string>` tables have no `label` property at all -- the
      // object KEY is the id and the value is the copy. A module-scope table
      // cannot call t() in place, so the only correct pattern is a template key
      // resolved at the render site, and a template t() in the file is the
      // evidence that is what happens.
      if (!isInFunction(node, ts) && /\b(?:t|translateNow)\(\s*`/.test(source)) return true;
      return false;
    }
    if (ts.isJsxElement(p) || ts.isFunctionDeclaration(p)) return false;
  }
  return false;
}

/**
 * Strings that stay English on purpose. Every entry carries its reason.
 *
 * An allowlist is a liability if it becomes a dumping ground, so it is keyed on
 * the exact text and each entry has to justify itself. Anything that is merely
 * inconvenient to translate does NOT belong here.
 */
const ALLOWED_ENGLISH = new Map([
  ['you@example.com', 'example address in a placeholder, not prose'],
  ['Custom request', 'mailto subject line, read by an English-speaking support team'],
  ['OyeChats', 'brand name; never translated'],
  ['Wix', 'third-party product name; never translated'],
  // Canned operator replies are SENT TO THE VISITOR. Translating them because
  // the operator's console is in Hindi would put Hindi in front of an
  // English-speaking visitor. The visitor's language is a property of their
  // session, not of the operator's dashboard.
  [
    "Hi {name},\n\nThank you for reaching out! We've received your message and will follow up with you shortly.\n\nBest regards",
    'operator reply body sent to the visitor; not dashboard chrome',
  ],
  [
    "Hi {name},\n\nThank you for your message. We've sent the information you requested - please check your inbox.\n\nBest regards",
    'operator reply body sent to the visitor; not dashboard chrome',
  ],
  [
    'Hi {name},\n\nThank you for contacting us. Your request has been resolved. Please reach out again if you need anything else.\n\nBest regards',
    'operator reply body sent to the visitor; not dashboard chrome',
  ],
]);

/** A single word that is still clearly UI copy (button labels etc.). */
/**
 * JSX text is entity-parsed by the compiler, so "Delete&hellip;" is the single
 * word "Delete…" on screen. The shape tests below reason about what the user
 * reads, not what the source spells, so they run against the decoded form. The
 * RAW text is still what gets reported, because the codemod has to match it
 * against the source line.
 */
const TEXT_ENTITIES = {
  '&hellip;': '\u2026', '&mdash;': '\u2014', '&ndash;': '\u2013',
  '&rsquo;': '\u2019', '&lsquo;': '\u2018', '&rdquo;': '\u201d',
  '&ldquo;': '\u201c', '&nbsp;': ' ', '&times;': '\u00d7',
  '&middot;': '\u00b7', '&bull;': '\u2022', '&deg;': '\u00b0',
  '&quot;': '"', '&apos;': "'", '&amp;': '&',
};
function decodeForShape(text) {
  return text.replace(
    /&(?:hellip|mdash|ndash|rsquo|lsquo|rdquo|ldquo|nbsp|times|middot|bull|deg|quot|apos|amp);/g,
    (m) => TEXT_ENTITIES[m] ?? m,
  );
}

// A trailing ellipsis marks "this opens something more" (Delete…, Rename…).
// It is part of the label and must travel with it into the dictionary.
function isSingleWordLabel(text) {
  const t = decodeForShape(text).trim().replace(/(?:\u2026|\.\.\.)$/, '');
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
        hits.push({
          node,
          file: relPath,
          line: lineOf(node),
          kind: 'jsx-text',
          text,
          attr: null,
          inFunction: isInFunction(node, ts),
          localized:
            isLocalized(source, node.getStart(sf)) ||
            isKeyedConstant(node, ts, source) ||
            isTransFallback(node, ts),
          inFunction: isInFunction(node, ts),
        });
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
          hits.push({
            node,
            file: relPath,
            line: lineOf(node),
            kind: 'attr',
            text: value,
            attr,
            inFunction: isInFunction(node, ts),
            localized: isLocalized(source, node.getStart(sf)) || isTransFallback(node, ts),
          });
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
          node,
          file: relPath,
          line: lineOf(node),
          kind: 'literal',
          text: node.text,
          attr: null,
          inConsole,
          inThrow,
          localized:
            isTranslationFallback(node, ts) ||
            isKeyedConstant(node, ts, source) ||
            isTransFallback(node, ts),
          inFunction: isInFunction(node, ts),
        });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  const srcLines = source.split('\n');
  const fileExempt = isFileExempt(source);
  for (const h of hits) {
    h.exempt =
      fileExempt ||
      isExempt(srcLines, h.line - 1) ||
      (h.node ? isExemptBlock(h.node, ts, sf, source) : false);
    h.class = classify({
      relPath,
      kind: h.kind,
      text: h.text,
      ctx: { attr: h.attr, inConsole: h.inConsole, inThrow: h.inThrow, inImport: false, isPropertyKey: false },
    });
    h.phase = phaseFor(relPath);
    // The AST node is circular and only needed for the block-exemption walk
    // above. Drop it before anything tries to serialise a hit.
    delete h.node;
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
  unlocalized: allHits.filter(
    (h) =>
      (h.class === CLASSES.UI_TEXT || h.class === CLASSES.A11Y) &&
      !h.localized &&
      !h.exempt &&
      !ALLOWED_ENGLISH.has(h.text.trim()),
  ).length,
  formatSites: allFormat.length,
  formatSitesWithoutLocale: allFormat.filter((f) => !f.hasLocaleArg).length,
  tCallsTotal: results.reduce((a, r) => a + r.tCalls, 0),
};

if (wantJson) {
  console.log(JSON.stringify({ ...payload, hits: allHits, format: allFormat }, null, 2));
} else if (listMode === 'unlocalized') {
  for (const h of allHits.filter(
    (x) =>
      (x.class === CLASSES.UI_TEXT || x.class === CLASSES.A11Y) &&
      !x.localized &&
      !x.exempt &&
      !ALLOWED_ENGLISH.has(x.text.trim()),
  )) {
    console.log(
      `${h.file}:${h.line} [${h.phase}] (${h.kind}${h.attr ? ':' + h.attr : ''}) ${JSON.stringify(h.text).slice(0, 100)}`,
    );
  }
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
  console.log(`STILL UNLOCALIZED             ${payload.unlocalized}`);
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
