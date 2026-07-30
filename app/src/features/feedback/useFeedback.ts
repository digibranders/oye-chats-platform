import { useCallback, useEffect, useState } from 'react';
import { getFeedbackData } from '../../services/api';
import { type FeedbackItem } from './types';

export interface UseFeedbackResult {
  items: FeedbackItem[];
  loading: boolean;
  error: string | null;
  /** Re-run the fetch. Safe to wire to a "Try again" button. */
  refresh: () => void;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message) return cause.message;
  return 'Failed to load feedback data.';
}

/**
 * useFeedback - loads the itemized thumbs-up/down feedback log for either the
 * whole workspace (`agentId` omitted) or a single agent (`agentId` provided,
 * matching the URL-scoped agent's string route param). Filtering/bucketing
 * happens entirely client-side (see `feedback-helpers.ts`) - the endpoint has
 * no pagination or server-side filters.
 */
export function useFeedback(agentId?: string): UseFeedbackResult {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let active = true;
    const numericAgentId = agentId !== undefined ? Number(agentId) : undefined;
    const validAgentId =
      numericAgentId !== undefined && Number.isFinite(numericAgentId) ? numericAgentId : undefined;

    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getFeedbackData(validAgentId);
        if (!active) return;
        setItems(data);
      } catch (cause) {
        if (!active) return;
        setItems([]);
        setError(errorMessage(cause));
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [agentId, reloadToken]);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  return { items, loading, error, refresh };
}
