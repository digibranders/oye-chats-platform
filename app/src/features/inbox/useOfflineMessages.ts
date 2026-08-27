import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getOfflineMessages,
  updateOfflineMessage,
  deleteOfflineMessage,
} from '../../services/api';
import { type OfflineMessage } from '../../types/domain';
import { type OfflineStatus } from './inboxHelpers';
import { t as translateNow } from '../../i18n/i18n';

/** Status filter values surfaced in the toolbar. `'all'` clears the filter. */
export type StatusFilter = 'all' | OfflineStatus;

const PAGE_SIZE = 20;

export interface OfflineMessagesState {
  messages: OfflineMessage[];
  total: number;
  page: number;
  pageSize: number;
  statusFilter: StatusFilter;
  /** True while a list request is in flight. Reflects the async fetch, not derived state. */
  loading: boolean;
  /** Human-readable message when the last load failed; null otherwise. */
  error: string | null;
  setPage: (page: number) => void;
  setStatusFilter: (filter: StatusFilter) => void;
  reload: () => void;
  /** Persist a new status and reflect it locally without a full refetch. */
  updateStatus: (id: number, status: OfflineStatus) => Promise<void>;
  /** Delete a message and drop it from the local list. */
  remove: (id: number) => Promise<void>;
}

/**
 * useOfflineMessages - owns the offline-inbox data lifecycle for the active bot.
 *
 * Fetching is driven by an effect keyed on (botId, page, statusFilter); a
 * monotonic request token guards against out-of-order responses and post-unmount
 * writes, so `loading`/`error`/`messages` always reflect the newest request.
 * Mutations update local state optimistically (well, post-await) to keep the
 * selected message stable instead of refetching the whole page.
 */
export function useOfflineMessages(botId: number | undefined): OfflineMessagesState {
  const [messages, setMessages] = useState<OfflineMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPageState] = useState(1);
  const [statusFilter, setStatusFilterState] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Incremented per request; only the latest token may commit results.
  const tokenRef = useRef(0);
  // Latest values mirrored into refs so stable callbacks can read them without
  // re-subscribing on every render.
  const pageRef = useRef(page);
  pageRef.current = page;
  const countRef = useRef(0);
  countRef.current = messages.length;
  const statusFilterRef = useRef(statusFilter);
  statusFilterRef.current = statusFilter;
  // Tracks the bot the current data belongs to, so the fetch effect can reset
  // paging in-band instead of via a second effect (which caused a wasted fetch).
  const botIdRef = useRef(botId);

  const setPage = useCallback((next: number) => {
    setPageState(Math.max(1, next));
  }, []);

  const setStatusFilter = useCallback((filter: StatusFilter) => {
    // Reset to page 1: the new filter's result set may have fewer pages.
    setStatusFilterState(filter);
    setPageState(1);
  }, []);

  const reload = useCallback(() => {
    setReloadNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    // Reset paging in-band when the active bot changes so we never land on a page
    // that doesn't exist for the newly-selected bot. Doing it here (rather than in
    // a separate effect) avoids a throwaway fetch of the old page before page 1.
    if (botId !== botIdRef.current) {
      botIdRef.current = botId;
      if (page !== 1) {
        setPageState(1);
        return; // the page reset re-runs this effect with page === 1
      }
    }

    const token = (tokenRef.current += 1);
    let active = true;

    async function load(): Promise<void> {
      setLoading(true);
      setError(null);
      try {
        const params: Record<string, unknown> = { page, limit: PAGE_SIZE };
        if (statusFilter !== 'all') params.status = statusFilter;
        if (botId != null) params.bot_id = botId;
        const data = await getOfflineMessages(params);
        if (!active || token !== tokenRef.current) return;
        setMessages(data.messages ?? []);
        setTotal(data.total ?? 0);
      } catch (err) {
        if (!active || token !== tokenRef.current) return;
        setMessages([]);
        setTotal(0);
        setError(err instanceof Error ? err.message : translateNow('inbox.couldNotLoadYourMessages') || 'Could not load your messages.');
      } finally {
        if (active && token === tokenRef.current) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [botId, page, statusFilter, reloadNonce]);

  const updateStatus = useCallback(async (id: number, status: OfflineStatus): Promise<void> => {
    await updateOfflineMessage(id, { status });
    const filter = statusFilterRef.current;
    if (filter !== 'all' && filter !== status) {
      // The new status no longer matches the active filter - drop the row (and its
      // count) so the filtered list stays honest instead of showing a stale item.
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setTotal((prev) => Math.max(0, prev - 1));
    } else {
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, status } : m)));
    }
  }, []);

  const remove = useCallback(
    async (id: number): Promise<void> => {
      await deleteOfflineMessage(id);
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setTotal((prev) => Math.max(0, prev - 1));
      if (countRef.current <= 1 && pageRef.current > 1) {
        // We just removed the last row on a later page - step back a page so the
        // operator isn't stranded on an empty list while earlier pages hold items.
        // The page change re-keys the fetch effect, which reloads for us.
        setPageState((p) => Math.max(1, p - 1));
      } else {
        // Backfill the current page from the server (pull the next page's first
        // row up) so pagination stays consistent with the decremented total.
        reload();
      }
    },
    [reload],
  );

  return {
    messages,
    total,
    page,
    pageSize: PAGE_SIZE,
    statusFilter,
    loading,
    error,
    setPage,
    setStatusFilter,
    reload,
    updateStatus,
    remove,
  };
}
