import { useCallback, useEffect, useRef, useState } from 'react';
import { getMyOperatorStatus, toggleOperatorStatus } from '../../services/api';

export interface OperatorStatusState {
  /** True when this operator is accepting live chats. */
  isOnline: boolean;
  /** True while the initial status is loading. */
  loading: boolean;
  /** True while a toggle request is in flight. */
  saving: boolean;
  /** Set when the caller is not an operator in this workspace / status is unavailable. */
  unavailable: boolean;
  /** Flip availability; no-op while a toggle is already in flight. */
  toggle: () => Promise<void>;
}

/**
 * useOperatorStatus — reads and flips the current user's live-chat availability
 * for the active bot. When the user isn't an operator, the backend returns null;
 * we surface that as `unavailable` so the UI can explain rather than mislead.
 */
export function useOperatorStatus(botId: number | undefined): OperatorStatusState {
  const [isOnline, setIsOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const tokenRef = useRef(0);

  useEffect(() => {
    const token = (tokenRef.current += 1);
    let active = true;

    async function load(): Promise<void> {
      setLoading(true);
      try {
        const status = await getMyOperatorStatus(botId != null ? { botId } : undefined);
        if (!active || token !== tokenRef.current) return;
        if (status) {
          setIsOnline(Boolean(status.is_online));
          setUnavailable(false);
        } else {
          setUnavailable(true);
        }
      } catch {
        if (!active || token !== tokenRef.current) return;
        setUnavailable(true);
      } finally {
        if (active && token === tokenRef.current) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [botId]);

  const toggle = useCallback(async (): Promise<void> => {
    if (saving || unavailable) return;
    const next = !isOnline;
    setSaving(true);
    try {
      await toggleOperatorStatus({ isOnline: next, ...(botId != null ? { botId } : {}) });
      setIsOnline(next);
    } finally {
      setSaving(false);
    }
  }, [saving, unavailable, isOnline, botId]);

  return { isOnline, loading, saving, unavailable, toggle };
}
