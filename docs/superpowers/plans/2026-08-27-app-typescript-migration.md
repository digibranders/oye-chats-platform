# `app/` TypeScript Migration Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **STATUS: COMPLETE (2026-08-28).** All six phases landed in 24 commits on
> `claude/admin-redesign`, ending at the "keep JavaScript out of app/src" commit.
> `app/src` is 0 `.js`, 0 `.jsx`, 0 `.d.ts` shims, 649 TypeScript files. Verified
> in an isolated worktree: lint (with the new guard) clean, `tsc --noEmit` 0
> errors, 168 test files / 2,240 tests passing, build green, bundle +282 bytes
> (the real `ApiError` class, since types themselves erase).
>
> Two checks in this plan could NOT be run and were not faked: `npm run size`
> and `npm run e2e`. Neither `size-limit` nor `@playwright/test` is present in
> this checkout's `node_modules`, though both are declared in `devDependencies`.
> That predates this work; nothing here touched either dependency. A manual boot
> check stood in for e2e: the built app renders the login screen with a clean
> console, and the outbound `/auth/google/status` request proves the converted
> API client loads and executes.

**Goal:** Convert the last 16 legacy `.js`/`.jsx` files in `app/src` to TypeScript and delete the 14 hand-written `.d.ts` shims, so every module in the admin dashboard has exactly one checked definition instead of two unchecked ones.

**Architecture:** The `app/` codebase is already 95% TypeScript (646 TS files / 137k lines vs 16 JS files / 7,333 lines) under a `strict: true`, `allowJs: false` tsconfig that passes clean today. New TS code sees the remaining JS through hand-written `.d.ts` shims. Nothing binds a shim to its implementation, so the shims can lie, and `services/api.d.ts` has already drifted (28 of 214 runtime exports are undeclared). This plan works leaves-first: kill the drift that exists, convert dependency-free utilities, then React contexts, then the entry point, then the 3,817-line API client, then seal the door with a CI guard so `.js` cannot come back.

**Tech Stack:** TypeScript 6, React 19, Vite 8 (rolldown), Vitest 4, ESLint 9 + typescript-eslint 8, React Router 7, axios 1.18.

---

## Ground Rules

Read these once before Task 0.1. They apply to every task.

**Branch.** `app/CLAUDE.md` and the root `CLAUDE.md` forbid working on `main`. Verify before every commit:

```bash
git branch --show-current
```

This plan was written on `claude/admin-redesign`. Stay on a feature branch; never commit to `main`.

**Two things differ from the first draft of this plan, both settled during Phase 0.**
Legacy modules are imported *extensionless* in the guard test, so TypeScript
resolves to the `.d.ts` and Vite resolves to the `.js`/`.jsx`. And shim text is
read through Vite's `?raw` glob, not `node:fs`: `tsconfig` pins `types` to
`vite/client`, so Node globals are deliberately out of scope for app source and
`readFileSync` fails `tsc`.

**`npm run size` does not work in this checkout.** `size-limit` is in
`devDependencies` but its binary is absent from `node_modules/.bin`. Baseline
against the build's own asset table instead; `dist/assets/index-*.js` was
431,852 bytes at the start of Phase 0.

**The verification triple.** Every task ends with all three green. There is no "it's just a rename" exemption:

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

`npm run build` is slower and runs once per phase, not once per task.

**Rename with `git mv`, never copy-then-delete.** `git mv` preserves file history, so `git log --follow` and `git blame` keep working across the migration. A copy-and-delete makes every converted file look brand new and destroys the blame trail on 7,000 lines.

```bash
git mv src/lib/currency.js src/lib/currency.ts
```

**Imports are already extensionless.** A repo-wide grep found **zero** static imports carrying a `.js` or `.jsx` extension, so renaming a file does not require touching a single import site. There is exactly one exception, a dynamic import in a test, handled explicitly in Task 4.2. Re-confirm this before starting:

```bash
cd app && grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' -E "(from|import\()[[:space:]]*['\"][^'\"]+\.(js|jsx)['\"]" src
```

Expected: only `src/services/api.smoke.test.ts:15`.

**`vi.mock()` targets are already extensionless too.** All 45 `vi.mock('../../services/api')` calls and friends resolve by module path, not filename, so they survive the rename untouched. Do not "fix" them.

**The shim is the specification.** The 14 `.d.ts` files are 1,446 lines of careful, well-documented signatures. When converting a module, the annotations come *from its shim*. Do not re-derive types from reading the JS. Where the shim and the runtime disagree, that disagreement is a bug this migration exists to surface: fix the runtime or fix the type deliberately, and say which in the commit message.

**One file per commit.** Each task below is one file and one commit. If a task's `tsc` run produces errors in *other* files, that is a real type bug the shim was hiding. Fix it in the same commit and note it in the message.

---

## File Structure

Every file this plan touches, and what happens to it.

### Created

| File | Responsibility |
| --- | --- |
| `app/src/test/shimDrift.test.ts` | Fails when a `.d.ts` shim disagrees with its runtime module. Temporary: deleted in Task 5.1 once no shims remain. |
| `app/scripts/assert-no-legacy-js.mjs` | CI guard asserting `src/` contains zero `.js`/`.jsx`. Permanent. |
| `app/src/services/apiTypes.ts` | Shared request/response types + the `ApiError` class extracted from `api.js` during Phase 4. |

### Renamed (`.js`/`.jsx` → `.ts`/`.tsx`)

| From | To | Lines | Fan-in | Phase |
| --- | --- | ---: | ---: | --- |
| `src/lib/currency.js` | `.ts` | 47 | 2 | 1 |
| `src/utils/trial.js` | `.ts` | 57 | 1 | 1 |
| `src/utils/trialBanner.js` | `.ts` | 59 | 4 | 1 |
| `src/utils/authStorage.js` | `.ts` | 131 | 20 | 1 |
| `src/lib/razorpay.js` | `.ts` | 87 | 6 | 1 |
| `src/utils/impersonation.js` | `.ts` | 234 | 16 | 1 |
| `src/data/platformIntegrations.js` | `.ts` | 851 | 8 | 1 |
| `src/context/BotContext.jsx` | `.tsx` | 164 | 23 | 2 |
| `src/context/CurrencyContext.jsx` | `.tsx` | 145 | 4 | 2 |
| `src/context/WorkspaceContext.jsx` | `.tsx` | 318 | 13 | 2 |
| `src/context/CrawlContext.jsx` | `.tsx` | 411 | 3 | 2 |
| `src/context/NotificationContext.jsx` | `.tsx` | 454 | 3 | 2 |
| `src/services/orbRenderer.js` | `.ts` | 279 | 1 | 3 |
| `src/features/agents/experience/PremiumOrb.jsx` | `.tsx` | 119 | 2 | 3 |
| `src/main.jsx` | `.tsx` | 118 | 0 | 3 |
| `src/services/api.js` | `.ts` | 3,859 | 119 | 4 |

### Deleted

All 14 `.d.ts` shims, each in the same commit as the file it shadows. Plus `app/jsconfig.json` (Task 5.2).

### Modified

| File | Change | Task |
| --- | --- | --- |
| `app/index.html:34` | `/src/main.jsx` → `/src/main.tsx` | 3.3 |
| `app/src/services/api.smoke.test.ts:15` | `import('./api.js')` → `import('./api')` | 4.2 |
| `app/eslint.config.js` | Delete the legacy `js,jsx` block | 5.2 |
| `app/tsconfig.json` | Rewrite the stale `"//"` note; widen `include` | 5.2 |
| `app/package.json` | Add `guard:no-legacy-js` to scripts | 5.3 |

---

# Phase 0: Baseline and Safety Net

No renames happen in this phase. It establishes a green baseline, makes the existing drift visible and enforced, and shrinks the biggest file before anyone has to convert it.

### Task 0.1: Capture the green baseline

**Files:** none (verification only)

- [ ] **Step 1: Confirm you are not on `main`**

Run:

```bash
cd /Users/a12345/Desktop/AI/OyeChats/platform-admin-redesign && git branch --show-current
```

Expected: anything except `main`. If it prints `main`, stop and switch to a feature branch.

- [ ] **Step 2: Confirm the working tree is committed**

Run:

```bash
git status --porcelain app/
```

Expected: empty output. If not, commit or stash first. A migration on top of uncommitted work makes every failure ambiguous.

- [ ] **Step 3: Record the baseline counts**

Run:

```bash
cd app && for e in jsx js tsx ts; do printf "%s: %s files\n" "$e" "$(find src -name "*.$e" | wc -l | tr -d ' ')"; done
```

Expected exactly:

```
jsx: 7 files
js: 9 files
tsx: 387 files
ts: 259 files
```

If these differ, the repo has moved since this plan was written. Re-run the audit before continuing.

- [ ] **Step 4: Run the full verification triple**

Run:

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Expected: all three exit 0. `tsc` prints nothing. Vitest reports 168 test files passing.

If any of these is red *before* you start, fix that first. You cannot tell a migration regression from a pre-existing failure otherwise.

- [ ] **Step 5: Run the build once**

Run:

```bash
cd app && npm run build && npm run size
```

Expected: build succeeds; `size-limit` reports the initial-load chunk under its 615 KB gzipped budget. Note the actual number, you will compare against it at the end of Phase 5.

### Task 0.2: Delete the 20 dead exports in `api.js`

**Files:**
- Modify: `app/src/services/api.js`

Twenty exported functions in `api.js` have zero consumers anywhere in `app/` (verified across `src`, `tests`, `scripts`, `plugins`). They are also absent from `api.d.ts`, which is why nothing caught them. Removing them now shrinks the Phase 4 file by roughly 10% before conversion and removes 20 signatures nobody has to type.

- [ ] **Step 1: Re-verify every one is still dead**

Run:

```bash
cd app
for s in createClient deleteClient deleteSuperadminAffiliate getBotDemoOrigin getClients \
         getGlobalFeedbackData getGlobalStats getPlatformFeedback getSuperadminAffiliateDetail \
         getSuperadminCodeReferrals getSuperadminPlans getSuperadminRevenue \
         getSuperadminSubscriptions inviteSuperadminAffiliate listSuperadminAffiliateInvites \
         listSuperadminAffiliates previewChat revokeSuperadminAffiliateInvite \
         takeoverBotSession updateSuperadminAffiliate; do
  n=$(grep -rl --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=dist-e2e "\b$s\b" \
        src tests scripts plugins 2>/dev/null | grep -v 'services/api.js' | wc -l | tr -d ' ')
  printf "%-34s consumers=%s\n" "$s" "$n"
done
```

Expected: `consumers=0` on all 20 lines.

**If any line shows a non-zero count, do not delete that function.** Instead, move it to the Step 4 list in Task 0.3 and declare it in `api.d.ts`. A live export is not dead code no matter what this plan says.

- [ ] **Step 2: Delete each function body from `src/services/api.js`**

Open the file and remove the complete `export const <name> = async (...) => { ... };` (or `export function <name>`) block for each of the 20 names, including its leading JSDoc comment. Do this by hand, one at a time. Do not script it: several of these sit adjacent to live functions and a regex will eat a neighbour.

After each deletion, check nothing else in the file referenced it internally:

```bash
cd app && grep -n "\bpreviewChat\b" src/services/api.js
```

Expected: no output, for each name in turn.

- [ ] **Step 3: Verify the export count dropped by exactly 20**

Run:

```bash
cd app && grep -cE "^export (const|async function|function) " src/services/api.js
```

Expected: `194` (down from 214).

- [ ] **Step 4: Verify the module still evaluates**

Run:

```bash
cd app && npx vitest run src/services/api.smoke.test.ts
```

Expected: PASS. This test exists precisely because `api.js` once had a temporal-dead-zone bug that took down every screen; it is the cheapest possible check that the file is still loadable.

- [ ] **Step 5: Run the verification triple**

Run:

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add app/src/services/api.js
git commit -m "refactor(api): drop 20 unreferenced exports from the API client

These had no consumers anywhere in app/ and were absent from api.d.ts, so
neither the compiler nor the linter could see them. Removing them before the
TypeScript conversion means 20 fewer signatures to write."
```

### Task 0.3: Declare the 8 live-but-undeclared `api.js` exports

**Files:**
- Modify: `app/src/services/api.d.ts`

After Task 0.2, eight runtime exports remain undeclared in the shim. All eight are consumed only by `.jsx` files, which is why `tsc` never complained. Declaring them makes the shim complete, which is the precondition for the drift guard in Task 0.4.

- [ ] **Step 1: Confirm exactly eight remain undeclared**

Run:

```bash
cd app
grep -oE "^export (const|async function|function) [A-Za-z0-9_]+" src/services/api.js \
  | awk '{print $NF}' | sort -u > /tmp/js_exports.txt
grep -oE "^export (const|declare const|function|declare function) [A-Za-z0-9_]+" src/services/api.d.ts \
  | awk '{print $NF}' | sort -u > /tmp/dts_exports.txt
comm -23 /tmp/js_exports.txt /tmp/dts_exports.txt
```

Expected exactly:

```
clearAllNotifications
deleteNotification
getUnreadNotificationCount
listNotifications
markAllNotificationsRead
markNotificationRead
redeemImpersonation
rotateWorkspaceAbort
```

- [ ] **Step 2: Append the declarations to `src/services/api.d.ts`**

Add this block at the end of the file. `NotificationItem` is already exported from `src/types/domain.ts`; add it to the existing `import type { ... } from '../types/domain'` list at the top rather than writing a second import statement.

```ts
/* ── Notifications ──────────────────────────────────────────────────────────
 * Consumed by context/NotificationContext, which is still JSX and therefore
 * never typechecked these calls. Declared here so the drift guard passes and
 * so the context's own conversion (Task 2.5) has signatures to lean on.
 */

/** One page of the notification feed, newest first, plus the live unread total. */
export function listNotifications(params?: {
  /** Page size. Defaults to 30 server-side. */
  limit?: number;
  /** Cursor: return notifications older than this id. */
  beforeId?: number;
  /** Restrict to unread only. Defaults to false. */
  unreadOnly?: boolean;
}): Promise<{ items: NotificationItem[]; unread_count: number }>;

/** The unread badge count on its own, without fetching the feed. */
export function getUnreadNotificationCount(): Promise<number>;

export function markNotificationRead(notificationId: number): Promise<{ status: string }>;
export function markAllNotificationsRead(): Promise<{ status: string }>;
export function deleteNotification(notificationId: number): Promise<{ status: string }>;
export function clearAllNotifications(): Promise<{ status: string }>;

/* ── Impersonation ─────────────────────────────────────────────────────────*/

/**
 * Exchanges a one-time super-admin impersonation token for a scoped session.
 *
 * Deliberately calls bare `axios`, not the shared `httpClient`: the redeem
 * happens BEFORE any impersonation state exists, so it must not pick up the
 * interceptor's impersonation headers.
 */
export function redeemImpersonation(token: string): Promise<{
  token: string;
  client_id: number;
  name: string;
  email: string;
  expires_at: string;
  actor_email: string;
}>;

/* ── Request lifecycle ─────────────────────────────────────────────────────*/

/**
 * Aborts every in-flight workspace-scoped request and returns a fresh signal.
 *
 * Called on workspace switch so responses for the previous workspace cannot
 * land after the switch and repaint the new workspace with stale data.
 */
export function rotateWorkspaceAbort(): AbortSignal;
```

- [ ] **Step 3: Verify the shim is now complete**

Run the Step 1 command again.

Expected: no output at all (empty set difference in both directions).

- [ ] **Step 4: Run the verification triple**

Run:

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Expected: all green. `tsc` may now surface *new* errors in TS files that call these eight functions with wrong argument types. That is the point. Fix each one in this commit.

- [ ] **Step 5: Commit**

```bash
git add app/src/services/api.d.ts
git commit -m "types(api): declare the 8 remaining undeclared api.js exports

The notification feed, impersonation redeem and workspace abort rotation were
only ever called from .jsx, so the compiler never saw them. api.d.ts now
covers all 194 runtime exports, which is what the drift guard needs."
```

### Task 0.4: Add the shim-drift guard test

**Files:**
- Create: `app/src/test/shimDrift.test.ts`

Right now nothing verifies that a `.d.ts` describes its `.js`. This test does, by importing each legacy module at runtime and comparing its real export names against the names declared in its shim. It will protect every remaining shim for the duration of the migration and gets deleted in Task 5.1 when the last shim goes.

- [ ] **Step 1: Write the test**

Create `app/src/test/shimDrift.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

/**
 * Guards the strangler-fig migration's weakest joint.
 *
 * A `.d.ts` shim next to a `.js` module is an unchecked promise: TypeScript
 * trusts it completely and never compares it to the runtime. `api.d.ts` had
 * silently drifted 28 exports out of date before anyone noticed. This test
 * makes that class of drift a failing build instead of a runtime surprise.
 *
 * Two directions, both fatal:
 *   • declared but not exported → new TS code imports `undefined` and the
 *     screen dies at runtime with the compiler having said nothing.
 *   • exported but not declared → the export is invisible to TS, so callers
 *     silently keep using the untyped `.jsx` path instead of migrating.
 *
 * Imports are extensionless on purpose. TypeScript resolves them to the
 * `.d.ts`, Vite resolves them to the `.js`/`.jsx`, and that split is exactly
 * the thing under test.
 *
 * Shim text is read through Vite's `?raw` glob rather than `node:fs`, because
 * tsconfig pins `types` to `vite/client` and Node globals are deliberately not
 * in scope for app source.
 *
 * DELETE THIS FILE once the last shim is gone. Its whole job is to hold the
 * line during the migration; afterwards `tsc` does it natively.
 */

/** Each legacy module still fronted by a hand-written `.d.ts` shim. */
const SHIMMED_MODULES: ReadonlyArray<{
  readonly label: string;
  readonly dts: string;
  readonly load: () => Promise<Record<string, unknown>>;
}> = [
  { label: 'lib/currency', dts: 'src/lib/currency.d.ts', load: () => import('../lib/currency') },
  { label: 'utils/trial', dts: 'src/utils/trial.d.ts', load: () => import('../utils/trial') },
  { label: 'utils/trialBanner', dts: 'src/utils/trialBanner.d.ts', load: () => import('../utils/trialBanner') },
  { label: 'utils/authStorage', dts: 'src/utils/authStorage.d.ts', load: () => import('../utils/authStorage') },
  { label: 'lib/razorpay', dts: 'src/lib/razorpay.d.ts', load: () => import('../lib/razorpay') },
  { label: 'utils/impersonation', dts: 'src/utils/impersonation.d.ts', load: () => import('../utils/impersonation') },
  { label: 'data/platformIntegrations', dts: 'src/data/platformIntegrations.d.ts', load: () => import('../data/platformIntegrations') },
  { label: 'context/BotContext', dts: 'src/context/BotContext.d.ts', load: () => import('../context/BotContext') },
  { label: 'context/CurrencyContext', dts: 'src/context/CurrencyContext.d.ts', load: () => import('../context/CurrencyContext') },
  { label: 'context/WorkspaceContext', dts: 'src/context/WorkspaceContext.d.ts', load: () => import('../context/WorkspaceContext') },
  { label: 'context/CrawlContext', dts: 'src/context/CrawlContext.d.ts', load: () => import('../context/CrawlContext') },
  { label: 'context/NotificationContext', dts: 'src/context/NotificationContext.d.ts', load: () => import('../context/NotificationContext') },
  { label: 'features/agents/experience/PremiumOrb', dts: 'src/features/agents/experience/PremiumOrb.d.ts', load: () => import('../features/agents/experience/PremiumOrb') },
  { label: 'services/api', dts: 'src/services/api.d.ts', load: () => import('../services/api') },
];

/**
 * Value-level export names declared by a shim.
 *
 * Only `const` / `let` / `var` / `function` / `class` produce a runtime
 * binding. `export interface` and `export type` are erased, so they are
 * excluded here on purpose: comparing them to runtime exports would fail on
 * every correctly-written shim.
 */
const SHIM_SOURCES: Record<string, string> = import.meta.glob('../**/*.d.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Glob keys are relative to this file ('../lib/currency.d.ts'); the table
 *  above names shims from the app root ('src/lib/currency.d.ts'). */
function shimSource(dtsPath: string): string {
  const suffix = dtsPath.replace(/^src\//, '');
  const key = Object.keys(SHIM_SOURCES).find((k) => k.replace(/^\.\.\//, '') === suffix);
  if (!key) throw new Error(`no shim source found for ${dtsPath}`);
  return SHIM_SOURCES[key];
}

function declaredValueExports(dtsPath: string): Set<string> {
  const source = shimSource(dtsPath);
  const pattern =
    /^export\s+(?:declare\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  const names = new Set<string>();
  for (const match of source.matchAll(pattern)) names.add(match[1]);
  return names;
}

describe('legacy .d.ts shims match their runtime modules', () => {
  it.each(SHIMMED_MODULES)('$label', async ({ dts, load }) => {
    const declared = declaredValueExports(dts);
    const runtime = new Set(Object.keys(await load()).filter((k) => k !== 'default'));

    const missingAtRuntime = [...declared].filter((n) => !runtime.has(n)).sort();
    const undeclared = [...runtime].filter((n) => !declared.has(n)).sort();

    // Asserted as arrays so a failure prints the offending names, not just a
    // size mismatch. `toEqual([])` on a sorted array is the readable form.
    expect(missingAtRuntime, `${dts} declares exports the module does not have`).toEqual([]);
    expect(undeclared, `${dts} is missing exports the module does have`).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it passes**

Run:

```bash
cd app && npx vitest run src/test/shimDrift.test.ts
```

Expected: 14 passing cases.

If `services/api` fails, Task 0.2 or 0.3 was incomplete. Go back and finish them; do not weaken this test to make it pass.

- [ ] **Step 3: Prove the test actually detects drift**

A guard test that has never failed is not yet known to work. Temporarily break a shim:

```bash
cd app && printf '\nexport function __driftCanary(): void;\n' >> src/lib/currency.d.ts
npx vitest run src/test/shimDrift.test.ts
```

Expected: FAIL on `lib/currency`, with the message `src/lib/currency.d.ts declares exports the module does not have` and `__driftCanary` in the diff.

Now revert the canary:

```bash
cd app && git checkout src/lib/currency.d.ts && npx vitest run src/test/shimDrift.test.ts
```

Expected: 14 passing again.

- [ ] **Step 4: Run the verification triple**

Run:

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Expected: all green, now with 169 test files.

- [ ] **Step 5: Commit**

```bash
git add app/src/test/shimDrift.test.ts
git commit -m "test: fail the build when a .d.ts shim drifts from its module

TypeScript trusts a hand-written shim absolutely and never checks it against
the runtime, which is how api.d.ts fell 28 exports behind without anyone
noticing. This compares declared value exports against real ones in both
directions. It is scaffolding: delete it when the last shim goes."
```

**Phase 0 exit criteria:** `api.js` down to 194 exports, `api.d.ts` complete, drift guard green and proven to fail on real drift. No file has been renamed yet.

---

# Phase 1: Leaf Utilities

Seven files, ~1,466 lines, no JSX and no React. Each has a complete shim to copy annotations from. These are the cheapest conversions in the plan and they build the muscle memory for Phase 2.

**The recipe, identical for all seven:**

1. `git mv` the `.js` to `.ts`.
2. Move the shim's annotations onto the real declarations.
3. Delete redundant `@param` / `@returns` JSDoc lines. Keep prose comments explaining *why*; TypeScript now carries the *what*. Deleting the prose is a loss, deleting the type restatement is a gain.
4. `git rm` the `.d.ts`.
5. Remove the module's entry from `SHIMMED_MODULES` in `src/test/shimDrift.test.ts`.
6. Verification triple, then commit.

Step 5 is easy to forget and produces a confusing failure (`ENOENT` on the deleted `.d.ts`). Do it every time.

### Task 1.1: Convert `lib/currency.js`

**Files:**
- Rename: `app/src/lib/currency.js` → `app/src/lib/currency.ts`
- Delete: `app/src/lib/currency.d.ts`
- Modify: `app/src/test/shimDrift.test.ts`

This one first because it is 47 lines, has fan-in of 2, and already contains a real shim-versus-runtime disagreement worth seeing up close.

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/lib/currency.js src/lib/currency.ts
```

- [ ] **Step 2: Replace the file contents**

The shim declares `pickAmount(amounts: { inrMinor?: number; usdMinor?: number })`, but the JSDoc and the `?? 0` runtime both accept `null`. The shim is wrong; a caller passing a nulled column would be rejected by the compiler for code that works fine. Widening to `number | null` is the correct resolution. Same for `formatMoney`, whose `Number(amountMinor || 0)` clearly tolerates nullish input.

Write `app/src/lib/currency.ts`:

```ts
// Single source of truth for the INR→USD display fallback rate, used only
// when the server's geo `display_rate` is unavailable. Must match the backend
// DISPLAY_USD_TO_INR default so every surface shows the same USD price (O5).
export const FALLBACK_USD_TO_INR = 94.67;

/** An entity carrying both currency columns: plans, credit packs, seats. */
export interface DualCurrencyAmount {
  inrMinor?: number | null;
  usdMinor?: number | null;
}

/**
 * Money formatting for minor-unit amounts (paise / cents).
 *
 * INR renders with the rupee symbol and INDIAN digit grouping
 * (₹1,52,458 - lakh/crore commas), everything else falls back to the
 * dollar symbol with western grouping. Whole amounts drop the decimals
 * (₹499 not ₹499.00); fractional amounts always show 2dp - mirrors the
 * behaviour the Billing page's fmtCurrency has always had.
 *
 * e.g. "₹1,52,458" · "₹58.31" · "$19" · "$4.50"
 */
export function formatMoney(amountMinor: number | null | undefined, currency = 'usd'): string {
  const isInr = String(currency || '').toLowerCase() === 'inr';
  const symbol = isInr ? '₹' : '$';
  // en-IN gives lakh/crore grouping (1,52,458); en-US gives western (152,458).
  const locale = isInr ? 'en-IN' : 'en-US';
  const major = Number(amountMinor || 0) / 100;
  const useDecimals = !Number.isInteger(major);
  return `${symbol}${major.toLocaleString(locale, {
    minimumFractionDigits: useDecimals ? 2 : 0,
    maximumFractionDigits: useDecimals ? 2 : 0,
  })}`;
}

/**
 * Choose the minor-unit amount for the active currency from an entity that
 * carries BOTH an INR column and a USD column (plans, packs, seats).
 *
 * INR is the charge currency for Indian accounts, so the INR column is read
 * directly (never a converted USD figure) - the number shown then equals the
 * Razorpay debit. Returns 0 when the active currency's column is absent.
 */
export function pickAmount({ inrMinor, usdMinor }: DualCurrencyAmount, currency: string): number {
  const isInr = String(currency || '').toLowerCase() === 'inr';
  return Number((isInr ? inrMinor : usdMinor) ?? 0);
}
```

- [ ] **Step 3: Delete the shim and deregister it from the guard**

```bash
cd app && git rm src/lib/currency.d.ts
```

Then remove this line from `SHIMMED_MODULES` in `src/test/shimDrift.test.ts`:

```ts
  { label: 'lib/currency', dts: 'src/lib/currency.d.ts', load: () => import('../lib/currency.js') },
```

- [ ] **Step 4: Verify**

Run:

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Expected: all green, 13 shim-drift cases remaining.

- [ ] **Step 5: Commit**

```bash
git add -A app/src/lib app/src/test/shimDrift.test.ts
git commit -m "refactor(currency): convert lib/currency to TypeScript

Widens formatMoney and pickAmount to accept nullish minor-unit amounts. The
shim declared them non-null, but both have always coerced via '|| 0' and
'?? 0', so the shim was rejecting calls that work correctly at runtime."
```

### Task 1.2: Convert `utils/trial.js`

**Files:**
- Rename: `app/src/utils/trial.js` → `app/src/utils/trial.ts`
- Delete: `app/src/utils/trial.d.ts`
- Modify: `app/src/test/shimDrift.test.ts`

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/utils/trial.js src/utils/trial.ts
```

- [ ] **Step 2: Apply the annotations**

Three signatures, straight from `trial.d.ts`. Also move the stray `import { formatDate }` to the top of the file, above the JSDoc block, where it belongs:

```ts
import { formatDate } from '../i18n/formatters';

/** Milliseconds in a day, for the ceil-rounded countdowns below. */
const DAY_MS = 86_400_000;

/**
 * Whole days left until an ISO-8601 trial-end timestamp, rounded UP.
 *
 * The single source of truth for every "N days left" surface (top banner,
 * billing badge) so they can never disagree. `ceil` - a trial ending in 2
 * hours still reads "1 day left", matching how customers count remaining
 * time and the backend's `trial_days_remaining` helper / day-N reminder cron.
 * A truncating diff would under-count by one for any partial day (10.4 days
 * left → 10, not 11).
 *
 * The ISO string carries its own UTC offset, so `Date.parse` is
 * timezone-safe regardless of the viewer's locale.
 *
 * Returns null when `iso` is missing or unparseable.
 */
export function trialDaysLeft(iso: string, nowMs: number = Date.now()): number | null {
  const endMs = Date.parse(iso);
  if (Number.isNaN(endMs)) return null;
  return Math.ceil((endMs - nowMs) / DAY_MS);
}

/**
 * Whole days between now and an ISO-8601 timestamp, rounded UP. Same
 * ceiling rule as {@link trialDaysLeft} so every countdown across the app
 * agrees. Used for the post-trial data-retention grace window ("your
 * workspace will be deleted in X days").
 */
export function daysUntil(iso: string, nowMs: number = Date.now()): number | null {
  const endMs = Date.parse(iso);
  if (Number.isNaN(endMs)) return null;
  return Math.ceil((endMs - nowMs) / DAY_MS);
}

/**
 * Render a human-friendly absolute date from an ISO string, e.g.
 * "Jul 16, 2026". Returns the input unchanged when unparseable so we
 * never render "Invalid Date" in production.
 */
export function formatTrialDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso ?? '';
  return formatDate(new Date(ms), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
```

Note the extracted `DAY_MS`: the magic number appeared twice and the two countdowns are required to agree. Naming it makes that requirement structural.

- [ ] **Step 3: Delete the shim and deregister it**

```bash
cd app && git rm src/utils/trial.d.ts
```

Remove the `utils/trial` line from `SHIMMED_MODULES`.

- [ ] **Step 4: Verify**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add -A app/src/utils app/src/test/shimDrift.test.ts
git commit -m "refactor(trial): convert utils/trial to TypeScript

Hoists the misplaced formatDate import to the top of the file and names the
day-in-milliseconds constant the two countdowns share."
```

### Task 1.3: Convert `utils/trialBanner.js`

**Files:**
- Rename: `app/src/utils/trialBanner.js` → `app/src/utils/trialBanner.ts`
- Delete: `app/src/utils/trialBanner.d.ts`
- Modify: `app/src/test/shimDrift.test.ts`

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/utils/trialBanner.js src/utils/trialBanner.ts
```

- [ ] **Step 2: Apply the annotations**

The shim types `status` as `string` on `bannerDismissKey` but `string | null | undefined` on the readers, which matches the runtime guards. Keep that asymmetry, it is correct. Change only the signature lines; leave every comment body as-is:

```ts
export function bannerDismissKey(status: string): string {
```

```ts
export function readBannerDismissed(status: string | null | undefined): boolean {
```

```ts
export function markBannerDismissed(status: string | null | undefined): void {
```

```ts
export function clearTrialBannerDismissals(): void {
```

- [ ] **Step 3: Delete the shim and deregister it**

```bash
cd app && git rm src/utils/trialBanner.d.ts
```

Remove the `utils/trialBanner` line from `SHIMMED_MODULES`.

- [ ] **Step 4: Verify**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

- [ ] **Step 5: Commit**

```bash
git add -A app/src/utils app/src/test/shimDrift.test.ts
git commit -m "refactor(trial-banner): convert utils/trialBanner to TypeScript"
```

### Task 1.4: Convert `utils/authStorage.js`

**Files:**
- Rename: `app/src/utils/authStorage.js` → `app/src/utils/authStorage.ts`
- Delete: `app/src/utils/authStorage.d.ts`
- Modify: `app/src/test/shimDrift.test.ts`

Fan-in 20, and it is mocked by three test files. The signatures are trivial but the blast radius is the largest in Phase 1, so run the whole suite, not a subset.

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/utils/authStorage.js src/utils/authStorage.ts
```

- [ ] **Step 2: Apply the annotations**

`setAuthItem` accepts anything stringifiable (the runtime does `String(value)`), and its second positional arg is documented as accepted-and-ignored for legacy callers. Type it honestly rather than pretending the parameter is gone:

```ts
export const SESSION_EXPIRY_KEY = 'admin_session_expires_at';
```

```ts
export const AUTH_STORAGE_KEYS: readonly string[] = [
```

```ts
export function setAuthItem(key: string, value: string | number | boolean | null | undefined): void {
```

```ts
export function setAuthBundle(
  items: Record<string, string | number | boolean | null | undefined>,
  persistent = true,
): void {
```

```ts
export function isSessionExpired(): boolean {
```

```ts
export function getAuthItem(key: string): string | null {
```

```ts
export function removeAuthItem(key: string): void {
```

```ts
export function clearAuthStorage(): void {
```

The shim said `setAuthItem(key: string, value: string | null)` and `setAuthBundle(items: Record<string, string>)`. Both were narrower than the runtime, which explicitly coerces with `String(value)` and skips nullish entries. Callers passing `admin_client_id` as a number were type-errors against a function that handles them correctly.

- [ ] **Step 3: Delete the shim and deregister it**

```bash
cd app && git rm src/utils/authStorage.d.ts
```

Remove the `utils/authStorage` line from `SHIMMED_MODULES`.

- [ ] **Step 4: Verify, with attention to the three mocking tests**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Expected: all green. If `tsc` now reports errors at call sites passing numbers or booleans, those call sites were always fine at runtime and the widened signature has just legalised them. If it reports errors passing objects, that is a real bug: `String({})` yields `"[object Object]"`. Fix the caller.

- [ ] **Step 5: Commit**

```bash
git add -A app/src/utils app/src/test/shimDrift.test.ts
git commit -m "refactor(auth-storage): convert utils/authStorage to TypeScript

Widens setAuthItem/setAuthBundle to the value types the runtime actually
coerces via String(). The shim declared string-only, which made every
numeric key (admin_client_id, operator_id) a type error against code that
has always handled it."
```

### Task 1.5: Convert `lib/razorpay.js`

**Files:**
- Rename: `app/src/lib/razorpay.js` → `app/src/lib/razorpay.ts`
- Delete: `app/src/lib/razorpay.d.ts`
- Modify: `app/src/test/shimDrift.test.ts`

The only Phase 1 file needing genuine type design: it touches `window.Razorpay` (a global with no `@types` package) and it rejects with errors carrying extra `code` / `detail` properties that the shim never described.

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/lib/razorpay.js src/lib/razorpay.ts
```

- [ ] **Step 2: Add the global and error types at the top of the file**

Insert directly below the existing `import { t as translateNow }` line:

```ts
/** Fields Razorpay returns in the success callback. */
export interface RazorpayCallback {
  razorpay_payment_id: string;
  razorpay_order_id?: string;
  razorpay_subscription_id?: string;
  razorpay_signature: string;
}

/** Options passed to Razorpay Checkout. Only the fields we set are declared. */
export interface RazorpayCheckoutOptions {
  key: string;
  /** Subscription flow. */
  subscription_id?: string;
  /** One-off order flow (top-ups). */
  order_id?: string;
  amount?: number;
  currency?: string;
  name?: string;
  description?: string;
  prefill?: Record<string, unknown>;
  theme?: Record<string, unknown>;
  method?: Record<string, boolean>;
  modal?: Record<string, unknown>;
  /** Razorpay customer to tokenise the instrument against (top-up `save: 1`). */
  customer_id?: string;
  /** `1` asks Razorpay to save the instrument for one-click reuse. */
  save?: 0 | 1;
}

/** Razorpay's `payment.failed` event payload, as much of it as we read. */
interface RazorpayFailureResponse {
  error?: { description?: string; [key: string]: unknown };
}

/**
 * Why a checkout attempt ended without a payment.
 *
 * `dismissed` is the customer closing the modal, which is a normal outcome and
 * must not be reported as a failure. `payment_failed` is the gateway declining.
 * Callers branch on this, so it is a discriminated field rather than a message
 * string they would otherwise have to pattern-match.
 */
export type RazorpayErrorCode = 'dismissed' | 'payment_failed';

/**
 * Checkout rejection carrying a machine-readable cause.
 *
 * Was previously a plain Error with `code` bolted on at the call site, which
 * the shim did not describe at all - so every consumer read `err.code` through
 * an `any`. A real subclass makes `instanceof` narrowing work.
 */
export class RazorpayError extends Error {
  readonly code: RazorpayErrorCode;
  readonly detail?: unknown;

  constructor(message: string, code: RazorpayErrorCode, detail?: unknown) {
    super(message);
    this.name = 'RazorpayError';
    this.code = code;
    this.detail = detail;
  }
}

/** Minimal shape of the constructor Razorpay's script hangs off `window`. */
interface RazorpayConstructor {
  new (options: Record<string, unknown>): {
    open: () => void;
    on: (event: 'payment.failed', handler: (response: RazorpayFailureResponse) => void) => void;
  };
}

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}
```

- [ ] **Step 3: Annotate the two functions**

`loadRazorpayScript` resolves the constructor. `window.Razorpay` is optional, so the two `resolve(window.Razorpay)` calls in the `existing`-script branch and the `onload` branch now need the same non-null guard the `onload` branch already has. Add it to the `existing` branch too, which is a latent bug the types just exposed: a cached-but-not-yet-evaluated script tag could resolve `undefined`.

```ts
let scriptPromise: Promise<RazorpayConstructor> | null = null;

function loadRazorpayScript(): Promise<RazorpayConstructor> {
```

Inside the `existing` branch, replace:

```ts
      existing.addEventListener('load', () => resolve(window.Razorpay));
```

with:

```ts
      existing.addEventListener('load', () => {
        // `window.Razorpay` is only populated once the tag finishes evaluating.
        // Resolving it unchecked would hand callers `undefined` as a constructor.
        if (window.Razorpay) resolve(window.Razorpay);
        else reject(new Error(translateNow('app.razorpayLoadedButConstructorMissing') || 'Razorpay loaded but constructor missing'));
      });
```

Then the public function:

```ts
export async function openRazorpayCheckout(
  options: RazorpayCheckoutOptions,
): Promise<RazorpayCallback> {
  const Razorpay = await loadRazorpayScript();
  return new Promise<RazorpayCallback>((resolve, reject) => {
    const merged = {
      ...options,
      handler: (response: RazorpayCallback) => resolve(response),
      modal: {
        ...(options.modal || {}),
        ondismiss: () => {
          reject(new RazorpayError(
            translateNow('app.checkoutDismissedByUser') || 'Checkout dismissed by user',
            'dismissed',
          ));
        },
      },
    };
    try {
      const rzp = new Razorpay(merged);
      rzp.on('payment.failed', (resp) => {
        reject(new RazorpayError(
          resp?.error?.description || translateNow('app.paymentFailedPleaseTryAgain') || 'Payment failed. Please try again.',
          'payment_failed',
          resp?.error,
        ));
      });
      rzp.open();
    } catch (err) {
      reject(err);
    }
  });
}
```

- [ ] **Step 4: Delete the shim and deregister it**

```bash
cd app && git rm src/lib/razorpay.d.ts
```

Remove the `lib/razorpay` line from `SHIMMED_MODULES`.

- [ ] **Step 5: Verify, paying attention to the 8 mocking tests**

Run:

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Expected: all green. Five test files mock `'../../lib/razorpay'` and three mock `'../../../lib/razorpay'`. If any construct a bare `Error` with `.code` to simulate a dismissal, `tsc` will now flag the mismatch. Update them to `new RazorpayError('...', 'dismissed')` and import it from the module under test.

- [ ] **Step 6: Confirm the checkout path still builds**

Run:

```bash
cd app && npm run build
```

Expected: succeeds. `declare global` in a module file is the one construct in this phase that can interact badly with `isolatedModules`; the build is the check.

- [ ] **Step 7: Commit**

```bash
git add -A app/src/lib app/src/test/shimDrift.test.ts app/src/features
git commit -m "refactor(razorpay): convert lib/razorpay to TypeScript

Replaces the ad-hoc 'Error with .code bolted on' pattern with a RazorpayError
subclass, so dismissal-vs-failure narrowing is checked rather than read off an
untyped property. Also guards the cached-script-tag branch, which could
resolve an undefined constructor if the tag had not finished evaluating."
```

### Task 1.6: Convert `utils/impersonation.js`

**Files:**
- Rename: `app/src/utils/impersonation.js` → `app/src/utils/impersonation.ts`
- Delete: `app/src/utils/impersonation.d.ts`
- Modify: `app/src/test/shimDrift.test.ts`

234 lines, fan-in 16, mocked by two tests. `impersonation.d.ts` is unusually complete (41 lines covering 8 constants, 9 functions and the `ImpersonationProfile` interface), so this is transcription rather than design.

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/utils/impersonation.js src/utils/impersonation.ts
```

- [ ] **Step 2: Move `ImpersonationProfile` into the module**

Copy the interface verbatim from the shim to the top of `impersonation.ts`, exported:

```ts
/** The redeem endpoint's 200 payload, as persisted for the tab. */
export interface ImpersonationProfile {
  client_id: number;
  /** Account name shown in the banner. */
  name: string;
  email: string;
  /** ISO-8601 instant at which the token stops being accepted. */
  expires_at: string;
  /** Super-admin who opened the session. */
  actor_email: string;
  is_impersonation: true;
}
```

- [ ] **Step 3: Annotate the eight constants and nine functions**

The eight `IMPERSONATION_*` constants need no annotation: they are string literals and inference is more precise than the shim's `: string`. Leave them bare.

Apply these return types, copied from the shim:

```ts
export function takeImpersonationTokenFromUrl(): string | null {
export function getImpersonationToken(): string | null {
export function getImpersonationProfile(): ImpersonationProfile | null {
export function isImpersonating(): boolean {
export function isImpersonationSessionEnded(): boolean {
export function startImpersonationSession(token: string, profile: unknown): void {
export function clearImpersonationSession(): void {
export function endImpersonationSession(message?: string): void {
export function endImpersonationSessionFromSignOut(): boolean {
```

`getImpersonationProfile` reads and `JSON.parse`s from storage, so it must validate before claiming `ImpersonationProfile`. If the existing body just returns `JSON.parse(raw)`, add a narrowing guard rather than casting:

```ts
export function getImpersonationProfile(): ImpersonationProfile | null {
  const raw = window.sessionStorage.getItem(IMPERSONATION_PROFILE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Storage is attacker-writable from the console and survives across
    // sessions, so the shape is checked rather than asserted. A malformed
    // profile must read as "not impersonating", never as a partial banner.
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as ImpersonationProfile).client_id === 'number' &&
      typeof (parsed as ImpersonationProfile).email === 'string' &&
      typeof (parsed as ImpersonationProfile).expires_at === 'string'
    ) {
      return parsed as ImpersonationProfile;
    }
    return null;
  } catch {
    return null;
  }
}
```

Preserve whatever the existing body does beyond parsing; only the validation is being added.

- [ ] **Step 4: Delete the shim and deregister it**

```bash
cd app && git rm src/utils/impersonation.d.ts
```

Remove the `utils/impersonation` line from `SHIMMED_MODULES`.

- [ ] **Step 5: Verify**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

- [ ] **Step 6: Commit**

```bash
git add -A app/src/utils app/src/test/shimDrift.test.ts
git commit -m "refactor(impersonation): convert utils/impersonation to TypeScript

Validates the persisted profile shape instead of trusting JSON.parse. The
value comes from sessionStorage, which is console-writable, and a malformed
profile previously produced a half-rendered impersonation banner."
```

### Task 1.7: Convert `data/platformIntegrations.js`

**Files:**
- Rename: `app/src/data/platformIntegrations.js` → `app/src/data/platformIntegrations.ts`
- Delete: `app/src/data/platformIntegrations.d.ts`
- Modify: `app/src/test/shimDrift.test.ts`

851 lines, but almost all of it is snippet strings for the Deploy page's platform list. The types are already fully specified in the shim (`PlatformEnv`, `PlatformStep`, `GetStepsOptions`, `Platform`) and the work is annotating three exported values and one function.

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/data/platformIntegrations.js src/data/platformIntegrations.ts
```

- [ ] **Step 2: Move the four type declarations into the module**

Copy them verbatim from the shim to the top of the file:

```ts
export type PlatformEnv = 'production' | 'development';

export interface PlatformStep {
  title: string;
  description: string;
  code: string | null;
  language?: string;
}

export interface GetStepsOptions {
  /** Include the crawlable attribution anchor. Defaults to true. */
  attribution?: boolean;
}

export interface Platform {
  id: string;
  name: string;
  category: string;
  description: string;
  getSteps: (botKey: string, env: PlatformEnv, options?: GetStepsOptions) => PlatformStep[];
}
```

- [ ] **Step 3: Annotate the four exported values**

```ts
export function widgetScriptUrl(env: PlatformEnv): string {
```

```ts
export const platforms: Platform[] = [
```

```ts
export const categoryLabels: Record<string, string> = {
```

```ts
export const categoryOrder: string[] = [
```

Annotating `platforms: Platform[]` is the whole point of this task: it typechecks all ~15 platform entries at once and will flag any that is missing `category`, or whose `getSteps` returns a step without `code`.

- [ ] **Step 4: Fix whatever the annotation surfaces**

Run:

```bash
cd app && npx tsc --noEmit
```

Expect errors inside the `platforms` array on the first run. Each is a real inconsistency in the data. A step that legitimately has no code block must be `code: null`, not omitted; the shim declared `code: string | null` (required, nullable), and the runtime consumers in the Deploy UI check for null.

- [ ] **Step 5: Delete the shim and deregister it**

```bash
cd app && git rm src/data/platformIntegrations.d.ts
```

Remove the `data/platformIntegrations` line from `SHIMMED_MODULES`.

- [ ] **Step 6: Verify**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

- [ ] **Step 7: Commit**

```bash
git add -A app/src/data app/src/test/shimDrift.test.ts
git commit -m "refactor(deploy): convert data/platformIntegrations to TypeScript

Annotating the platform array checks all entries against the Platform
interface at once, which is the first time the snippet data has been
validated by anything other than the Deploy page rendering it."
```

**Phase 1 exit criteria:**

```bash
cd app && find src -name "*.js" | sort
```

Expected exactly:

```
src/services/api.js
src/services/orbRenderer.js
```

And:

```bash
cd app && npm run build && npm run size
```

Expected: build green, size within budget and materially unchanged from the Task 0.1 baseline.

---

# Phase 2: React Contexts

Five `.jsx` files, ~1,492 lines, fan-in from 46 modules combined. This is where the real typing work is: provider state shapes, reducer actions, and the value object each `use*` hook returns. Every one has a detailed shim to work from, and the `CurrencyContext` and `NotificationContext` shims in particular carry long prose comments encoding hard-won billing and reconnection rules. **Preserve every one of those comments.** They document decisions the types cannot express, like "`taxRateBps: 0` is a legitimate answer, not a loading sentinel."

**The recipe, identical for all five:**

1. `git mv` the `.jsx` to `.tsx`.
2. Move the shim's `*ContextValue` interface into the `.tsx`, exported, comments intact.
3. Type `createContext<T | undefined>(undefined)` and the `use*` hook's return.
4. Type the provider as `({ children }: { children: ReactNode })`.
5. Type the internal `useState` / `useReducer` state.
6. `git rm` the `.d.ts`, deregister from `SHIMMED_MODULES`.
7. Verification triple, then commit.

**On `createContext` defaults.** Four of the five hooks throw when used outside their provider. Use `createContext<T | undefined>(undefined)` and narrow in the hook:

```ts
const BotContext = createContext<BotContextValue | undefined>(undefined);

export function useBotContext(): BotContextValue {
  const value = useContext(BotContext);
  if (!value) throw new Error('useBotContext must be used within a BotProvider');
  return value;
}
```

`NotificationContext` is the exception. Its shim documents that it deliberately returns a safe all-empty default rather than throwing, because a component can mount before the provider. Preserve that behaviour exactly; give it a real default object, not `undefined`.

**On fast refresh.** `eslint-plugin-react-refresh` runs on `.tsx` files and objects to a module exporting both a component and non-components. A context file exporting `BotProvider` (a component) plus `useBotContext` (a hook) plus `WORKSPACE_SWITCHED_EVENT` (a constant) may now trip `react-refresh/only-export-components`, where the `.jsx` version was governed by the same rule. If it fires, move the constants to a sibling `*.constants.ts` rather than disabling the rule. `trialBanner.js` already exists for exactly this reason, and its header comment explains the pattern.

### Task 2.1: Convert `context/BotContext.jsx`

**Files:**
- Rename: `app/src/context/BotContext.jsx` → `app/src/context/BotContext.tsx`
- Delete: `app/src/context/BotContext.d.ts`
- Modify: `app/src/test/shimDrift.test.ts`

Highest fan-in of the five (23 modules, 12 test files mock it) but the smallest value object. Do it first: it validates the recipe against the widest blast radius while the type surface is still simple.

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/context/BotContext.jsx src/context/BotContext.tsx
```

- [ ] **Step 2: Move the value interface into the module**

Add to the top of `BotContext.tsx`, keeping every comment:

```ts
import { createContext, useContext, type ReactNode } from 'react';
import type { Bot } from '../types/domain';

export interface BotContextValue {
  bots: Bot[];
  /** The active bot scope. `null` means "All agents" (workspace-aggregated). */
  selectedBot: Bot | null;
  /** Set the active bot scope. Pass `null` to select the All-agents view. */
  selectBot: (bot: Bot | null) => void;
  refreshBots: () => Promise<Bot[]>;
  loading: boolean;
  error: { message: string; status: number | null } | null;
  /** True when the user is viewing the workspace-aggregated scope. */
  isAllAgents: boolean;
}
```

Merge this with whatever the file already imports from `react`; do not add a second import statement.

- [ ] **Step 3: Type the context, provider and hook**

```ts
const BotContext = createContext<BotContextValue | undefined>(undefined);

export function BotProvider({ children }: { children: ReactNode }) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [selectedBot, setSelectedBot] = useState<Bot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<BotContextValue['error']>(null);
  // ... existing body unchanged
}

export function useBotContext(): BotContextValue {
  const value = useContext(BotContext);
  if (!value) throw new Error('useBotContext must be used within a BotProvider');
  return value;
}
```

`useState<BotContextValue['error']>` rather than restating the shape: the value interface is the single definition and an indexed access keeps them from diverging.

- [ ] **Step 4: Delete the shim and deregister it**

```bash
cd app && git rm src/context/BotContext.d.ts
```

Remove the `context/BotContext` line from `SHIMMED_MODULES`.

- [ ] **Step 5: Verify against all 12 mocking tests**

Run:

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Expected: all green. Nine test files mock `'../../context/BotContext'` and three mock `'../context/BotContext'`. A mock returning a partial value object will now fail typecheck. Fill in the missing fields rather than casting the mock to `any`: a mock that lies about the context shape is how a passing test hides a broken screen.

- [ ] **Step 6: Commit**

```bash
git add -A app/src/context app/src/test/shimDrift.test.ts app/src/features
git commit -m "refactor(bots): convert context/BotContext to TypeScript"
```

### Task 2.2: Convert `context/CurrencyContext.jsx`

**Files:**
- Rename: `app/src/context/CurrencyContext.jsx` → `app/src/context/CurrencyContext.tsx`
- Delete: `app/src/context/CurrencyContext.d.ts`
- Modify: `app/src/test/shimDrift.test.ts`

The 59-line shim is the most heavily documented in the repo, and the documentation is load-bearing: it encodes when a surface may render a price and why `taxRateBps: 0` is an answer rather than a sentinel. Transcribe it in full.

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/context/CurrencyContext.jsx src/context/CurrencyContext.tsx
```

- [ ] **Step 2: Move the `CurrencyValue` interface across verbatim**

Copy the entire interface from `CurrencyContext.d.ts` into the `.tsx`, including all six doc comments. Do not summarise them. The comment on `taxRateBps` is the reason nobody has shipped a wrong tax disclosure; the comment on `loading` is the reason no surface flips a displayed price under the user.

Tighten two fields that the shim left loose, now that the module owns them:

```ts
  /** Lowercase display currency. */
  currency: 'inr' | 'usd';
```

```ts
  isInr: boolean;
```

The shim said `currency: string`. The prose already says it is `'inr' | 'usd'`, and a union makes the `isInr` derivation checkable.

- [ ] **Step 3: Type the context, provider and hook**

```ts
const CurrencyContext = createContext<CurrencyValue | undefined>(undefined);

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [country, setCountryState] = useState<string | null>(null);
  const [currency, setCurrency] = useState<CurrencyValue['currency']>('inr');
  const [taxRateBps, setTaxRateBps] = useState(0);
  const [loading, setLoading] = useState(true);
  const [countrySource, setCountrySource] = useState<CurrencyValue['countrySource']>(null);
  // ... existing body unchanged
}

export function useCurrency(): CurrencyValue {
  const value = useContext(CurrencyContext);
  if (!value) throw new Error('useCurrency must be used within a CurrencyProvider');
  return value;
}
```

- [ ] **Step 4: Delete the shim and deregister it**

```bash
cd app && git rm src/context/CurrencyContext.d.ts
```

Remove the `context/CurrencyContext` line from `SHIMMED_MODULES`.

- [ ] **Step 5: Verify**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Expected: all green. Four test files mock `'../../../context/CurrencyContext'`. The `currency` narrowing to `'inr' | 'usd'` will reject a mock returning `'INR'` uppercase; that mock was wrong, since the runtime lowercases.

- [ ] **Step 6: Commit**

```bash
git add -A app/src/context app/src/test/shimDrift.test.ts app/src/features
git commit -m "refactor(currency): convert context/CurrencyContext to TypeScript

Narrows `currency` from string to 'inr' | 'usd', which the shim's own prose
already specified. All billing rule comments carried across verbatim: they
document decisions the types cannot express."
```

### Task 2.3: Convert `context/WorkspaceContext.jsx`

**Files:**
- Rename: `app/src/context/WorkspaceContext.jsx` → `app/src/context/WorkspaceContext.tsx`
- Delete: `app/src/context/WorkspaceContext.d.ts`
- Modify: `app/src/test/shimDrift.test.ts`

318 lines, fan-in 13. Exports two event-name constants alongside the provider and hook, so this is the task most likely to hit the fast-refresh lint rule.

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/context/WorkspaceContext.jsx src/context/WorkspaceContext.tsx
```

- [ ] **Step 2: Move the value interface across**

Copy `WorkspaceContextValue` verbatim from the shim. Tighten the two role fields, which the shim documented as a three-value union but typed as `string | null`:

```ts
/** Seat role within a workspace. */
export type WorkspaceRole = 'owner' | 'admin' | 'operator';
```

```ts
  currentRole: WorkspaceRole | null;
  /** Effective seat role in the active workspace. */
  effectiveRole: WorkspaceRole | null;
```

And replace `error: unknown` with the same shape `BotContext` uses, so the two contexts report failures identically:

```ts
  error: { message: string; status: number | null } | null;
```

- [ ] **Step 3: Type the context, provider and hook**

```ts
const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<number | null>(null);
  const [error, setError] = useState<WorkspaceContextValue['error']>(null);
  const [accessDeniedForWorkspaceId, setAccessDenied] = useState<number | null>(null);
  // ... existing body unchanged
}

export function useWorkspace(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used within a WorkspaceProvider');
  return value;
}
```

`switchWorkspace` takes an optional navigate callback; keep the shim's signature exactly:

```ts
  const switchWorkspace = useCallback(
    async (
      id: number,
      opts?: { navigate?: (path: string, options?: { replace?: boolean }) => void },
    ): Promise<Workspace> => {
      // ... existing body unchanged
    },
    [/* existing deps */],
  );
```

- [ ] **Step 4: If `react-refresh/only-export-components` fires, split the constants**

Run:

```bash
cd app && npm run lint
```

If it reports `react-refresh/only-export-components` on `WORKSPACE_SWITCHED_EVENT` / `WORKSPACE_ACCESS_DENIED_EVENT`, create `app/src/context/workspaceEvents.ts`:

```ts
/**
 * Workspace lifecycle event names, in their own module so WorkspaceContext.tsx
 * stays components-only, which is the contract Vite's fast refresh enforces.
 * Same reason utils/trialBanner.ts exists separately from TrialBanner.tsx.
 */

/** Dispatched on `window` after the active workspace changes. */
export const WORKSPACE_SWITCHED_EVENT = 'oyechats:workspace-switched';

/** Dispatched when the API rejects a workspace-scoped request with 403. */
export const WORKSPACE_ACCESS_DENIED_EVENT = 'oyechats:workspace-access-denied';
```

Copy the actual string values from the current `.tsx` rather than the placeholders above, re-export nothing from the context file, and update the importing modules:

```bash
cd app && grep -rn "WORKSPACE_SWITCHED_EVENT\|WORKSPACE_ACCESS_DENIED_EVENT" src
```

Point each import at `../context/workspaceEvents`.

If the rule does not fire, skip this step entirely. Do not split preemptively.

- [ ] **Step 5: Delete the shim and deregister it**

```bash
cd app && git rm src/context/WorkspaceContext.d.ts
```

Remove the `context/WorkspaceContext` line from `SHIMMED_MODULES`.

- [ ] **Step 6: Verify**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Expected: all green. Six test files mock this context. The `WorkspaceRole` narrowing will reject any mock using a role string outside the three-value union.

- [ ] **Step 7: Commit**

```bash
git add -A app/src/context app/src/test/shimDrift.test.ts app/src
git commit -m "refactor(workspace): convert context/WorkspaceContext to TypeScript

Narrows currentRole/effectiveRole to the owner|admin|operator union the shim
documented in prose, and aligns the error shape with BotContext so the two
report failures identically."
```

### Task 2.4: Convert `context/CrawlContext.jsx`

**Files:**
- Rename: `app/src/context/CrawlContext.jsx` → `app/src/context/CrawlContext.tsx`
- Delete: `app/src/context/CrawlContext.d.ts`
- Modify: `app/src/test/shimDrift.test.ts`

411 lines but only fan-in 3. It drives long-lived polling for crawl progress, so the state machine is the interesting part. `CrawlState` already lives in `src/types/domain.ts`.

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/context/CrawlContext.jsx src/context/CrawlContext.tsx
```

- [ ] **Step 2: Move both interfaces across verbatim**

Copy `StartCrawlOptions` and `CrawlContextValue` from the shim into the `.tsx`, exported. `StartCrawlOptions` is a 10-field object with several nullable numbers; transcribe it exactly, do not simplify.

- [ ] **Step 3: Type the context, provider and hook**

```ts
const CrawlContext = createContext<CrawlContextValue | undefined>(undefined);

export function CrawlProvider({ children }: { children: ReactNode }) {
  const [crawl, setCrawl] = useState<CrawlState>(/* existing initial value */);
  // ... existing body unchanged
}

export function useCrawl(): CrawlContextValue {
  const value = useContext(CrawlContext);
  if (!value) throw new Error('useCrawl must be used within a CrawlProvider');
  return value;
}
```

- [ ] **Step 4: Type the polling timer handles**

This file holds interval or timeout ids in refs. In a DOM context `setInterval` returns `number`, not Node's `Timeout`. If `tsc` complains about the ref type, the fix is:

```ts
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
```

`ReturnType<typeof setInterval>` rather than a hardcoded `number`, so the same code typechecks under both the DOM and Node lib sets that Vitest and Vite each pull in.

- [ ] **Step 5: Delete the shim and deregister it**

```bash
cd app && git rm src/context/CrawlContext.d.ts
```

Remove the `context/CrawlContext` line from `SHIMMED_MODULES`.

- [ ] **Step 6: Verify**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Pay attention to `src/features/agents/knowledge/add/WebsiteFlow.test.tsx`, the main consumer of this context.

- [ ] **Step 7: Commit**

```bash
git add -A app/src/context app/src/test/shimDrift.test.ts app/src/features
git commit -m "refactor(crawl): convert context/CrawlContext to TypeScript"
```

### Task 2.5: Convert `context/NotificationContext.jsx`

**Files:**
- Rename: `app/src/context/NotificationContext.jsx` → `app/src/context/NotificationContext.tsx`
- Delete: `app/src/context/NotificationContext.d.ts`
- Modify: `app/src/test/shimDrift.test.ts`

454 lines, the largest context. REST hydrate plus a `/ws/notifications` WebSocket plus a 30-second poll fallback while disconnected. Two things make it different from the other four: it deliberately does not throw outside its provider, and it is the sole consumer of the six notification API functions declared back in Task 0.3.

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/context/NotificationContext.jsx src/context/NotificationContext.tsx
```

- [ ] **Step 2: Move the value interface across verbatim**

Copy `NotificationContextValue` from the shim, all comments intact.

- [ ] **Step 3: Type the context with a real default, not `undefined`**

The shim documents this explicitly: the hook returns a safe all-empty default rather than throwing, so a component mounting before the provider never crashes the tree. Preserve it.

```ts
/**
 * The value `useNotifications` returns outside a provider.
 *
 * Deliberately a working object rather than `undefined` + a throw, unlike
 * every other context in this app. The bell can mount on routes that do not
 * wrap the provider, and a crash there would take down the whole shell over a
 * badge count. Every mutator resolves without doing anything.
 */
const EMPTY_NOTIFICATIONS: NotificationContextValue = {
  items: [],
  unreadCount: 0,
  connected: false,
  loading: false,
  incomingHandoff: null,
  dismissIncomingHandoff: () => {},
  markRead: async () => {},
  markAllRead: async () => {},
  dismiss: async () => {},
  clearAll: async () => {},
  refresh: async () => {},
};

const NotificationContext = createContext<NotificationContextValue>(EMPTY_NOTIFICATIONS);

export function useNotifications(): NotificationContextValue {
  return useContext(NotificationContext);
}
```

- [ ] **Step 4: Type the provider state and the WebSocket handler**

```ts
export function NotificationProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const socketRef = useRef<WebSocket | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // ... existing body unchanged
}
```

The WebSocket `onmessage` handler receives `MessageEvent`, whose `.data` is `any`. Parse into `unknown` and narrow before pushing into state, the same way Task 1.6 handled the persisted profile. A notification arriving over the socket is server-controlled but the parse still needs a guard, because a malformed frame must not corrupt the feed:

```ts
    socket.onmessage = (event: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        // A frame we cannot parse is dropped, not fatal: the 30s poll
        // fallback will re-hydrate the feed on the next tick anyway.
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) return;
      // ... existing dispatch on the parsed frame
    };
```

- [ ] **Step 5: Delete the shim and deregister it**

```bash
cd app && git rm src/context/NotificationContext.d.ts
```

Remove the `context/NotificationContext` line from `SHIMMED_MODULES`.

- [ ] **Step 6: Verify**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Expected: all green. `SHIMMED_MODULES` started at 14, lost 7 in Phase 1 and 5 in Phase 2, so two entries remain: `PremiumOrb` and `services/api`. (`orbRenderer` and `main` never had shims.) Confirm:

```bash
cd app && npx vitest run src/test/shimDrift.test.ts
```

Expected: 2 passing cases.

- [ ] **Step 7: Commit**

```bash
git add -A app/src/context app/src/test/shimDrift.test.ts app/src
git commit -m "refactor(notifications): convert context/NotificationContext to TypeScript

Keeps the deliberate no-throw default (the bell can mount outside the
provider) and guards the WebSocket frame parse, so a malformed frame drops to
the 30s poll fallback instead of corrupting the feed."
```

**Phase 2 exit criteria:**

```bash
cd app && find src -name "*.jsx" | sort
```

Expected exactly:

```
src/features/agents/experience/PremiumOrb.jsx
src/main.jsx
```

And a full build:

```bash
cd app && npm run build && npm run size
```

---

# Phase 3: Rendering and Entry Point

Three files, 516 lines. Small, but `main.tsx` touches `index.html` and is the one rename in this plan that breaks the app instantly if done wrong.

### Task 3.1: Convert `services/orbRenderer.js`

**Files:**
- Rename: `app/src/services/orbRenderer.js` → `app/src/services/orbRenderer.ts`

279 lines of canvas rendering, fan-in 1 (`PremiumOrb.jsx`), and the only legacy module with **no** shim, which means no TS file imports it today and there is no specification to work from. Read the source and type it from scratch.

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/services/orbRenderer.js src/services/orbRenderer.ts
```

- [ ] **Step 2: Let `tsc` enumerate the work**

Run:

```bash
cd app && npx tsc --noEmit
```

Under `strict`, expect errors concentrated in three places: canvas context acquisition, `requestAnimationFrame` handle types, and untyped internal geometry objects.

- [ ] **Step 3: Guard the canvas context**

`getContext('2d')` returns `CanvasRenderingContext2D | null`. Never assert it away; a null context means the browser refused the canvas and the correct response is to stop, not to crash mid-frame:

```ts
  const ctx = canvas.getContext('2d');
  // A null 2D context means the browser declined the surface (rare, but real
  // on memory-pressured mobile). Bail rather than throwing inside a rAF frame,
  // where the error would be swallowed and the orb would silently freeze.
  if (!ctx) return null;
```

- [ ] **Step 4: Type the animation handle**

```ts
  let frameHandle: number | null = null;
```

`requestAnimationFrame` returns `number` in the DOM lib. Unlike the timer refs in Phase 2, this one has no Node equivalent to reconcile.

- [ ] **Step 5: Give the exported entry point an explicit signature**

Whatever the module's public function is, annotate its parameters and return type explicitly rather than relying on inference. This is a public boundary and the shim that would have documented it never existed:

```ts
export interface OrbRendererHandle {
  /** Stops the animation loop and releases the canvas context. */
  destroy: () => void;
}
```

Adjust to match the actual exported surface once you have read the file.

- [ ] **Step 6: Verify**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

- [ ] **Step 7: Commit**

```bash
git add -A app/src/services
git commit -m "refactor(orb): convert services/orbRenderer to TypeScript

Guards the nullable 2D canvas context instead of assuming it. This module
had no .d.ts, so it was the one legacy file no TS code could import at all."
```

### Task 3.2: Convert `PremiumOrb.jsx`

**Files:**
- Rename: `app/src/features/agents/experience/PremiumOrb.jsx` → `.tsx`
- Delete: `app/src/features/agents/experience/PremiumOrb.d.ts`
- Modify: `app/src/test/shimDrift.test.ts`

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/features/agents/experience/PremiumOrb.jsx src/features/agents/experience/PremiumOrb.tsx
```

- [ ] **Step 2: Move the props interface from the shim**

Read `PremiumOrb.d.ts` (19 lines) and move its prop declarations into the `.tsx` as an exported `PremiumOrbProps` interface, then annotate the component:

```ts
export function PremiumOrb({ /* existing destructured props */ }: PremiumOrbProps) {
```

- [ ] **Step 3: Type the canvas ref against Task 3.1's handle**

```ts
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<OrbRendererHandle | null>(null);
```

This is the payoff from Task 3.1: the component and the renderer now agree on a checked interface instead of both trusting an untyped module.

- [ ] **Step 4: Delete the shim and deregister it**

```bash
cd app && git rm src/features/agents/experience/PremiumOrb.d.ts
```

Remove the `features/agents/experience/PremiumOrb` line from `SHIMMED_MODULES`.

- [ ] **Step 5: Verify**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Watch `src/features/agents/experience/experience.test.tsx` in particular.

- [ ] **Step 6: Commit**

```bash
git add -A app/src/features/agents/experience app/src/test/shimDrift.test.ts
git commit -m "refactor(orb): convert PremiumOrb to TypeScript"
```

### Task 3.3: Convert `main.jsx` and update `index.html`

**Files:**
- Rename: `app/src/main.jsx` → `app/src/main.tsx`
- Modify: `app/index.html:34`

The Vite entry point. `index.html` names it by path, so the rename and the HTML edit **must land in the same commit**. A rename alone gives a blank page with a 404 in the console and nothing else.

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/main.jsx src/main.tsx
```

- [ ] **Step 2: Update the HTML entry**

In `app/index.html`, change line 34:

```html
  <script type="module" src="/src/main.jsx"></script>
```

to:

```html
  <script type="module" src="/src/main.tsx"></script>
```

- [ ] **Step 3: Confirm no other reference to `main.jsx` survives**

Run:

```bash
cd /Users/a12345/Desktop/AI/OyeChats/platform-admin-redesign && grep -rn "main\.jsx" app --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=dist-e2e
```

Expected: no output. If `plugins/vite-plugin-oyechats-pwa.js` or `vercel.json` names the entry, update those too.

The comment in `utils/authStorage.ts` mentions "the guard in main.jsx" in prose. Update that reference to `main.tsx` while you are here.

- [ ] **Step 4: Type the root mount**

`document.getElementById` returns `HTMLElement | null` and `createRoot` will not accept null. Do not use `!`:

```ts
const container = document.getElementById('root');
// The element is authored directly in index.html, so a null here means the
// HTML shell itself failed to load. Throwing gives a named error in Sentry
// instead of "Cannot read properties of null" from inside React.
if (!container) throw new Error('Root element #root not found in index.html');

createRoot(container).render(/* existing tree unchanged */);
```

- [ ] **Step 5: Verify the app actually boots**

The test suite does not exercise the entry point, so `npm test` passing proves nothing here. Build and preview:

```bash
cd app && npm run build && npm run preview
```

Then open the printed URL and confirm the login screen renders with a clean console. This is the one manual check in the plan and it is not optional: nothing automated covers `index.html`.

- [ ] **Step 6: Verify**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

- [ ] **Step 7: Commit**

```bash
git add -A app/src/main.tsx app/index.html app/src/utils/authStorage.ts
git commit -m "refactor(entry): convert main.jsx to TypeScript

index.html names the entry by path, so the rename and the HTML edit land
together. Also replaces the implicit non-null on #root with a named throw, so
a missing shell reports itself rather than surfacing as a React null deref."
```

**Phase 3 exit criteria:**

```bash
cd app && find src -name "*.jsx" -o -name "*.js" | sort
```

Expected exactly: `src/services/api.js`.

---

# Phase 4: The API Client

One file, 3,859 lines before Task 0.2 and roughly 3,470 after, with fan-in 119 and 53 test files mocking it. This is the largest single risk in the plan and gets its own phase.

**Why this is less work than the line count suggests.** `api.d.ts` is 1,106 lines and, after Phase 0, declares all 194 runtime exports with real parameter and return types referencing `src/types/domain.ts`. The types are already designed. Phase 4 is a merge, not a typing exercise.

**Why it still needs care.** The first ~300 lines are not endpoint functions. They are the axios instance, the error builder, the workspace abort controller, and three interceptors implementing impersonation header suppression and read-only write blocking. That is where all the actual type design lives.

**Sequencing: corrected by measurement.** The original plan split this into a green Task 4.2 (module head) and a batched Task 4.3. **That is not possible.** A trial rename measured the following:

| | |
| --- | --- |
| Errors from a bare `git mv api.js api.ts` | 428 |
| ...inside `api.ts` | 309 |
| ...in **other** files | 119 |

The 119 external errors exist because `api.d.ts` declares 36 `interface`/`type` blocks (`CrawlProgress`, `BillingGeoResponse`, `IngestJobStatus`, `UploadCostPreview`, the six `Journey*` types, `NotificationPreferences`, …) that consumers import as types. The moment `api.ts` exists, `./api` resolves to it and those imports break. Moving the 36 blocks into `api.ts` drops the total to 368 and the external count to 59.

Those remaining 59 are all **symptomatic**, not separate work: they are downstream of `api.ts` functions being inferred from their JS bodies rather than from the shim. `crawlWebsite(url, botId, useJs, replaceSource = null, …)` infers `replaceSource: null`, so every caller passing a string is rejected; `getBots()` infers `Promise<any>`, so `data.find((bot) => …)` is an implicit any. Annotating the 194 signatures clears all 59 without touching those files.

So **Phase 4 lands as one commit.** A knowingly-red intermediate commit is worse than a large one: it breaks `git bisect` on the file with the highest fan-in in the app. Review it by reading `api.d.ts` against `api.ts` side by side, which is a signature-for-signature comparison, not a 3,400-line read.

**Shape of the work, measured:**

- `api.ts` has **193 `export const NAME = async (…) => {}`** implementations and **1 `export function`** (`rotateWorkspaceAbort`).
- `api.d.ts` has **193 `export function NAME(…): R;`** declarations and **1 `export const`** (`httpClient: AxiosInstance`).
- **53 of the 193 declarations span multiple lines**, so any parser over them must brace/paren-match rather than work line-wise.
- The implementations already carry their own JSDoc, usually richer than the shim's. Where the shim adds something the implementation lacks (e.g. `updateBot`'s "returns a status message, NOT the bot - re-fetch/merge for fresh fields"), carry that sentence across; it is the only documentation of that behaviour.

**Annotate parameters, do not inline function types.** Converting `export const updateBot = async (botId, data) => {` to `export const updateBot: (botId: number, data: Record<string, unknown>) => Promise<{ message: string }> = async (botId, data) => {` is the fully mechanical transform and needs no positional mapping, but 194 of them is unreadable. Write the idiomatic form instead:

```ts
export const updateBot = async (
  botId: number,
  data: Record<string, unknown>,
): Promise<{ message: string }> => {
```

Mapping the shim's parameter types onto the implementation's parameter names is positional and reliable (both were written by the same hand, against each other), with one rule to respect: **a parameter that has a default cannot also carry `?`.** Where the shim says `params?: LeadsQuery` and the implementation says `params = {}`, the result is `params: LeadsQuery = {}`, never `params?: LeadsQuery = {}`, which is a syntax error.

**Scratchpad artefacts from the trial run** (regenerate rather than trust if the file has moved on): `phase4-extract-types.py` extracts the 36 type blocks with their JSDoc and brace-matches interface bodies; `phase4-moved-types.ts` is its 447-line output, verified brace-balanced.

**Order of work inside the single commit:**

1. `git mv src/services/api.js src/services/api.ts`
2. Fix `src/services/api.smoke.test.ts:15` — `import('./api.js')` → `import('./api')`
3. Move the 36 type blocks from `api.d.ts` into `api.ts`, below the imports
4. Replace `buildApiError`'s plain-Error construction with `new ApiError(...)` from `./apiTypes`
5. Type the module head: `API_BASE_URL`, `PUBLIC_AUTH_PATHS`, `currentWorkspaceAbortController`, `dropHeader`, the two impersonation predicates, and the `IMPERSONATED_REQUEST` symbol on the axios config
6. Annotate all 194 signatures from the shim
7. Delete `api.d.ts`, add the `ApiError`/`isApiError` re-export to `api.ts`
8. Delete `src/test/shimDrift.test.ts` — this is Task 5.1, pulled forward because `it.each([])` on an empty `SHIMMED_MODULES` fails vitest with "No test found in suite"

**Do not re-export `ApiError` from `api.d.ts` as an interim step.** It was tried; `api.js` does not export it, so the shim would be claiming an export its module lacks. The drift guard was extended to catch exactly that (value re-exports, not just declarations) after it let the first attempt through.

### Task 4.1: Extract shared API types into `apiTypes.ts`

**Files:**
- Create: `app/src/services/apiTypes.ts`
- Modify: `app/src/services/api.js`

Extract first, while the file is still `.js`. Splitting and converting in one step produces a diff nobody can review.

- [ ] **Step 1: Create the types module**

Create `app/src/services/apiTypes.ts`:

```ts
import type { AxiosError } from 'axios';

/**
 * The error every API call rejects with.
 *
 * `buildApiError` in api.ts has always attached `status`, `code` and `detail`
 * to a plain Error, and api.d.ts never described any of them, so all 119
 * consumers read those fields through an implicit `any`. A real subclass makes
 * `instanceof ApiError` narrowing work and makes the impersonation codes
 * below checkable rather than stringly-typed.
 */
export class ApiError extends Error {
  /** HTTP status, or null for a network-level failure with no response. */
  readonly status: number | null;
  /** Machine-readable cause from the backend's error envelope, when present. */
  readonly code: string | null;
  /** The raw response body, for callers that need more than message + code. */
  readonly detail: unknown;

  constructor(
    message: string,
    options: { status?: number | null; code?: string | null; detail?: unknown } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status ?? null;
    this.code = options.code ?? null;
    this.detail = options.detail;
  }
}

/** Narrowing helper for `catch` blocks, which receive `unknown` under strict. */
export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * The backend's standard error envelope. Not every endpoint returns all of it,
 * hence every field optional.
 */
export interface ApiErrorEnvelope {
  detail?: string | { message?: string; code?: string };
  message?: string;
  code?: string;
}

/** An axios error whose response body is the standard envelope. */
export type ApiAxiosError = AxiosError<ApiErrorEnvelope>;

/** The shape every paginated list endpoint returns. */
export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
```

- [ ] **Step 2: Verify it compiles standalone**

Run:

```bash
cd app && npx tsc --noEmit
```

Expected: clean. Nothing imports it yet.

- [ ] **Step 3: Re-export `ApiError` from the shim so consumers can migrate**

Add to the end of `app/src/services/api.d.ts`:

```ts
export type { ApiError, Paginated } from './apiTypes';
```

- [ ] **Step 4: Verify and commit**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

```bash
git add app/src/services/apiTypes.ts app/src/services/api.d.ts
git commit -m "types(api): extract ApiError and shared envelope types

buildApiError has always attached status/code/detail to a plain Error and
api.d.ts never described them, so all 119 consumers read those fields through
an implicit any. Extracted ahead of the conversion so the .ts rename is a
pure move."
```

### Task 4.2: Convert the module head

**Files:**
- Rename: `app/src/services/api.js` → `app/src/services/api.ts`
- Modify: `app/src/services/api.smoke.test.ts:15`

This task converts only the infrastructure at the top of the file. Endpoint functions get `// @ts-expect-error` free treatment because they will still typecheck loosely until Task 4.3 tightens them; if `tsc` floods with endpoint errors, that is expected and you fix them in 4.3, not here.

- [ ] **Step 1: Rename**

```bash
cd app && git mv src/services/api.js src/services/api.ts
```

- [ ] **Step 2: Fix the one extension-carrying import in the repo**

`src/services/api.smoke.test.ts:15` uses a dynamic import with an explicit extension, the single exception noted in the Ground Rules. Change:

```ts
    const module = await import('./api.js');
```

to:

```ts
    const module = await import('./api');
```

- [ ] **Step 3: Replace `buildApiError` with the `ApiError` constructor**

Import from the new module and rewrite the builder to return a real `ApiError`. Keep its existing message-extraction logic exactly; only the construction changes:

```ts
import { ApiError, type ApiAxiosError } from './apiTypes';
```

```ts
const buildApiError = (
  error: unknown,
  fallbackMessage: string = translateNow('app.requestFailed') || 'Request failed',
): ApiError => {
  // ... existing message / status / code extraction, unchanged
  return new ApiError(message, { status, code, detail });
};
```

- [ ] **Step 4: Type the module-level state**

```ts
const API_BASE_URL: string = import.meta.env.VITE_API_URL || 'https://api.oyechats.com';
const PUBLIC_AUTH_PATHS: readonly string[] = [
let currentWorkspaceAbortController: AbortController | null = null;
const IMPERSONATION_SAFE_METHODS: readonly string[] = ['get', 'head', 'options'];
```

- [ ] **Step 5: Type the interceptor helpers**

`dropHeader` mutates an axios headers object, which is `AxiosRequestHeaders`, not a plain record:

```ts
import type { AxiosRequestHeaders } from 'axios';

function dropHeader(headers: AxiosRequestHeaders, name: string): void {
```

The two impersonation predicates take the error union:

```ts
function isImpersonationBlockedWrite(error: unknown): boolean {
function applyImpersonationForbiddenCopy(error: ApiError): void {
```

`IMPERSONATED_REQUEST` is a `Symbol` used as a config flag. Axios config is not indexable by symbol under strict, so declare the augmentation next to it rather than casting at every use site:

```ts
const IMPERSONATED_REQUEST = Symbol('oyechats.impersonatedRequest');

declare module 'axios' {
  interface InternalAxiosRequestConfig {
    /** Marks a request issued inside an impersonated session, so the response
     *  interceptor can rewrite 403 copy without re-deriving the context. */
    [IMPERSONATED_REQUEST]?: boolean;
  }
}
```

- [ ] **Step 6: Confirm the module still evaluates**

Run:

```bash
cd app && npx vitest run src/services/api.smoke.test.ts
```

Expected: PASS. This is the check that matters most in Phase 4. If it fails with `ReferenceError: Cannot access 'api' before initialization`, an export was reordered above the `axios.create` call; that exact bug once took down every screen, which is why the test exists.

- [ ] **Step 7: Run lint and tests, and record the `tsc` error count**

```bash
cd app && npm run lint && npm test
npx tsc --noEmit 2>&1 | grep -c "error TS"
```

Record the number. It will be non-zero and concentrated in endpoint bodies. Task 4.3 drives it to zero.

- [ ] **Step 8: Commit**

```bash
git add -A app/src/services
git commit -m "refactor(api): convert the API client module head to TypeScript

Types the axios instance, error builder, workspace abort rotation and the
three impersonation interceptors. buildApiError now returns a real ApiError.
Endpoint bodies are typed in the following commits; tsc is not yet clean."
```

### Task 4.3: Type the endpoint functions in batches

**Files:**
- Modify: `app/src/services/api.ts`
- Modify: `app/src/services/api.d.ts` (progressively emptied)

194 exported endpoint functions, all already declared in `api.d.ts`. Work in batches of roughly 40, moving each function's signature from the shim onto the implementation and deleting it from the shim as you go. The shim shrinks to nothing across five commits; the drift guard stays green throughout because it compares value exports and you are only relocating them.

- [ ] **Step 1: Establish the batch loop**

For each batch of ~40 consecutive functions in `api.ts`:

1. For each function, find its declaration in `api.d.ts`.
2. Copy the parameter types and return type onto the implementation.
3. Copy any doc comment from the shim that is not a type restatement.
4. Delete that declaration from `api.d.ts`.

Concretely, a shim line like:

```ts
export function listNotifications(params?: {
  limit?: number; beforeId?: number; unreadOnly?: boolean;
}): Promise<{ items: NotificationItem[]; unread_count: number }>;
```

becomes, in `api.ts`:

```ts
export const listNotifications = async (
  { limit = 30, beforeId, unreadOnly = false }: {
    limit?: number;
    beforeId?: number;
    unreadOnly?: boolean;
  } = {},
): Promise<{ items: NotificationItem[]; unread_count: number }> => {
  try {
    const params: Record<string, unknown> = { limit };
    if (beforeId) params.before_id = beforeId;
    if (unreadOnly) params.unread_only = true;
    const response = await api.get('/notifications', { params });
    return response.data;
  } catch (error) {
    throw buildApiError(error, 'Failed to load notifications');
  }
};
```

- [ ] **Step 2: Prefer typing the axios generic over annotating the return**

Where the body is a plain `return response.data`, put the type on the request instead. It flows to the return and it also checks the `.data` access:

```ts
    const response = await api.get<{ items: NotificationItem[]; unread_count: number }>('/notifications', { params });
    return response.data;
```

- [ ] **Step 3: After each batch, verify and commit**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

The `tsc` error count from Task 4.2 Step 7 should fall with each batch. Commit per batch:

```bash
git add app/src/services/api.ts app/src/services/api.d.ts
git commit -m "refactor(api): type endpoint batch 1/5 (auth, workspaces, bots)"
```

Name the domains in each message so `git log` reads as a map of the file.

- [ ] **Step 4: After the final batch, confirm the shim is empty**

Run:

```bash
cd app && grep -cE "^export " src/services/api.d.ts
```

Expected: `0`, or only the `export type { ApiError, Paginated } from './apiTypes';` line added in Task 4.1.

- [ ] **Step 5: Delete the shim and deregister it from the guard**

```bash
cd app && git rm src/services/api.d.ts
```

Remove the `services/api` line from `SHIMMED_MODULES` in `src/test/shimDrift.test.ts`. `SHIMMED_MODULES` is now empty.

Move the `ApiError` / `Paginated` re-export to `api.ts` so consumers importing them from `./api` keep working:

```ts
export { ApiError, isApiError } from './apiTypes';
export type { Paginated } from './apiTypes';
```

- [ ] **Step 6: Verify, including the 53 mocking test files**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

Expected: fully green, `tsc` error count zero. Mocks returning wrong-shaped payloads will surface here. Fix the mock to match the real response type; do not loosen the real type to match a wrong mock.

- [ ] **Step 7: Build and check the bundle**

```bash
cd app && npm run build && npm run size
```

Compare against the Task 0.1 baseline. The conversion erases types at build time, so the initial-load chunk should be within a few hundred bytes, minus whatever the 20 dead functions from Task 0.2 were contributing.

- [ ] **Step 8: Commit**

```bash
git add -A app/src/services app/src/test/shimDrift.test.ts
git commit -m "refactor(api): retire api.d.ts, the last shim

All 194 endpoint signatures now live on their implementations. The shim
layer that api.d.ts anchored is gone, so there is no longer any module in
app/ whose types are asserted rather than checked."
```

**Phase 4 exit criteria:**

```bash
cd app && find src -name "*.js" -o -name "*.jsx" -o -name "*.d.ts" | sort
```

Expected: no output at all.

---

# Phase 5: Seal the Door

The migration is worthless if a `.js` file reappears next month. This phase makes that a build failure and removes the now-dead dual-mode configuration.

### Task 5.1: Delete the drift guard

**Files:**
- Delete: `app/src/test/shimDrift.test.ts`

Its `SHIMMED_MODULES` array is empty and `tsc` now does its job natively.

- [ ] **Step 1: Confirm the array is empty and no shims remain**

```bash
cd app && find src -name "*.d.ts" | wc -l | tr -d ' '
```

Expected: `0`.

- [ ] **Step 2: Delete it**

```bash
cd app && git rm src/test/shimDrift.test.ts
```

- [ ] **Step 3: Verify and commit**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test
```

```bash
git add -A app/src/test
git commit -m "test: remove the shim-drift guard, no shims left to guard

Scaffolding that did its job. tsc checks implementations against their own
annotations natively now."
```

### Task 5.2: Retire the dual-mode configuration

**Files:**
- Modify: `app/eslint.config.js`
- Modify: `app/tsconfig.json`
- Delete: `app/jsconfig.json`

- [ ] **Step 1: Delete the legacy ESLint block**

In `app/eslint.config.js`, remove the entire `── Legacy JavaScript / JSX ──` config object (the one with `files: ['**/*.{js,jsx}']`). Update the header comment, which currently describes a migration that is over:

```js
// One lint domain: the app is fully TypeScript. `scripts/**/*.mjs` keeps its
// own minimal block because the i18n tooling is plain Node ESM, not app code.
```

Keep the `scripts/**/*.mjs` block. Those eight i18n scripts are Node tooling, out of scope for this migration, and the block exists because one of them had a duplicate object key that nothing else would have caught.

Keep `eslint.config.js`, `vite.config.js` and `plugins/vite-plugin-oyechats-pwa.js` as `.js`. They are build-time Node config, not application source, and converting them buys nothing.

- [ ] **Step 2: Widen the tsconfig and rewrite the stale note**

In `app/tsconfig.json`, replace the `"//"` key. It currently points at `app/docs/ADMIN_2.0_AUDIT_AND_ARCHITECTURE_PLAN.md`, and `app/docs/` is empty, so the reference is dead:

```json
  "//": "app/src is 100% TypeScript. allowJs stays false and scripts/assert-no-legacy-js.mjs enforces it in CI; see docs/superpowers/plans/2026-08-27-app-typescript-migration.md.",
  "include": ["src/**/*.ts", "src/**/*.tsx"],
```

Leave `allowJs: false` and `checkJs: false` exactly as they are. With zero `.js` in `src`, `allowJs: false` is now a wall rather than an exclusion.

- [ ] **Step 3: Delete `jsconfig.json`**

```bash
cd app && cat jsconfig.json
```

If it only configures editor resolution for the old JS files, it is dead:

```bash
cd app && git rm jsconfig.json
```

If it carries a path alias that `tsconfig.json` lacks, port the alias into `tsconfig.json` first, then delete.

- [ ] **Step 4: Verify and commit**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test && npm run build
```

```bash
git add -A app/eslint.config.js app/tsconfig.json app/jsconfig.json
git commit -m "chore: retire the dual JS/TS configuration

Drops the legacy js,jsx ESLint block and jsconfig.json, and replaces the
tsconfig note that pointed at a plan document which no longer exists."
```

### Task 5.3: Add the CI guard

**Files:**
- Create: `app/scripts/assert-no-legacy-js.mjs`
- Modify: `app/package.json`

- [ ] **Step 1: Write the guard**

Create `app/scripts/assert-no-legacy-js.mjs`:

```js
#!/usr/bin/env node
/**
 * Fails if any `.js` or `.jsx` file appears under `app/src`.
 *
 * `allowJs: false` in tsconfig means a stray `.js` is not a type error, it is
 * simply invisible: the file builds via Vite, ships to production, and the
 * compiler never looks at it. That is exactly how the strangler-fig migration
 * accumulated 16 unchecked modules. This turns the invisible case into a
 * failing build.
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
```

- [ ] **Step 2: Wire it into `package.json`**

Add to `scripts`:

```json
    "guard:no-legacy-js": "node scripts/assert-no-legacy-js.mjs",
```

And chain it onto lint so it runs everywhere lint runs, including whatever CI already calls:

```json
    "lint": "eslint . && node scripts/assert-no-legacy-js.mjs",
```

- [ ] **Step 3: Confirm it passes**

Run:

```bash
cd app && npm run guard:no-legacy-js
```

Expected: `app/src: TypeScript only, no legacy JavaScript.`

- [ ] **Step 4: Prove it actually fails**

Same discipline as Task 0.4 Step 3. An untested guard is not a guard:

```bash
cd app && echo "export const canary = 1;" > src/__canary.js && npm run guard:no-legacy-js
```

Expected: exit 1, with `src/__canary.js` listed.

Clean up:

```bash
cd app && rm src/__canary.js && npm run guard:no-legacy-js
```

Expected: passes again.

- [ ] **Step 5: Verify and commit**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test && npm run build
```

```bash
git add app/scripts/assert-no-legacy-js.mjs app/package.json
git commit -m "chore: fail the build if JavaScript returns to app/src

allowJs:false makes a stray .js invisible rather than invalid: it builds via
Vite, ships, and tsc never sees it. This makes that case loud."
```

### Task 5.4: Final verification

**Files:** none

- [ ] **Step 1: Confirm the file census**

```bash
cd app && for e in js jsx ts tsx; do printf "%s: %s\n" "$e" "$(find src -name "*.$e" | wc -l | tr -d ' ')"; done
find app/src -name "*.d.ts" | wc -l | tr -d ' '
```

Expected: `js: 0`, `jsx: 0`, zero `.d.ts`, and a `ts` + `tsx` total of 662 or 663: the 646 that existed at baseline, plus the 16 converted files, plus `apiTypes.ts`, minus the deleted `shimDrift.test.ts`, plus `workspaceEvents.ts` only if Task 2.3 Step 4 was triggered.

- [ ] **Step 2: Run everything**

```bash
cd app && npm run lint && npx tsc --noEmit && npm test && npm run build && npm run size
```

Expected: all green. Compare `size` output against the Task 0.1 baseline. A regression larger than a kilobyte or two needs explaining before this ships: TypeScript erases at build time, so the bundle should be flat or slightly smaller.

- [ ] **Step 3: Run the end-to-end suite**

The unit suite mocks the API everywhere. The Playwright specs in `app/tests/e2e/` drive the real bundle against a mock backend, which is the only automated check that the converted API client and contexts work together:

```bash
cd app && npm run e2e
```

If Playwright browsers are not installed:

```bash
cd app && npm run e2e:install && npm run e2e
```

Expected: all specs pass.

- [ ] **Step 4: Boot the app manually one final time**

```bash
cd app && npm run build && npm run preview
```

Log in, switch workspace, open the notification bell, visit Billing, and open the Deploy tab. These five paths cover every context converted in Phase 2 plus the currency and platform-integration modules from Phase 1, which the unit tests exercise only through mocks.

- [ ] **Step 5: Commit any final fixes**

```bash
git add -A app
git commit -m "chore(app): complete the TypeScript migration

app/src is now 100% TypeScript with no .d.ts shims. Every module's types are
checked against its implementation instead of asserted alongside it."
```

---

## Out of Scope

Stated so nobody expands the plan mid-flight.

**`widget/`** (36 `.js` + 29 `.jsx`, zero TS). Separate build (`vite.loader.config.js` + `vite.app.config.js`), hard gzipped budgets enforced by `size-limit` (8KB loader, ~90KB eager path), and no shim layer, so it has none of the drift problem this plan exists to fix. Converting it is a separate decision with a different justification. Revisit after this lands.

**`app/scripts/*.mjs`** (8 i18n tooling scripts). Node build tooling, never shipped to a browser, already covered by their own ESLint block. No benefit.

**`app/vite.config.js`, `app/eslint.config.js`, `app/plugins/*.js`.** Build-time config. Converting them adds a compile step to the build's own configuration for no checking benefit.

**Splitting `api.ts`.** At ~3,400 lines it is larger than one file should be, and splitting it by domain (auth, billing, bots, live chat, superadmin) is a real improvement. It is also a change to 119 import sites, which would make the Phase 4 diff unreviewable and unbisectable. Do it as a follow-up, once the file is TypeScript and the compiler can verify the split moved everything.

---

## Effort

| Phase | Files | Lines | Estimate |
| --- | ---: | ---: | --- |
| 0. Baseline and safety net | 3 | ~250 new | 0.5 day |
| 1. Leaf utilities | 7 | 1,466 | 1 day |
| 2. React contexts | 5 | 1,492 | 2 days |
| 3. Rendering and entry | 3 | 516 | 0.5 day |
| 4. API client | 1 | ~3,470 | 3 to 4 days |
| 5. Seal the door | 4 | ~100 new | 0.5 day |
| **Total** | **23** | **~7,350** | **7.5 to 8.5 days** |

One engineer. Twenty-two commits across six phases, every one independently revertible. The estimate assumes each phase ships as its own PR rather than one migration branch: a 7,000-line review is not a review.

**The estimate's main risk is Phase 4 Step 6**, where 53 mocking test files meet real types for the first time. Every mock returning a wrong-shaped payload becomes a compile error at once. Those are pre-existing bugs in the tests, not migration work, but they land in this phase's budget. If that step balloons, the correct response is to fix the mocks properly rather than widen the real types to accommodate them.
