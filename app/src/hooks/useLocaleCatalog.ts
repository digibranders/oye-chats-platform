import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { getLocales } from '../services/api';
import {
  type LocaleCatalog,
  type LocaleEntry,
  directionForLocale,
  getLocaleCatalog,
  labelForLanguage,
  nameForLocale,
  setLocaleCatalog,
  subscribeLocaleCatalog,
} from '../services/localeCatalog';

/**
 * useLocaleCatalog - the backend locale registry, fetched once per session.
 *
 * `GET /locales` is deploy-static, so there is one request per page load
 * regardless of how many components ask for it, and no invalidation: a locale
 * cannot change without a deploy that reloads the bundle anyway.
 *
 * Components call this to *subscribe*, not only to read. The catalogue lands
 * after first paint, and the pure readers in `services/localeCatalog` cannot
 * re-render anything on their own - so a component that renders a language
 * name has to be here, or it keeps showing "HI" until something else moves.
 */

let inflight: Promise<void> | null = null;

/** Fetch the catalogue at most once per page load, including across retries. */
function ensureLoaded(): void {
  if (inflight !== null || getLocaleCatalog().ready) return;
  inflight = getLocales()
    .then((payload) => {
      setLocaleCatalog(payload);
    })
    .catch(() => {
      // A missing catalogue is a cosmetic degradation, never a broken screen:
      // names fall back to their uppercased tag. Clearing `inflight` lets the
      // next mount retry, which covers a transient network failure without a
      // retry loop.
      inflight = null;
    });
}

export interface UseLocaleCatalogResult {
  /** Every supported locale, in catalogue order. Empty until loaded. */
  locales: LocaleEntry[];
  /** False until `GET /locales` has resolved. */
  ready: boolean;
  /** English name for a base language or locale: `hi-IN` -> "Hindi". */
  labelFor: (code: string | null | undefined) => string | null;
  /** Name for a specific locale: `en-IN` -> "English (India)". */
  localeNameFor: (locale: string | null | undefined) => string | null;
  /** Text direction for a locale or bare language code. */
  directionFor: (locale: string | null | undefined) => 'ltr' | 'rtl';
}

export function useLocaleCatalog(): UseLocaleCatalogResult {
  ensureLoaded();
  const catalog: LocaleCatalog = useSyncExternalStore(subscribeLocaleCatalog, getLocaleCatalog);

  // Re-created when the catalogue changes so a memoised consumer re-renders
  // with the loaded names rather than holding a stale closure.
  const labelFor = useCallback(
    (code: string | null | undefined) => labelForLanguage(code),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog],
  );
  const localeNameFor = useCallback(
    (locale: string | null | undefined) => nameForLocale(locale),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog],
  );
  const directionFor = useCallback(
    (locale: string | null | undefined) => directionForLocale(locale),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [catalog],
  );

  return useMemo(
    () => ({ locales: catalog.locales, ready: catalog.ready, labelFor, localeNameFor, directionFor }),
    [catalog, labelFor, localeNameFor, directionFor],
  );
}

export default useLocaleCatalog;
