import { QueryClient } from '@tanstack/react-query';

import { ApiError } from '../services/apiTypes';

/**
 * The HTTP status behind a rejection, whatever shape it arrives in.
 *
 * Nearly every read in `services/api.ts` funnels its rejection through
 * `buildApiError`, which returns an `ApiError` carrying `status` directly and
 * NO `response` object. The retry predicate below used to read
 * `error.response.status` only, so for the app's own errors the status was
 * always `undefined` and its "never retry a client error" rule never once
 * fired: every 401, 403, 404 and 422 was re-sent twice, on a 1s then 2s
 * backoff. That put three seconds of skeletons in front of every forbidden and
 * not-found state, and tripled the traffic to endpoints a workspace is not
 * entitled to.
 *
 * The axios shape stays as a fallback for any rejection that reaches the cache
 * without passing through `buildApiError`.
 */
function statusOf(error: unknown): number | undefined {
  if (error instanceof ApiError) return error.status;
  return (error as { response?: { status?: number } })?.response?.status;
}

/**
 * The console's query client.
 *
 * The app this replaces had no cache layer at all: `/auth/me` was fetched from
 * ten independent places, the journey page mounted one hook three times and
 * fired roughly thirty requests every fifteen seconds, and lists went stale
 * after a mutation with nothing to invalidate them. Every default below is a
 * direct answer to one of those.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      /**
       * Thirty seconds.
       *
       * Long enough that navigating Home → Leads → Home does not refetch the
       * same workspace three times, short enough that an operator who leaves a
       * tab open for a minute is not reading yesterday's numbers. Surfaces with
       * a stricter freshness requirement — the inbox queue, credit balance —
       * override it rather than the default being tuned for the worst case.
       */
      staleTime: 30_000,
      gcTime: 5 * 60_000,

      /**
       * Always run, even when the browser says it is offline.
       *
       * The default is `online`, which PAUSES a query instead of running it:
       * `isPending` stays true, `isError` never fires, and the surface renders
       * its skeleton for as long as the tab is open. Every page in this console
       * ships an error state precisely so a failure can be seen and retried,
       * and a paused query hides the failure behind a permanent loading state
       * that no consumer branching on `isError` can react to. `navigator.onLine`
       * is also wrong far more often than it is right: it reports a captive
       * portal, a VPN flap and a headless browser as offline. Let the request
       * go out and let the failure be a failure.
       */
      networkMode: 'always',

      /**
       * Refetch when the user comes back to the window, but not on every mount.
       *
       * Alt-tabbing back is a real signal that the data may have moved on;
       * mounting a component is not, and treating it as one is what turned a
       * dashboard into forty requests.
       */
      refetchOnWindowFocus: true,
      refetchOnMount: false,
      refetchOnReconnect: true,

      /**
       * Retry twice, but never a client error.
       *
       * A 401, 403, 404 or 422 will not become true by asking again — it just
       * delays the error state the user needs to see, and on a 403 it hammers
       * an endpoint the workspace is not entitled to.
       */
      retry: (failureCount, error) => {
        const status = statusOf(error);
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    },
    mutations: {
      // A mutation is a user action. Retrying it silently can double-charge a
      // card or send a second email; the user decides whether to try again.
      retry: false,
      // Same reason as the queries above, and it matters more here: a paused
      // mutation leaves the button spinning with no error and no way back, and
      // the customer clicks it again.
      networkMode: 'always',
    },
  },
});
