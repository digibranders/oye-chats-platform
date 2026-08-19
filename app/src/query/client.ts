import { QueryClient } from '@tanstack/react-query';

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
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (status && status >= 400 && status < 500) return false;
        return failureCount < 2;
      },
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    },
    mutations: {
      // A mutation is a user action. Retrying it silently can double-charge a
      // card or send a second email; the user decides whether to try again.
      retry: false,
    },
  },
});
