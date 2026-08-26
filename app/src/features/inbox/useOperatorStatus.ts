import { useCallback, useEffect, useRef, useState } from 'react';
import { getMyOperatorStatus, toggleOperatorStatus } from '../../services/api';
import { t as translateNow } from '../../i18n/i18n';

export interface OperatorStatusState {
  /** True when this operator is accepting live chats. */
  isOnline: boolean;
  /** True while the initial status is loading. */
  loading: boolean;
  /** True while a toggle request is in flight. */
  saving: boolean;
  /** Set when the caller is not an operator in this workspace / status is unavailable. */
  unavailable: boolean;
  /** Human-readable message when the last toggle failed; null otherwise. */
  error: string | null;
  /** Flip availability; no-op while a toggle is already in flight. */
  toggle: () => Promise<void>;
  /** Re-read the current status (e.g. after adding oneself as an operator). */
  refresh: () => Promise<void>;
}

/**
 * useOperatorStatus - reads and flips the current user's live-chat availability
 * for the active bot. When the user isn't an operator, the backend returns null;
 * we surface that as `unavailable` so the UI can explain rather than mislead.
 */
export function useOperatorStatus(botId: number | undefined): OperatorStatusState {
  const [isOnline, setIsOnline] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const token = (tokenRef.current += 1);
    setLoading(true);
    try {
      const status = await getMyOperatorStatus(botId != null ? { botId } : undefined);
      if (token !== tokenRef.current) return;
      if (status && status.operator_id != null) {
        setIsOnline(Boolean(status.is_online));
        setUnavailable(false);
      } else {
        setIsOnline(false);
        setUnavailable(true);
      }
    } catch {
      if (token !== tokenRef.current) return;
      setIsOnline(false);
      setUnavailable(true);
    } finally {
      if (token === tokenRef.current) setLoading(false);
    }
  }, [botId]);

  useEffect(() => {
    void load();
    const onFocus = (): void => {
      void load();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const toggle = useCallback(async (): Promise<void> => {
    if (saving || unavailable) return;
    const next = !isOnline;
    setSaving(true);
    setError(null);
    try {
      await toggleOperatorStatus({ isOnline: next, ...(botId != null ? { botId } : {}) });
      setIsOnline(next);
    } catch (err) {
      // Surface the failure instead of silently swallowing it: the operator must
      // know their availability change didn't save.
      setError(
        err instanceof Error
          ? (translateNow('inbox.couldntUpdateYourAvailabilityDetail', { reason: err.message }) || `Couldn’t update your availability: ${err.message}`)
          : translateNow('inbox.couldntUpdateYourAvailabilityPlease') || 'Couldn’t update your availability. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  }, [saving, unavailable, isOnline, botId]);

  return { isOnline, loading, saving, unavailable, error, toggle, refresh: load };
}
