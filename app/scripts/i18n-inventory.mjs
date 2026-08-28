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
  // The design system renders most of its prose through PROPS, not children:
  // PageContainer/SectionHeader/EmptyState/Card all take `description`, and
  // Field takes `hint`. Omitting these is why a page could show a translated
  // title and an English subtitle on the same line and still score clean.
  'description',
  'hint',
  'body',
  'caption',
  'subtitle',
  'sublabel',
  'legend',
  'help',
  'helperText',
  'emptyLabel',
  'ariaLabel',
  'srLabel',
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

/**
 * Modules reachable from the app entry, by walking static and dynamic imports.
 *
 * This bucket existed because 412 of the "remaining" strings lived in Admin 1.0
 * modules the `features/` rebuild had replaced - duplicate pairs like the old
 * top-level components beside their `features/` successors. Translating them
 * would have spent a translator's time on strings no user could reach. Those 72
 * modules have since been deleted, so the bucket reads 0; it stays as a guard,
 * because the next unreachable module should be noticed while it is still one
 * file rather than ninety.
 *
 * Two blind spots, both found by deleting against this walk and checking the
 * result. Do not treat "unreachable" as "safe to delete" without them:
 *
 *   - A `.d.ts` is NEVER reachable here. `resolveSpec` answers `./services/api`
 *     with `api.js`, so the type shim beside it has no inbound edge and reads
 *     as dead. TypeScript consumes it by adjacency instead. A `.d.ts` is live
 *     whenever its implementation sibling is.
 *   - Config-referenced files have no importer at all. `src/test/setup.ts` is
 *     named only by `vite.config.js` (`test.setupFiles`).
 */
function reachableFromEntry() {
  // Resolved across extensions rather than pinned: this returns null when the
  // entry is missing, so a rename would silently reclassify every reachable
  // string as unreachable instead of failing.
  const entry = ['main.tsx', 'main.jsx']
    .map((f) => path.join(SRC, f))
    .find((f) => fs.existsSync(f));
  if (!entry) return null;
  const seen = new Set();
  const resolveSpec = (from, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = path.resolve(path.dirname(from), spec);
    const candidates = [base, `${base}.tsx`, `${base}.ts`, `${base}.jsx`, `${base}.js`];
    for (const ext of ['tsx', 'ts', 'jsx', 'js']) candidates.push(path.join(base, `index.${ext}`));
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    }
    return null;
  };
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { return; }
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const r = resolveSpec(file, m[1]);
      if (r) walk(r);
    }
  };
  walk(entry);
  return new Set([...seen].map((f) => rel(f)));
}

const REACHABLE = reachableFromEntry();

function isUnreachable(relPath) {
  return REACHABLE !== null && !REACHABLE.has(relPath);
}

function isDeferred(relPath) {
  return DEFERRED_DIRS.some((d) => relPath.startsWith(d));
}

/** Sentence-shaped: at least two words, starts like prose, not a token. */
function isSentenceShaped(text) {
  const t = decodeForShape(text).trim();
  if (t.length < 3) return false;
  if (!/[A-Za-z]{2,}(\s| )+[A-Za-z]/.test(t)) return false;
  // Leading punctuation is stripped before the "starts like prose" test. A
  // template literal's first span often opens with a separator - the Home
  // header reads `${date} · Here's how your workspace is doing today.` - and
  // testing the raw first character rejected the whole sentence.
  const lead = t.replace(/^[^A-Za-z]+/, '');
  if (!/^[A-Z]/.test(lead)) return false;
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
// `@i18n-exempt:` in annotation form, at the START of a comment.
//
// The bare words were reachable by accident: a doc comment that merely
// DISCUSSED the marker ("the marker is i18n-exempt-file: followed by a
// reason") disabled an entire module. Requiring a leading `@` and comment-start
// position makes prose about the marker distinguishable from the marker, and a
// reason is still required so the decision is recorded where it applies.
const EXEMPT_MARKER = /^@i18n-exempt:\s*(\S[\s\S]{7,})/;

/**
 * Inline exemption: `// i18n-exempt: reason`, on the line or the one above.
 *
 * Three things are enforced, because each was reachable by accident:
 *  - it must be in a COMMENT, not inside a string. A help constant reading
 *    "Add i18n-exempt: above a line to skip it" used to exempt itself and its
 *    neighbours.
 *  - it must carry a real reason. A bare marker is not a decision.
 *  - the window is the marker's own line and the ONE below it. The old window
 *    ran three lines FORWARD, so one marker silently covered unrelated copy.
 */
function isExempt(sourceLines, lineIndex) {
  // Walk up through CONTIGUOUS comment lines and stop at the first line of
  // code. That lets a marker's reason wrap over several lines (they usually
  // do) while making it impossible for the window to reach past the comment
  // block into unrelated statements, which a fixed line count could.
  for (let i = lineIndex; i >= 0; i -= 1) {
    const line = sourceLines[i] ?? '';
    const comment = line.match(/(?:\/\/|\/\*|^\s*\*)\s*(.*)$/);
    if (comment && EXEMPT_MARKER.test(comment[1])) return true;
    if (i === lineIndex) continue; // the marker may be trailing on this line
    const isCommentLine = /^\s*(\/\/|\/\*|\*|\{\s*\/\*)/.test(line);
    if (!isCommentLine) return false;
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
function isFileExempt(source, ts, sf) {
  // Only a marker in a genuine comment token in the module header counts, and
  // it must carry a reason. A bare substring match let a doc comment that
  // merely DISCUSSED the marker disable an entire module.
  const first = sf.statements[0];
  const end = first ? first.getStart(sf) : Math.min(source.length, 4000);
  const header = source.slice(0, end);
  for (const m of header.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)) {
    // Same annotation form, and it must open a line of the comment.
    const match = m[0].match(/(?:^|\n)\s*(?:\*|\/\/)?\s*@i18n-exempt-file:\s*(\S[\s\S]{7,})/);
    if (match) return true;
  }
  return false;
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
    // A VariableStatement only. Anchoring on a FunctionDeclaration meant one
    // marker above a component exempted every string inside it - a whole
    // screen, not a range.
    if (!ts.isVariableStatement(cur)) continue;
    const ranges = ts.getLeadingCommentRanges(source, cur.getFullStart()) ?? [];
    for (const r of ranges) {
      if (source.slice(r.pos, r.end).includes('i18n-exempt:')) return true;
    }
  }
  return false;
}

/**
 * Whether a formatting call is actually pinned to the dashboard's locale.
 *
 * `arguments.length > 0` was not the question. `toLocaleString(undefined, opts)`
 * passes an argument and still asks for the BROWSER's locale, which is the
 * exact defect 7D exists to remove - it just spells it longer. A hardcoded
 * 'en-US' is the same defect with the answer wired in: it pins the format to
 * one language while the words around it follow another.
 *
 * Only a non-literal locale expression counts, because that is the shape that
 * can carry `getLocale()`.
 */
function hasRealLocaleArg(node, ts) {
  const first = node.arguments?.[0];
  if (!first) return false;
  if (first.kind === ts.SyntaxKind.UndefinedKeyword) return false;
  if (ts.isIdentifier(first) && first.text === 'undefined') return false;
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) return false;
  return true;
}

/**
 * A literal that is COMPARED against, not rendered.
 *
 * `event.key === 'Escape'`, `status === 'Live'`, `case 'Free':` - these are API
 * values and enum members. They look exactly like single-word labels, and
 * translating one would not merely read oddly: it would break the keyboard
 * handling or the branch that depends on it.
 */
function isComparisonOperand(node, ts) {
  const parent = node.parent;
  if (!parent) return false;
  // `Button.displayName = 'Button'` is React devtools metadata, never rendered.
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    /\.displayName$/.test(parent.left.getText())
  ) {
    return true;
  }
  if (ts.isCaseClause(parent)) return true;
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    return (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      // `'Notification' in window` is a capability probe, not copy.
      op === ts.SyntaxKind.InKeyword
    );
  }
  // `['Escape', 'Tab'].includes(key)` and `key in { ... }`
  if (ts.isArrayLiteralExpression(parent) && parent.parent) {
    const gp = parent.parent;
    if (ts.isPropertyAccessExpression(gp) && /^(includes|indexOf|some|has)$/.test(gp.name.getText())) {
      return true;
    }
  }
  return false;
}

/**
 * A CODE SNIPPET, not copy.
 *
 * The platform install steps are `{ title, description, code, language }`, and
 * `code` holds HTML, JSX and PHP that a user pastes verbatim. Translating one
 * would hand them a broken snippet. The `language` sibling is what marks the
 * object as carrying code rather than prose.
 */
function isCodeSnippet(node, ts) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isPropertyAssignment(p)) {
      const name = p.name?.getText?.();
      if (name === 'code' || name === 'language') return true;
    }
    if (ts.isObjectLiteralExpression(p)) break;
  }
  return false;
}

/** Whether a node sits inside a `console.*` call or a `throw`. */
function enclosedByConsoleOrThrow(node, ts) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isCallExpression(p) && /^console\./.test(p.expression.getText())) {
      return { inConsole: true, inThrow: false };
    }
    if (ts.isThrowStatement(p)) return { inConsole: false, inThrow: true };
    if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p)) break;
  }
  return { inConsole: false, inThrow: false };
}

/**
 * Prose inside a template literal.
 *
 * Unlike a plain string, a template's literal spans usually begin MID-sentence
 * - `${count} chatbots are ready to go live` leaves the scanner " chatbots are
 * ready to go live", with no capital anywhere. Requiring one silently dropped
 * every interpolated sentence that did not happen to start with a word.
 */
function isTemplateProse(text) {
  const t = decodeForShape(text).trim();
  if (t.length < 3) return false;
  // CSS built by interpolation - `radial-gradient(circle at 38% 34%, ...)`,
  // `circle(0px at px px)`. A template is the natural way to write it and the
  // leftover literal spans read like lowercase prose.
  if (/\b(radial-gradient|linear-gradient|conic-gradient|circle|ellipse|translate|rotate|scale|calc|rgba?|hsla?|var)\s*\(/.test(t)) {
    return false;
  }
  if (/\b\d*(px|rem|em|vh|vw|deg|%)\b/.test(t) && !/[.!?]/.test(t)) return false;
  // KNOWN LIMIT: a template whose literal spans total ONE word - `${n} used`,
  // `${n} left` - cannot be told apart from an interpolated identifier or unit
  // by shape alone, so it is not reported. Those are found by reading the
  // screen, which is how `QuotaMeter`'s "3 used" was caught.
  if (!/[A-Za-z]{2,}(\s|\u00a0)+[A-Za-z]/.test(t)) return false;
  if (isClassSoup(t)) return false;
  return true;
}

/**
 * Whether an ATTRIBUTE value is already served through `t()`.
 *
 * `attr={t('k') || 'English'}` is the idiom; `attr="English"` is not. This is
 * an exact check on the initializer, replacing a 220-character textual
 * lookbehind that marked any value as done merely for sitting near a `t(`
 * call. That false positive covered whole components.
 */
function isAttrLocalized(node, ts) {
  const init = node.initializer;
  if (!init || !ts.isJsxExpression(init) || !init.expression) return false;
  return isTranslationFallback(init.expression, ts) || callsTranslate(init.expression, ts);
}

/**
 * Text rendered inside JSX is copy because of WHERE it is, not how it looks.
 *
 * Only things that cannot be prose are excluded: punctuation, bare numbers,
 * separators, units and single non-letter tokens.
 */
function isRenderedText(text) {
  const t = decodeForShape(text).trim();
  if (!t) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  // A lone letter, or an ASCII-art separator.
  if (t.replace(/[^A-Za-z]/g, '').length < 2) return false;
  if (isClassSoup(t)) return false;
  return true;
}

/**
 * Tailwind-ish class soup that ended up in a text position.
 *
 * The old test was `^[a-z-]+(\s+[a-z0-9:...]+)+$`, which matches ANY all-
 * lowercase multi-word phrase - so ordinary prose like "know your business"
 * and "in minutes" was discarded as CSS and never counted. A class list is
 * recognisable by its PUNCTUATION (hyphens, colons, slashes, brackets) or by
 * a known utility prefix, not by being lowercase.
 */
function isClassSoup(t) {
  if (/\b(flex|grid|rounded|border|text-|bg-|px-|py-|w-\d|h-\d|gap-|mt-|mb-|ml-|mr-)\b/.test(t)) {
    return true;
  }
  const tokens = t.split(/\s+/);
  if (tokens.length < 2) return false;
  const cssish = tokens.filter((tok) => /[-:/[\]().#]/.test(tok)).length;
  // Most tokens carrying CSS punctuation means it is a class list, not a
  // sentence. Real prose rarely hyphenates the majority of its words.
  return cssish / tokens.length > 0.6;
}

/**
 * Whether an attribute VALUE is copy rather than a machine token.
 *
 * The attribute path used to gate on `/[A-Za-z]{2}/` alone, so `label="en-IN"`,
 * `alt="bot-6a427d4529b9"` and `title="POST /bots/{id}/documents"` were all
 * reported as remaining work. Noise in the number trains people to skim it.
 */
function isAttrCopy(value) {
  const v = value.trim();
  if (!/[A-Za-z]{2}/.test(v)) return false;
  if (/^[a-z]{2}(-[A-Za-z0-9]{2,8})+$/.test(v)) return false;      // BCP-47 tag
  if (/^bot-[0-9a-f]+$/i.test(v)) return false;                     // bot key
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return false;           // email
  if (/^(GET|POST|PUT|PATCH|DELETE)\s/.test(v)) return false;       // route
  if (/^\//.test(v) && !/\s/.test(v)) return false;                 // path
  if (/^https?:\/\//.test(v)) return false;                         // url
  if (/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+$/.test(v)) return false; // dotted key
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return false;                  // colour
  return true;
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
  // Walks through ANY intervening expression, not only a direct binary parent:
  // the fallback is often a template literal or a ternary, and the literal then
  // sits several nodes below the `||`. Stopping at the first non-binary parent
  // reported those as unlocalized.
  let cur = node;
  while (cur.parent) {
    const parent = cur.parent;
    if (ts.isBinaryExpression(parent)) {
      const op = parent.operatorToken.kind;
      const isOr =
        op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken;
      if (isOr && parent.right === cur && callsTranslate(parent.left, ts)) return true;
    }
    // A statement boundary means we have left the expression entirely.
    if (ts.isStatement(parent) || ts.isJsxElement(parent) || ts.isJsxAttribute(parent)) break;
    cur = parent;
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

function isKeyedConstant(node, ts, source, templatePrefixes) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isObjectLiteralExpression(p)) {
      // Which property does this literal belong to?
      let owner = null;
      for (const prop of p.properties) {
        if (ts.isPropertyAssignment(prop) && prop.initializer === node) owner = prop.name?.getText?.() ?? null;
      }
      const names = p.properties.map((prop) => prop.name?.getText?.() ?? '');

      // Explicit sibling key, for THIS property: `{ label, labelKey }`.
      // Matching any `*Key` sibling exempted every table with a `botKey`,
      // `apiKey` or `sortKey` on it - which is most of them.
      if (owner && names.includes(`${owner}Key`)) return true;

      // Id-keyed table resolved at the render site with a template key. The
      // evidence must NAME this object's namespace: "the file contains a
      // backtick t() somewhere" exempted 24 files wholesale.
      const covered = templatePrefixes.some((prefix) => {
        const leaf = prefix.replace(/\.$/, '').split('.').pop();
        return leaf && (names.includes(leaf) || owner === leaf || names.includes('id'));
      });
      if (!covered) return false;
      if (names.includes('label') || names.includes('id')) return true;
      // `Record<Status, string>`: the object KEY is the id and the value is the
      // copy, so there is no `label` property to match on.
      if (!isInFunction(node, ts)) return true;
      return false;
    }
    if (ts.isJsxElement(p) || ts.isFunctionDeclaration(p)) return false;
  }
  return false;
}

/** `t(`ns.area.${x}`)` -> "ns.area." — the prefixes a file resolves dynamically. */
function templatePrefixesIn(source) {
  const out = [];
  for (const m of source.matchAll(/(?:\bt|\btranslateNow)\(\s*`([A-Za-z0-9_.]*?)\$\{/g)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}


/**
 * Strings that stay English on purpose. Every entry carries its reason.
 *
 * An allowlist is a liability if it becomes a dumping ground, so it is keyed on
 * the exact text and each entry has to justify itself. Anything that is merely
 * inconvenient to translate does NOT belong here.
 */
const ALLOWED_ENGLISH = new Map([
  // These four moved to inline `i18n-exempt:` markers at their call sites. A
  // text-keyed entry here exempts that word EVERYWHERE, which is the weakness
  // the inline marker exists to avoid: a future "OyeChats ran into a problem"
  // would have been silently exempt by matching a brand-name rule.
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
  // A template hit was already shape-tested by `isTemplateProse` when it was
  // collected. Re-deriving it here with the plain-literal rules is what made
  // the collector and the classifier disagree: the hit was gathered and then
  // silently dropped from the count for starting lowercase, which a template's
  // first span usually does.
  if (kind === 'template') {
    if (ctx.inConsole || ctx.inThrow) return CLASSES.INTERNAL;
    return CLASSES.UI_TEXT;
  }
  if (kind === 'literal') {
    if (ctx.inConsole || ctx.inThrow) return CLASSES.INTERNAL;
    if (ctx.inImport) return CLASSES.CODE;
    if (ctx.isPropertyKey) return CLASSES.CODE;
    // A single-word label is copy too. Collecting it and then classifying it
    // as "uncertain" meant it was gathered and silently dropped from the count:
    // `{ label: 'Conversations' }` on the Home agent card sat in English on an
    // otherwise Hindi screen while the guard reported that surface at 0.
    if (isSentenceShaped(text) || isSingleWordLabel(text)) return CLASSES.UI_TEXT;
    return CLASSES.UNCERTAIN;
  }
  return CLASSES.UNCERTAIN;
}

function scanFile(file) {
  const relPath = rel(file);
  const source = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Namespaces this file resolves through a template key. Used as the evidence
  // that a keyed constant really is resolved at its render site.
  const tmplPrefixes = templatePrefixesIn(source);
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
        // `i18n/formatters.ts` IS the implementation: its `undefined` calls are
        // the deliberate fallback used when Intl throws, not a missed site.
        if (relPath.startsWith('i18n/')) return;
        const hasLocaleArg = hasRealLocaleArg(node, ts);
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
          hasLocaleArg: hasRealLocaleArg(node, ts),
          text: node.getText(sf).slice(0, 120),
        });
      }
    }

    // --- JSX text nodes (incl. multi-line) ---
    if (ts.isJsxText(node)) {
      const text = node.text.replace(/\s+/g, ' ').trim();
      // Text sitting in JSX is copy BY POSITION. The old shape tests demanded
      // two words and an initial capital, which dropped "credits / month",
      // "times asked", "(optional)" and every lowercase continuation of a
      // sentence split across elements - 47 live fragments in directories this
      // guard scored 0. Only a deny-list of things that cannot be prose is
      // excluded now.
      if (isRenderedText(text)) {
        hits.push({
          node,
          file: relPath,
          line: lineOf(node),
          kind: 'jsx-text',
          text,
          attr: null,
          inFunction: isInFunction(node, ts),
          // JSX text is never the right operand of a `||`, so the only ways it
          // can be localized are a <Trans> fallback or a keyed constant.
          localized: isKeyedConstant(node, ts, source, tmplPrefixes) || isTransFallback(node, ts),
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
        if (value && LOCALIZABLE_ATTRS.has(attr) && isAttrCopy(value)) {
          hits.push({
            node,
            file: relPath,
            line: lineOf(node),
            kind: 'attr',
            text: value,
            attr,
            inFunction: isInFunction(node, ts),
            localized: isAttrLocalized(node, ts) || isTransFallback(node, ts),
          });
        }
      }
    }

    // --- template literals WITH substitutions ---
    // `ts.isStringLiteral || ts.isNoSubstitutionTemplateLiteral` never reaches a
    // TemplateExpression, so every interpolated sentence was invisible - which
    // is exactly the population most at risk of fragment assembly and of
    // English plurals baked into the markup.
    if (ts.isTemplateExpression(node)) {
      const joined = [node.head.text, ...node.templateSpans.map((sp) => sp.literal.text)]
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (isTemplateProse(joined) && !isCodeSnippet(node, ts)) {
        hits.push({
          node,
          file: relPath,
          line: lineOf(node),
          kind: 'template',
          text: joined,
          attr: null,
          // Real detection, not a placeholder: a template inside console.warn
          // or a throw is developer text. Hardcoding `false` reported the
          // i18n module's own DEV warnings as untranslated UI.
          inConsole: enclosedByConsoleOrThrow(node, ts).inConsole,
          inThrow: enclosedByConsoleOrThrow(node, ts).inThrow,
          localized:
            isTranslationFallback(node, ts) ||
            isKeyedConstant(node, ts, source, tmplPrefixes) ||
            isTransFallback(node, ts),
          inFunction: isInFunction(node, ts),
        });
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
      if (
        !inImport &&
        !isJsxAttrValue &&
        !isPropertyKey &&
        !isComparisonOperand(node, ts) &&
        !isCodeSnippet(node, ts) &&
        (isSentenceShaped(node.text) || isSingleWordLabel(node.text))
      ) {
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
            isKeyedConstant(node, ts, source, tmplPrefixes) ||
            isTransFallback(node, ts),
          inFunction: isInFunction(node, ts),
        });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  const srcLines = source.split('\n');
  const fileExempt = isFileExempt(source, ts, sf);
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
    h.unreachable = isUnreachable(relPath);
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
      !h.unreachable &&
      !ALLOWED_ENGLISH.has(h.text.trim()),
  ).length,
  unlocalizedInDeadCode: allHits.filter(
    (h) =>
      (h.class === CLASSES.UI_TEXT || h.class === CLASSES.A11Y) &&
      !h.localized &&
      !h.exempt &&
      h.unreachable &&
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
      !x.unreachable &&
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
} else if (listMode === 'exemptions') {
  // Every exemption with its reason, so review can see what was skipped and
  // why rather than trusting a number that silently excludes them.
  for (const h of allHits.filter((x) => x.exempt)) {
    console.log(`${h.file}:${h.line} (${h.kind}) ${JSON.stringify(h.text).slice(0, 80)}`);
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
  console.log(`  (in unreachable files)      ${payload.unlocalizedInDeadCode}`);
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
