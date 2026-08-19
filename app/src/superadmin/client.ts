import { httpClient } from '../services/api';

/**
 * The platform console's HTTP layer.
 *
 * Roughly a hundred `/superadmin/*` endpoints had no client function of any
 * kind, which is the same thing as saying the console did not exist. They are
 * not added one-by-one to `services/api.js`: they belong to a different product
 * with a different persona, and a hundred near-identical wrappers would be a
 * thousand lines of code that says nothing. This is four functions and a shared
 * error shape instead.
 *
 * It reuses the app's axios instance deliberately — the auth header, the
 * impersonation suppression, the 401 handling and the error shaping all live on
 * that client's interceptors, and a second `axios.create` would quietly lose
 * every one of them.
 */

const PREFIX = '/superadmin';

export interface PlatformError extends Error {
  status: number | null;
  /** The server's own `detail`, when it sent one worth showing. */
  detail: unknown;
}

function shape(error: unknown, fallback: string): PlatformError {
  const response = (error as { response?: { status?: number; data?: { detail?: unknown } } })?.response;
  const detail = response?.data?.detail;
  const message =
    typeof detail === 'string'
      ? detail
      : typeof (detail as { message?: string })?.message === 'string'
        ? (detail as { message: string }).message
        : error instanceof Error
          ? error.message
          : fallback;
  return Object.assign(new Error(message), {
    status: response?.status ?? null,
    detail: detail ?? null,
  });
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

/** Drop empty params so a cleared filter does not send `status=` and match nothing. */
function clean(params: QueryParams | undefined): QueryParams {
  if (!params) return {};
  const out: QueryParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    out[key] = value;
  }
  return out;
}

export const platform = {
  async get<T>(path: string, params?: QueryParams): Promise<T> {
    try {
      const response = await httpClient.get<T>(`${PREFIX}${path}`, { params: clean(params) });
      return response.data;
    } catch (error) {
      throw shape(error, `Could not load ${path}.`);
    }
  },

  async post<T>(path: string, body?: unknown): Promise<T> {
    try {
      const response = await httpClient.post<T>(`${PREFIX}${path}`, body ?? {});
      return response.data;
    } catch (error) {
      throw shape(error, `Could not complete ${path}.`);
    }
  },

  async patch<T>(path: string, body?: unknown): Promise<T> {
    try {
      const response = await httpClient.patch<T>(`${PREFIX}${path}`, body ?? {});
      return response.data;
    } catch (error) {
      throw shape(error, `Could not update ${path}.`);
    }
  },

  async put<T>(path: string, body?: unknown): Promise<T> {
    try {
      const response = await httpClient.put<T>(`${PREFIX}${path}`, body ?? {});
      return response.data;
    } catch (error) {
      throw shape(error, `Could not save ${path}.`);
    }
  },

  async remove<T>(path: string): Promise<T> {
    try {
      const response = await httpClient.delete<T>(`${PREFIX}${path}`);
      return response.data;
    } catch (error) {
      throw shape(error, `Could not delete ${path}.`);
    }
  },
};

/**
 * The envelope almost every list endpoint returns.
 *
 * Note that several `/superadmin/*` endpoints answer with a bare **object**
 * rather than a list — `/api-keys` and `/visitors` among them. Those want
 * `usePlatformResource`, not `usePlatformList`: `toList` cannot read a shape
 * that has no array in it and will hand back an empty one.
 */
export interface PlatformList<T> {
  items: T[];
  total: number;
  page?: number;
  limit?: number;
}

/**
 * Normalise a list response.
 *
 * The super-admin endpoints were written over a long period and do not agree on
 * a shape: some return `{items,total}`, some `{results,count}`, some a bare
 * array under a name matching the resource. Rather than make every screen guess,
 * every screen goes through this.
 */
export function toList<T>(raw: unknown, key?: string): PlatformList<T> {
  if (Array.isArray(raw)) return { items: raw as T[], total: raw.length };
  const record = (raw ?? {}) as Record<string, unknown>;
  const candidates = [key, 'items', 'results', 'data', 'rows'].filter(Boolean) as string[];
  for (const candidate of candidates) {
    const value = record[candidate];
    if (Array.isArray(value)) {
      const total = record.total ?? record.count ?? value.length;
      return {
        items: value as T[],
        total: typeof total === 'number' ? total : value.length,
        page: typeof record.page === 'number' ? record.page : undefined,
        limit: typeof record.limit === 'number' ? record.limit : undefined,
      };
    }
  }
  return { items: [], total: 0 };
}
