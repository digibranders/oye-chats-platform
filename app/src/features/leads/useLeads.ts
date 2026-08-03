/**
 * useLeads - loads the lead list and tier summary for the currently-selected
 * agent, in one place.
 *
 * Loading is *derived* from a status enum rather than a standalone boolean, and
 * every network write happens inside an async callback (never synchronously in
 * the effect body) with a cancellation guard so a fast agent-switch can't land
 * stale data. The page consumes `{ status, ... }` and renders the matching
 * skeleton / empty / error / ready surface.
 */
import { useCallback, useEffect, useState } from 'react';
import { getLeads, getLeadStats } from '../../services/api';
import { type Lead } from '../../types/domain';
import { type LeadStatsSummary, readLeadStats } from './leadModel';

export type LoadStatus = 'loading' | 'ready' | 'error';

export interface LeadsData {
  status: LoadStatus;
  leads: Lead[];
  stats: LeadStatsSummary | null;
  error: string | null;
  /** Re-fetch everything for the current agent. */
  reload: () => void;
  /** Optimistically clear a single lead's unread flag (drawer open). */
  markViewedLocal: (sessionId: string) => void;
  /** Optimistically clear every unread flag ("mark all as read"). */
  markAllReadLocal: () => void;
}

/** Pull a generous page so the client-side filters have real data to work on. */
const LEADS_PAGE_LIMIT = 200;

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong while loading your leads.';
}

/**
 * @param botId The selected agent's id (or `undefined` while agents are still loading).
 * @param enabled When `false`, the fetch never fires - used to keep Free-plan
 *   workspaces from hitting the gated `/leads` endpoint (which 403s for Free)
 *   when the page renders its upgrade teaser instead of the real list.
 *   Defaults to `true` so existing callers are unaffected.
 */
export function useLeads(botId: number | undefined, enabled = true): LeadsData {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stats, setStats] = useState<LeadStatsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by reload() to re-trigger the effect without duplicating fetch logic. */
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((n) => n + 1), []);

  const markViewedLocal = useCallback((sessionId: string) => {
    setLeads((prev) =>
      prev.map((lead) => (lead.session_id === sessionId ? { ...lead, unread: false } : lead)),
    );
    setStats((prev) =>
      prev ? { ...prev, unread: Math.max(prev.unread - 1, 0) } : prev,
    );
  }, []);

  const markAllReadLocal = useCallback(() => {
    setLeads((prev) => prev.map((lead) => ({ ...lead, unread: false })));
    setStats((prev) => (prev ? { ...prev, unread: 0 } : prev));
  }, []);

  useEffect(() => {
    // Skip entirely rather than fetching and discarding the result - the
    // caller (Free-plan gating) needs this to never issue the network call.
    if (!enabled) return;

    let cancelled = false;

    async function load(): Promise<void> {
      setStatus('loading');
      setError(null);
      try {
        const [leadsResult, statsRaw] = await Promise.all([
          getLeads(botId, { limit: LEADS_PAGE_LIMIT }),
          getLeadStats(botId),
        ]);
        if (cancelled) return;
        setLeads(leadsResult.leads ?? []);
        setStats(readLeadStats(statsRaw));
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setError(messageOf(err));
        setStatus('error');
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [botId, reloadToken, enabled]);

  return {
    status,
    leads,
    stats,
    error,
    reload,
    markViewedLocal,
    markAllReadLocal,
  };
}
