/**
 * The lead list and the pipeline summary, fetched once and shared.
 *
 * Two things changed from the hook this replaces. It runs on TanStack Query, so
 * the same page is not refetched when the drawer opens and closes and the
 * summary is not fetched twice by two components. And the filters that the API
 * actually supports — `tier`, `min_score`, `page`, `limit` — are sent to the
 * server, rather than pulling a 200-row slice and filtering it in the browser
 * while reporting the truncated count as the total.
 */
import { useCallback, useMemo, useRef } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getLeadStats, getLeads, markAllLeadsViewed, markLeadViewed } from '../../services/api';
import { keys } from '../../query/keys';
import type { Lead, LeadsResult } from '../../types/domain';
import { readLeadStats, type LeadStatsSummary, type TierKey } from './leadModel';

/** How many rows one page of the table holds. The API's own ceiling is 200. */
export const LEADS_PAGE_SIZE = 50;

export interface LeadsRequest {
  /** `undefined` while the chatbot list resolves; `null` for every chatbot. */
  botId: number | undefined;
  tier: TierKey | null;
  minScore: number | null;
  /**
   * The date window, resolved once by the page from its own URL state
   * (`leadsRangeWindow`). `days` and `from`/`to` are mutually exclusive —
   * the API takes either, never both — but this hook does not enforce that
   * itself; it only forwards whichever the caller resolved.
   */
  days: number | null;
  from: string | null;
  to: string | null;
  page: number;
}

export interface LeadsData {
  leads: Lead[];
  /** Every lead matching the server-side filters, not just this page. */
  total: number;
  page: number;
  pageCount: number;
  stats: LeadStatsSummary | null;
  loading: boolean;
  /** A page change is in flight while the previous page stays on screen. */
  fetching: boolean;
  error: Error | null;
  /**
   * The workspace's plan does not include this surface — a 403, not a failure.
   * Kept apart from `error` because "we could not load your leads" and "your
   * plan does not include leads" are different answers and the page owes the
   * reader the right one.
   */
  locked: boolean;
  retry: () => void;
  markRead: (sessionId: string) => void;
  markAllRead: () => Promise<void>;
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null)?.status;
}

export function useLeads(request: LeadsRequest): LeadsData {
  const queryClient = useQueryClient();
  const { botId, tier, minScore, days, from, to, page } = request;

  // Memoised because it is a `useCallback` dependency below: a key rebuilt on
  // every render would give the row-level handlers a new identity each time and
  // re-render every row in the table.
  const listKey = useMemo(
    () =>
      keys.leads.list({
        botId: botId ?? null,
        tier,
        minScore,
        days,
        from,
        to,
        page,
        limit: LEADS_PAGE_SIZE,
      }),
    [botId, tier, minScore, days, from, to, page],
  );
  const statsKey = useMemo(
    () => keys.leads.stats(botId ?? null, days === null && from === null && to === null ? null : { days, from, to }),
    [botId, days, from, to],
  );

  const list = useQuery<LeadsResult>({
    queryKey: listKey,
    queryFn: () =>
      getLeads(botId, {
        // The API names this filter `status`; it is its documented alias for
        // `tier` and the only spelling the shared client sends.
        ...(tier ? { status: tier } : null),
        ...(minScore !== null ? { min_score: minScore } : null),
        ...(days !== null ? { days } : null),
        ...(from !== null ? { from_date: from } : null),
        ...(to !== null ? { to_date: to } : null),
        page,
        limit: LEADS_PAGE_SIZE,
      }),
    // Paging should not blank the table. The previous page stays until the next
    // one lands, with the toolbar reporting that a fetch is in flight.
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    // A 403 is an answer, not a fault. Retrying it three times only delays the
    // upgrade path the reader needs to see.
    retry: (failureCount, error) => statusOf(error) !== 403 && failureCount < 2,
  });

  const stats = useQuery({
    queryKey: statsKey,
    queryFn: () =>
      getLeadStats(botId, days ?? undefined, from ?? undefined, to ?? undefined),
    staleTime: 60_000,
    retry: (failureCount, error) => statusOf(error) !== 403 && failureCount < 2,
  });

  const listError = (list.error as Error | null) ?? null;
  const locked = statusOf(listError) === 403;

  /**
   * Session ids already marked in this mount.
   *
   * The call has to fire even when the lead is not in the cached page — a
   * deep-linked `?lead=…` opens a drawer for a row on some other page, and that
   * lead is exactly the one whose unread badge is wrong. So the guard is "have
   * we asked for this id", not "is it on screen"; the endpoint is idempotent
   * either way.
   */
  const marked = useRef(new Set<string>());

  /**
   * Clearing an unread flag is optimistic and fire-and-forget: the badge has
   * already gone, the write is idempotent, and a failure costs the user nothing
   * they would notice. It patches the cached page rather than invalidating it,
   * so opening a lead does not refetch the table underneath.
   */
  const markRead = useCallback(
    (sessionId: string) => {
      if (marked.current.has(sessionId)) return;
      marked.current.add(sessionId);

      const cached = queryClient.getQueryData<LeadsResult>(listKey);
      if (cached?.leads?.some((lead) => lead.session_id === sessionId && lead.unread)) {
        queryClient.setQueryData<LeadsResult>(listKey, {
          ...cached,
          leads: cached.leads.map((lead) =>
            lead.session_id === sessionId ? { ...lead, unread: false } : lead,
          ),
        });
        queryClient.setQueryData<Record<string, unknown> | undefined>(
          statsKey,
          (previous) =>
            previous
              ? { ...previous, unread: Math.max(Number(previous.unread ?? 0) - 1, 0) }
              : previous,
        );
      }
      void markLeadViewed(sessionId).catch(() => undefined);
    },
    [listKey, statsKey, queryClient],
  );

  const markAll = useMutation({
    mutationFn: () => markAllLeadsViewed(botId),
    // One invalidation for the whole subtree: the list pages and the summary
    // both hang off `['leads', …]`, and the unread count moved in both.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['leads'] }),
  });

  const total = list.data?.total ?? 0;

  return {
    leads: list.data?.leads ?? [],
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / LEADS_PAGE_SIZE)),
    stats: stats.data ? readLeadStats(stats.data) : null,
    loading: list.isPending,
    fetching: list.isFetching && !list.isPending,
    error: locked ? null : listError,
    locked,
    retry: () => {
      void list.refetch();
      void stats.refetch();
    },
    markRead,
    // Surfaced as a promise so the confirmation dialog can hold itself open
    // until the server has answered, and show the failure in place.
    markAllRead: () => markAll.mutateAsync(),
  };
}
