/**
 * useLeads — loads the lead list, tier summary, and qualification funnel for
 * the currently-selected agent, in one place.
 *
 * Loading is *derived* from a status enum rather than a standalone boolean, and
 * every network write happens inside an async callback (never synchronously in
 * the effect body) with a cancellation guard so a fast agent-switch can't land
 * stale data. The page consumes `{ status, ... }` and renders the matching
 * skeleton / empty / error / ready surface.
 */
import { useCallback, useEffect, useState } from 'react';
import { getLeads, getLeadStats, getQualificationFunnel } from '../../services/api';
import { type Lead } from '../../types/domain';
import {
  type FunnelStageView,
  type LeadStatsSummary,
  readFunnel,
  readLeadStats,
} from './leadModel';

export type LoadStatus = 'loading' | 'ready' | 'error';

export interface LeadsData {
  status: LoadStatus;
  leads: Lead[];
  stats: LeadStatsSummary | null;
  funnel: FunnelStageView[];
  error: string | null;
  /** Re-fetch everything for the current agent. */
  reload: () => void;
  /** Optimistically clear a single lead's unread flag (drawer open). */
  markViewedLocal: (sessionId: string) => void;
  /** Optimistically clear every unread flag ("mark all as read"). */
  markAllReadLocal: () => void;
}

/** Fixed reporting window for the funnel summary; a selector is a later add. */
const FUNNEL_PERIOD = '30d';
/** Pull a generous page so the client-side filters have real data to work on. */
const LEADS_PAGE_LIMIT = 200;

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong while loading your leads.';
}

export function useLeads(botId: number | undefined): LeadsData {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stats, setStats] = useState<LeadStatsSummary | null>(null);
  const [funnel, setFunnel] = useState<FunnelStageView[]>([]);
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
    let cancelled = false;

    async function load(): Promise<void> {
      setStatus('loading');
      setError(null);
      try {
        // The funnel is an enrichment: if it fails we still want the list, so
        // it's resolved independently and defaulted to empty on rejection.
        const [leadsResult, statsRaw, funnelRaw] = await Promise.all([
          getLeads(botId, { limit: LEADS_PAGE_LIMIT }),
          getLeadStats(botId),
          botId !== undefined
            ? getQualificationFunnel(botId, FUNNEL_PERIOD).catch(
                () => ({}) as Record<string, unknown>,
              )
            : Promise.resolve<Record<string, unknown>>({}),
        ]);
        if (cancelled) return;
        setLeads(leadsResult.leads ?? []);
        setStats(readLeadStats(statsRaw));
        setFunnel(readFunnel(funnelRaw));
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
  }, [botId, reloadToken]);

  return {
    status,
    leads,
    stats,
    funnel,
    error,
    reload,
    markViewedLocal,
    markAllReadLocal,
  };
}
