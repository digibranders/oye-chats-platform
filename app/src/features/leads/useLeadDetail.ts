/**
 * useLeadDetail - loads the full record for a single lead when the detail
 * drawer opens, keyed by session id. Passing `null` closes the fetch down.
 *
 * Same discipline as {@link useLeads}: loading is derived from a status enum,
 * fetches run inside a guarded async callback, and a session-switch cancels the
 * in-flight request so the drawer never shows the previous lead's data.
 */
import { useEffect, useState } from 'react';
import { getLeadDetail } from '../../services/api';
import { type ChatMessage, type Lead } from '../../types/domain';
import { type LoadStatus } from './useLeads';

/** The lead record plus its conversation transcript. */
export type LeadDetail = Lead & { messages?: ChatMessage[] };

export interface LeadDetailData {
  status: LoadStatus | 'idle';
  detail: LeadDetail | null;
  error: string | null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Could not load this lead. Please try again.';
}

export function useLeadDetail(sessionId: string | null): LeadDetailData {
  const [status, setStatus] = useState<LoadStatus | 'idle'>(
    sessionId === null ? 'idle' : 'loading',
  );
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trackedId, setTrackedId] = useState<string | null>(sessionId);

  // Reset when the session changes - adjust state during render (React-approved),
  // keeping the effect free of synchronous setState.
  if (sessionId !== trackedId) {
    setTrackedId(sessionId);
    setStatus(sessionId === null ? 'idle' : 'loading');
    setDetail(null);
    setError(null);
  }

  useEffect(() => {
    if (sessionId === null) return;

    let cancelled = false;

    void (async () => {
      try {
        const result = await getLeadDetail(sessionId);
        if (cancelled) return;
        setDetail(result);
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setError(messageOf(err));
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return { status, detail, error };
}
