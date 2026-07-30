import { useCallback, useMemo } from 'react';
import { useEntitlementsContext } from '../context/EntitlementsContext';
import type { Entitlements, FeatureKey, LimitKey } from '../types/domain';

/** Sentinel meaning "no limit" - mirrors `plan_entitlements_service.py::UNLIMITED`. */
const UNLIMITED = -1;

export interface UseEntitlementsResult {
  entitlements: Entitlements;
  loading: boolean;
  error: Error | null;
  /** Re-fetch entitlements now - call after an action that changes the plan. */
  refresh: () => Promise<void>;
  isFree: boolean;
  isEnterprise: boolean;
  planSlug: string;
  planName: string;
  /** True when the named feature flag is enabled. String flags (`integrations`)
   * count as "on" when set to any non-empty value - callers that need the
   * specific value read `entitlements.features.integrations` directly. */
  hasFeature: (key: FeatureKey) => boolean;
  /** The configured ceiling for `key`. `-1` means unlimited. Unknown/missing
   * values return `0` - the same "nothing allowed" conservative default the
   * backend resolver uses. */
  limitFor: (key: LimitKey) => number;
  /** True if `current` is still under the limit for `key`. Always true when unlimited. */
  withinLimit: (key: LimitKey, current: number) => boolean;
  /** How many of `key` are left before hitting the limit. `Infinity` when unlimited. */
  remaining: (key: LimitKey, current: number) => number;
}

/**
 * useEntitlements - typed selector over `EntitlementsContext`.
 *
 * Ported from the legacy `hooks/useEntitlements.js` `decorate()` helpers
 * (`hasFeature` / `limitFor` / `withinLimit` / `remaining`) with identical
 * semantics, now backed by the Context provider instead of a module-scope
 * cache. Must be called under `<EntitlementsProvider>` (mounted in
 * `ProtectedLayout`).
 */
export function useEntitlements(): UseEntitlementsResult {
  const { entitlements, loading, error, refresh } = useEntitlementsContext();

  const hasFeature = useCallback(
    (key: FeatureKey): boolean => {
      const value = entitlements.features[key];
      if (typeof value === 'boolean') return value;
      // `integrations` is the one non-boolean flag ("all" | "reply_to_only") -
      // both literal values are non-empty, so presence alone means "on".
      return Boolean(value);
    },
    [entitlements.features],
  );

  const limitFor = useCallback(
    (key: LimitKey): number => {
      const value = entitlements.limits[key];
      return typeof value === 'number' ? value : 0;
    },
    [entitlements.limits],
  );

  const withinLimit = useCallback(
    (key: LimitKey, current: number): boolean => {
      const limit = limitFor(key);
      if (limit === UNLIMITED) return true;
      return current < limit;
    },
    [limitFor],
  );

  const remaining = useCallback(
    (key: LimitKey, current: number): number => {
      const limit = limitFor(key);
      if (limit === UNLIMITED) return Infinity;
      return Math.max(0, limit - current);
    },
    [limitFor],
  );

  return useMemo<UseEntitlementsResult>(
    () => ({
      entitlements,
      loading,
      error,
      refresh,
      isFree: entitlements.is_free || entitlements.plan_slug === 'free',
      isEnterprise: entitlements.is_enterprise || entitlements.plan_slug === 'enterprise',
      planSlug: entitlements.plan_slug,
      planName: entitlements.plan_name,
      hasFeature,
      limitFor,
      withinLimit,
      remaining,
    }),
    [entitlements, loading, error, refresh, hasFeature, limitFor, withinLimit, remaining],
  );
}

export default useEntitlements;
