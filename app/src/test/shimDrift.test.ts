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
