/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { getEntitlements } from '../services/api';
import { WORKSPACE_SWITCHED_EVENT } from './WorkspaceContext';
import type { Entitlements } from '../types/domain';
import { t as translateNow } from '../i18n/i18n';

/**
 * EntitlementsContext - the single source of truth for "what can this
 * workspace do on its current plan?"
 *
 * Ported from the legacy `hooks/useEntitlements.js` module-scope cache into a
 * proper Context so it composes with the rest of the Admin 2.0 provider tree
 * (mounted in `ProtectedLayout`, after `WorkspaceProvider`/`NotificationProvider`
 * so auth + workspace context already exist). Behavior carried over from the
 * legacy hook:
 *
 *  - Fetches `GET /auth/me/entitlements` once on mount.
 *  - Re-fetches on workspace switch, listening for the same
 *    `oyechats:workspace-switched` window event `WorkspaceContext` and
 *    `NotificationContext` already broadcast/consume - plan/limit/feature
 *    flags are workspace-scoped, so switching contexts must refetch.
 *  - On fetch failure, falls back to a typed Free-plan default rather than
 *    throwing or blocking the app - the safe, most-restrictive default.
 *  - Exposes `refresh()` for callers to bust the cache after an action that
 *    changes the plan (subscription upgrade, topup purchase).
 */

/** Most-restrictive Free-plan defaults - matches the backend's seeded Free
 * plan (`_FREE_FALLBACK_LIMITS` / `_FREE_FALLBACK_FEATURES` in
 * `plan_entitlements_service.py`) and the legacy hook's `FREE_FALLBACK`. */
// @i18n-exempt: this mirrors the API's own payload, field for field. plan_name
// is data the backend sends, not chrome we author; a translated value here
// would not match what every other surface reads from the server.
export const FREE_FALLBACK: Entitlements = {
  plan_slug: 'free',
  plan_name: 'Free',
  subscription_status: 'none',
  limits: {
    credits: 200,
    bots: 1,
    operators: 0,
    // Leads dashboard is feature-locked on Free (sidebar gate); the numeric
    // quota is UNLIMITED so lead storage keeps working for the surfaces a
    // Free workspace can still reach.
    leads: -1,
    page_scraping: 20,
    documents: 5,
    chat_history_days: 7,
    max_crawl_pages: 20,
    max_crawl_depth: 2,
  },
  features: {
    live_chat: false,
    bant: false,
    branding_removable: false,
    webhooks: false,
    api_access: false,
    online_support: false,
    topup_allowed: false,
    integrations: 'reply_to_only',
  },
  usage: {},
  is_free: true,
  topup_allowed: false,
};

export interface EntitlementsContextValue {
  entitlements: Entitlements;
  loading: boolean;
  error: Error | null;
  /** Re-fetch entitlements now - call after any action that changes the plan. */
  refresh: () => Promise<void>;
}

const EntitlementsContext = createContext<EntitlementsContextValue | null>(null);

export function EntitlementsProvider({ children }: { children: ReactNode }): ReactElement {
  const [entitlements, setEntitlements] = useState<Entitlements>(FREE_FALLBACK);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  // Guards against a stale in-flight response (from a fetch a newer refresh
  // superseded) overwriting fresher state once it resolves.
  const requestIdRef = useRef<number>(0);

  const load = useCallback(async (): Promise<void> => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    try {
      const data = await getEntitlements();
      if (requestIdRef.current !== requestId) return;
      setEntitlements(data);
      setError(null);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      // Fail open on the client: lock down to Free defaults rather than
      // crash or leave a stale, possibly-paid entitlements snapshot in
      // place. Deny-by-default matches the backend resolver's own policy.
      setEntitlements(FREE_FALLBACK);
      setError(err instanceof Error ? err : new Error(translateNow('app.failedToLoadEntitlements') || 'Failed to load entitlements'));
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onWorkspaceSwitched = (): void => {
      void load();
    };
    window.addEventListener(WORKSPACE_SWITCHED_EVENT, onWorkspaceSwitched);
    return () => window.removeEventListener(WORKSPACE_SWITCHED_EVENT, onWorkspaceSwitched);
  }, [load]);

  return (
    <EntitlementsContext.Provider value={{ entitlements, loading, error, refresh: load }}>
      {children}
    </EntitlementsContext.Provider>
  );
}

/** Internal - consumed by `hooks/useEntitlements.ts`. Not exported from the design system. */
export function useEntitlementsContext(): EntitlementsContextValue {
  const ctx = useContext(EntitlementsContext);
  if (!ctx) {
    return {
      entitlements: FREE_FALLBACK,
      loading: false,
      error: null,
      refresh: async () => {},
    };
  }
  return ctx;
}
