import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { platform, toList, type PlatformList, type QueryParams } from './client';

/**
 * The platform console's data hooks.
 *
 * Two of them, because the console is two screens repeated a hundred times: a
 * filtered list of records, and one record with things you can do to it. Every
 * section is built from those, which is what stops a hundred endpoints becoming
 * a hundred bespoke pages.
 */

export interface PlatformListState<T> {
  items: T[];
  total: number;
  loading: boolean;
  error: string | null;
  /** True when a 403 came back — the caller is signed in but not permitted. */
  forbidden: boolean;
  reload: () => void;
}

/**
 * A page of records.
 *
 * `params` is compared by its serialised form rather than by identity, so a
 * caller can build the object inline without re-fetching on every render — the
 * mistake that made the previous journey view fire thirty requests on load.
 */
export function usePlatformList<T>(
  path: string,
  options: { key?: string; params?: QueryParams; enabled?: boolean } = {},
): PlatformListState<T> {
  const { key, params, enabled = true } = options;
  const serialised = JSON.stringify(params ?? {});
  const [state, setState] = useState<PlatformList<T>>({ items: [], total: 0 });
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [nonce, setNonce] = useState(0);
  const tokenRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const token = (tokenRef.current += 1);
    let active = true;

    async function load(): Promise<void> {
      setLoading(true);
      try {
        const raw = await platform.get<unknown>(path, JSON.parse(serialised) as QueryParams);
        if (!active || token !== tokenRef.current) return;
        setState(toList<T>(raw, key));
        setError(null);
        setForbidden(false);
      } catch (err) {
        if (!active || token !== tokenRef.current) return;
        const status = (err as { status?: number | null }).status ?? null;
        setForbidden(status === 403);
        setError(err instanceof Error ? err.message : 'Could not load these records.');
      } finally {
        if (active && token === tokenRef.current) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [path, key, serialised, enabled, nonce]);

  const reload = useCallback(() => setNonce((current) => current + 1), []);

  return { items: state.items, total: state.total, loading, error, forbidden, reload };
}

export interface PlatformResourceState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  forbidden: boolean;
  reload: () => void;
}

/**
 * One record, or one aggregate.
 *
 * `path` of `null` means "nothing selected" and fetches nothing. `params` is
 * compared by its serialised form, like `usePlatformList`, so a caller can build
 * it inline — without that, the windowed aggregates were reaching for template
 * strings and hand-encoding their own query strings.
 */
export function usePlatformResource<T>(
  path: string | null,
  params?: QueryParams,
): PlatformResourceState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [nonce, setNonce] = useState(0);
  const tokenRef = useRef(0);
  const serialised = JSON.stringify(params ?? {});

  useEffect(() => {
    const token = (tokenRef.current += 1);
    let active = true;

    async function load(): Promise<void> {
      if (!path) {
        setData(null);
        setError(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      // Cleared before the request: a previous customer's record under a newly
      // opened customer's name is the worst thing a support console can show.
      setData(null);
      try {
        const raw = await platform.get<T>(path, JSON.parse(serialised) as QueryParams);
        if (!active || token !== tokenRef.current) return;
        setData(raw);
        setError(null);
        setForbidden(false);
      } catch (err) {
        if (!active || token !== tokenRef.current) return;
        const status = (err as { status?: number | null }).status ?? null;
        setForbidden(status === 403);
        setError(err instanceof Error ? err.message : 'Could not load this record.');
      } finally {
        if (active && token === tokenRef.current) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [path, serialised, nonce]);

  const reload = useCallback(() => setNonce((current) => current + 1), []);
  return { data, loading, error, forbidden, reload };
}

export interface UrlState {
  get: (key: string, fallback?: string) => string;
  getNumber: (key: string, fallback: number) => number;
  set: (patch: Record<string, string | number | null>) => void;
}

/**
 * Filters and paging, kept in the query string.
 *
 * Every list in this console is something an operator will want to send to a
 * colleague — "look at this customer's failed webhooks" — and a filter held in
 * component state cannot be sent to anyone. Setting a filter also resets the
 * page, because a filtered set almost never has the page you were on.
 */
export function useUrlState(pageKey = 'page'): UrlState {
  const [params, setParams] = useSearchParams();

  return useMemo(
    () => ({
      get: (key, fallback = '') => params.get(key) ?? fallback,
      getNumber: (key, fallback) => {
        const parsed = Number(params.get(key));
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
      },
      set: (patch) => {
        setParams(
          (current) => {
            const draft = new URLSearchParams(current);
            let touchedFilter = false;
            for (const [key, value] of Object.entries(patch)) {
              if (value === null || value === '') draft.delete(key);
              else draft.set(key, String(value));
              if (key !== pageKey) touchedFilter = true;
            }
            if (touchedFilter && !(pageKey in patch)) draft.delete(pageKey);
            return draft;
          },
          { replace: true },
        );
      },
    }),
    [params, setParams, pageKey],
  );
}
